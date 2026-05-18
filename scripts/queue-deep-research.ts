/**
 * queue-deep-research.ts — bulk-enqueue dossier jobs, then fire the Job.
 *
 * Deliberately does NOT call any gub-admin HTTP endpoint. It does the two
 * primitive operations directly:
 *   1. INSERT research_jobs rows (Prisma → shared GUB DB)
 *   2. Start the Cloud Run Job via the Admin API (jobs:run)
 * Neither touches an IAP-gated surface, so the script runs fine from an
 * operator laptop or a CI step with ADC.
 *
 * Idempotent: staff with a current dossier for the (provider, preset,
 * prompt_template_version) tuple are skipped unless --force. Safe to
 * re-run after a partial run.
 *
 * Usage:
 *   npm run queue -- --staff-ids <uuid,uuid,...> [options]
 *   npm run queue -- --staff-ids-file ids.txt    [options]
 *
 * Options:
 *   --staff-ids a,b,c        Comma-separated staff UUIDs
 *   --staff-ids-file PATH    File with one staff UUID per line
 *   --preset NAME            deep-research | advanced-deep-research
 *                            (default: deep-research)
 *   --prompt-version V       default: talent-dossier-v1
 *   --force                  Re-enqueue even if a current dossier exists
 *   --dry-run                Report what would happen; write nothing
 *   --no-trigger             Insert rows but don't start the Job
 */
import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { config } from '../src/config';
import { prisma } from '../src/prisma';
import { TALENT_DOSSIER_V1_VERSION } from '../src/prompt-templates/talent-dossier-v1';

interface Args {
  staffIds: string[];
  preset: string;
  promptVersion: string;
  force: boolean;
  dryRun: boolean;
  trigger: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  let staffIds: string[] = [];
  const idsArg = get('--staff-ids');
  if (idsArg) staffIds = idsArg.split(',').map((s) => s.trim()).filter(Boolean);
  const idsFile = get('--staff-ids-file');
  if (idsFile) {
    staffIds = staffIds.concat(
      readFileSync(idsFile, 'utf-8')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }

  const preset = get('--preset') ?? 'deep-research';
  if (preset !== 'deep-research' && preset !== 'advanced-deep-research') {
    throw new Error(`--preset must be deep-research|advanced-deep-research, got '${preset}'`);
  }

  return {
    staffIds: [...new Set(staffIds)],
    preset,
    promptVersion: get('--prompt-version') ?? TALENT_DOSSIER_V1_VERSION,
    force: has('--force'),
    dryRun: has('--dry-run'),
    trigger: !has('--no-trigger'),
  };
}

async function triggerJob(): Promise<void> {
  const { GCP_PROJECT_ID, GCP_REGION, RESEARCH_JOB_NAME } = config;
  if (!GCP_PROJECT_ID || !GCP_REGION || !RESEARCH_JOB_NAME) {
    throw new Error(
      'GCP_PROJECT_ID / GCP_REGION / RESEARCH_JOB_NAME must be set to trigger the Job ' +
        '(or pass --no-trigger to skip)',
    );
  }
  const url =
    `https://run.googleapis.com/v2/projects/${GCP_PROJECT_ID}` +
    `/locations/${GCP_REGION}/jobs/${RESEARCH_JOB_NAME}:run`;
  const auth = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const client = await auth.getClient();
  await client.request({ url, method: 'POST' });
  console.log(`Triggered Cloud Run Job: ${RESEARCH_JOB_NAME}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.staffIds.length === 0) {
    throw new Error('No staff IDs. Pass --staff-ids a,b,c or --staff-ids-file PATH');
  }

  const provider = 'perplexity_agent';

  // Verify staff exist.
  const existing = await prisma.staff.findMany({
    where: { id: { in: args.staffIds } },
    select: { id: true },
  });
  const existingIds = existing.map((s) => s.id);
  const existingSet = new Set(existingIds);
  const missing = args.staffIds.filter((id) => !existingSet.has(id));

  // Dedup against current dossiers unless --force.
  let skipSet = new Set<string>();
  if (!args.force) {
    const dossiers = await prisma.staffResearchDossier.findMany({
      where: {
        staffId: { in: existingIds },
        provider,
        preset: args.preset,
        promptTemplateVersion: args.promptVersion,
      },
      select: { staffId: true },
    });
    skipSet = new Set(dossiers.map((d) => d.staffId));
  }

  const toEnqueue = existingIds.filter((id) => !skipSet.has(id));

  console.log(
    JSON.stringify({
      requested: args.staffIds.length,
      resolvable: existingIds.length,
      missing: missing.length,
      skippedExisting: skipSet.size,
      toEnqueue: toEnqueue.length,
      preset: args.preset,
      promptVersion: args.promptVersion,
      dryRun: args.dryRun,
    }),
  );
  if (missing.length > 0) {
    console.warn(`Missing staff IDs (not enqueued): ${missing.join(', ')}`);
  }

  if (args.dryRun) {
    console.log('--dry-run: nothing written, Job not triggered.');
    return;
  }

  if (toEnqueue.length === 0) {
    console.log('Nothing to enqueue.');
    return;
  }

  const res = await prisma.researchJob.createMany({
    data: toEnqueue.map((staffId) => ({
      staffId,
      provider,
      preset: args.preset,
      promptTemplateVersion: args.promptVersion,
    })),
  });
  console.log(`Enqueued ${res.count} research_jobs rows.`);

  if (args.trigger) {
    await triggerJob();
  } else {
    console.log('--no-trigger: rows enqueued, Job not started.');
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
