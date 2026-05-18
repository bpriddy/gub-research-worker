/**
 * config.ts — env validation. Fail-fast at boot.
 *
 * The worker only needs DATABASE_URL + PERPLEXITY_API_KEY + a few tuning
 * knobs. The GCP_* vars are only consumed by the ingestion script
 * (scripts/queue-deep-research.ts) so they're optional here.
 */
import { z } from 'zod';

const EnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  PERPLEXITY_API_KEY: z.string().min(1),

  RESEARCH_CALL_TIMEOUT_S: z
    .string()
    .default('900')
    .transform(Number)
    .pipe(z.number().int().positive()),
  RESEARCH_STALE_RUNNING_S: z
    .string()
    .default('1200')
    .transform(Number)
    .pipe(z.number().int().positive()),
  RESEARCH_MAX_CONCURRENCY: z
    .string()
    .default('3')
    .transform(Number)
    .pipe(z.number().int().positive()),

  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  // Ingestion-script-only; optional for the Job runtime.
  GCP_PROJECT_ID: z.string().optional(),
  GCP_REGION: z.string().optional(),
  RESEARCH_JOB_NAME: z.string().optional(),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const errors = parsed.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    throw new Error(`Environment configuration invalid:\n${errors}`);
  }
  return parsed.data;
}

export const config = loadConfig();
