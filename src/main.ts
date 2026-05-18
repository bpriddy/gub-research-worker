/**
 * main.ts — Cloud Run Job entrypoint.
 *
 * One execution: validate env (config import throws on bad env),
 * drain the queue to empty, disconnect, exit. Cloud Run Jobs treat a
 * zero exit code as success; any throw → non-zero → the execution is
 * marked failed in Cloud Run's job history (visible without any extra
 * monitoring surface).
 *
 * There is no HTTP server, no port, no scheduler. The Job is started by
 * gub-admin's Sync handler or the ingestion script via the Cloud Run
 * Admin API.
 */
import { config } from './config';
import { prisma } from './prisma';
import { drainQueue } from './job-runner';

async function main(): Promise<void> {
  const startedAt = Date.now();
  console.log(
    JSON.stringify({
      msg: 'gub-research-worker starting',
      env: config.NODE_ENV,
      maxConcurrency: config.RESEARCH_MAX_CONCURRENCY,
      callTimeoutS: config.RESEARCH_CALL_TIMEOUT_S,
    }),
  );

  const summary = await drainQueue();

  console.log(
    JSON.stringify({
      msg: 'gub-research-worker drain complete',
      ...summary,
      durationMs: Date.now() - startedAt,
    }),
  );
}

main()
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(
      JSON.stringify({
        msg: 'gub-research-worker fatal',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
