/**
 * job-runner — drains the research_jobs queue.
 *
 * Lifecycle of one Job execution (see main.ts):
 *   1. reclaimStaleRunning() — reset orphaned `running` rows (the previous
 *      Job process died mid-call) back to `queued`. Self-heal, no scheduler.
 *   2. drainQueue() — a fixed pool of N workers, each looping
 *      claim → process → claim … until claimNextJob() returns null for
 *      everyone. Then the execution exits.
 *
 * Concurrency: Perplexity Tier 0 is ~5 rpm, but deep-research latency is
 * minutes — concurrency, not request rate, is the real throttle. We cap
 * at RESEARCH_MAX_CONCURRENCY parallel provider calls. claimNextJob()
 * uses SELECT … FOR UPDATE SKIP LOCKED so the pool can't double-claim.
 *
 * Failure handling lives entirely inside one execution: a failed job is
 * re-queued with exponential backoff for attempts < MAX_ATTEMPTS, then
 * marked `failed` permanently (surfaces in gub-admin for manual re-run).
 * No periodic retry infra — a human is in the loop for permanent failures.
 */
import { prisma } from './prisma';
import { config } from './config';
import type { DossierProvider, StaffContext } from './types';
import {
  PerplexityAgentProvider,
  ProviderTimeoutError,
} from './providers/perplexity-agent.provider';

/** Registry of supported providers. New providers are added here. */
const PROVIDER_FACTORIES: Record<string, () => DossierProvider> = {
  perplexity_agent: () =>
    new PerplexityAgentProvider(
      config.PERPLEXITY_API_KEY,
      config.RESEARCH_CALL_TIMEOUT_S * 1000,
    ),
};

/** Exponential backoff: 1m, 2m, 4m, ... capped at 30m. */
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 3;

export interface DrainSummary {
  reclaimed: number;
  completed: number;
  failed: number;
  retriedLater: number;
}

/**
 * Reset `running` rows older than RESEARCH_STALE_RUNNING_S to `queued`.
 * Runs once at the start of every Job execution. The threshold must be
 * larger than the per-call timeout so we don't reclaim a row that's
 * legitimately still being worked by a concurrent worker in THIS run —
 * but those rows are row-locked by the active transaction anyway, so the
 * UPDATE simply skips them. The age guard is belt-and-suspenders.
 */
export async function reclaimStaleRunning(): Promise<number> {
  const cutoff = new Date(Date.now() - config.RESEARCH_STALE_RUNNING_S * 1000);
  const res = await prisma.researchJob.updateMany({
    where: { status: 'running', startedAt: { lt: cutoff } },
    data: { status: 'queued', error: 'reclaimed: stale running (worker died mid-call)' },
  });
  return res.count;
}

export async function drainQueue(): Promise<DrainSummary> {
  const reclaimed = await reclaimStaleRunning();
  const summary: DrainSummary = { reclaimed, completed: 0, failed: 0, retriedLater: 0 };

  const worker = async (): Promise<void> => {
    // Loop until the queue has no eligible row for THIS worker.
    for (;;) {
      const result = await processOne();
      if (result.kind === 'idle') return;
      if (result.kind === 'completed') summary.completed += 1;
      else if (result.willRetry) summary.retriedLater += 1;
      else summary.failed += 1;
    }
  };

  const pool = Array.from({ length: config.RESEARCH_MAX_CONCURRENCY }, () => worker());
  await Promise.all(pool);
  return summary;
}

type ProcessResult =
  | { kind: 'idle' }
  | { kind: 'completed'; jobId: string; dossierId: string; staffId: string }
  | { kind: 'failed'; jobId: string; error: string; willRetry: boolean };

async function processOne(): Promise<ProcessResult> {
  const claimedJob = await claimNextJob();
  if (!claimedJob) return { kind: 'idle' };

  const factory = PROVIDER_FACTORIES[claimedJob.provider];
  if (!factory) {
    return failJob(claimedJob.id, `unknown provider: ${claimedJob.provider}`, false);
  }

  let provider: DossierProvider;
  try {
    provider = factory();
  } catch (e) {
    // Construction failure (e.g. missing env var) — not retryable.
    return failJob(claimedJob.id, `provider construct failed: ${(e as Error).message}`, false);
  }

  // Build staff context at run-time (not cached on the job row) so team /
  // external-ID changes between enqueue and run don't invalidate the job.
  let ctx: StaffContext;
  try {
    ctx = await buildStaffContext(claimedJob.staffId);
  } catch (e) {
    // Staff might have been deleted between enqueue and run.
    return failJob(claimedJob.id, `staff context build failed: ${(e as Error).message}`, false);
  }

  let dossier;
  try {
    dossier = await provider.generate(ctx, {
      preset: claimedJob.preset,
      promptTemplateVersion: claimedJob.promptTemplateVersion,
    });
  } catch (e) {
    const err = e as Error;
    const isTimeout = err instanceof ProviderTimeoutError;
    const willRetry = claimedJob.attempts < MAX_ATTEMPTS;
    return failJob(
      claimedJob.id,
      isTimeout ? `timeout: ${err.message}` : err.message,
      willRetry,
    );
  }

  // Persist dossier + flip job to completed in one transaction so a
  // partial write can't strand the job in `running`.
  const upserted = await prisma.$transaction(async (tx) => {
    const row = await tx.staffResearchDossier.upsert({
      where: {
        staffId_provider_preset_promptTemplateVersion: {
          staffId: claimedJob.staffId,
          provider: claimedJob.provider,
          preset: claimedJob.preset,
          promptTemplateVersion: claimedJob.promptTemplateVersion,
        },
      },
      create: {
        staffId: claimedJob.staffId,
        provider: claimedJob.provider,
        preset: claimedJob.preset,
        promptTemplateVersion: claimedJob.promptTemplateVersion,
        contentMarkdown: dossier.contentMarkdown,
        citations: dossier.citations,
        searchResults: dossier.searchResults,
        usageMetadata: dossier.usageMetadata,
        confidence: dossier.confidence,
      },
      update: {
        contentMarkdown: dossier.contentMarkdown,
        citations: dossier.citations,
        searchResults: dossier.searchResults,
        usageMetadata: dossier.usageMetadata,
        confidence: dossier.confidence,
        generatedAt: new Date(),
      },
    });
    await tx.researchJob.update({
      where: { id: claimedJob.id },
      data: {
        status: 'completed',
        completedAt: new Date(),
        resultDossierId: row.id,
        error: null,
      },
    });
    return row;
  });

  return {
    kind: 'completed',
    jobId: claimedJob.id,
    dossierId: upserted.id,
    staffId: claimedJob.staffId,
  };
}

/**
 * Claim atomically via SELECT … FOR UPDATE SKIP LOCKED — lets the worker
 * pool race for jobs without locking each other out. Prisma doesn't
 * expose SKIP LOCKED, so this drops to raw SQL inside the same
 * transaction that flips the status.
 */
async function claimNextJob() {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM research_jobs
      WHERE status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    if (rows.length === 0) return null;
    const jobId = rows[0]!.id;
    return tx.researchJob.update({
      where: { id: jobId },
      data: {
        status: 'running',
        attempts: { increment: 1 },
        startedAt: new Date(),
      },
    });
  });
}

async function buildStaffContext(staffId: string): Promise<StaffContext> {
  const staff = await prisma.staff.findUniqueOrThrow({
    where: { id: staffId },
    select: {
      id: true,
      fullName: true,
      email: true,
      title: true,
      department: true,
    },
  });
  const [teamMemberships, externalIds] = await Promise.all([
    prisma.teamMember.findMany({
      where: { staffId },
      include: { team: { select: { name: true } } },
    }),
    prisma.staffExternalId.findMany({
      where: { staffId },
      select: { system: true, externalId: true },
    }),
  ]);
  return {
    staffId: staff.id,
    fullName: staff.fullName,
    email: staff.email,
    title: staff.title,
    department: staff.department,
    teamNames: teamMemberships
      .map((m) => m.team.name)
      .filter((n): n is string => Boolean(n)),
    externalIds: externalIds.map((e) => ({ system: e.system, externalId: e.externalId })),
  };
}

async function failJob(
  jobId: string,
  error: string,
  willRetry: boolean,
): Promise<ProcessResult> {
  if (willRetry) {
    const job = await prisma.researchJob.findUniqueOrThrow({ where: { id: jobId } });
    // Exponential, capped. attempts was incremented by the claim step,
    // so attempts=1 → 1m, attempts=2 → 2m, attempts=3 → 4m.
    const backoffMs = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, Math.max(0, job.attempts - 1)),
      BACKOFF_MAX_MS,
    );
    await prisma.researchJob.update({
      where: { id: jobId },
      data: {
        status: 'queued',
        error,
        nextAttemptAt: new Date(Date.now() + backoffMs),
      },
    });
  } else {
    await prisma.researchJob.update({
      where: { id: jobId },
      data: { status: 'failed', error, completedAt: new Date() },
    });
  }
  return { kind: 'failed', jobId, error, willRetry };
}
