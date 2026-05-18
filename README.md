# gub-research-worker

A **Cloud Run Job** (not a service) that drains the `research_jobs`
queue: it claims queued rows, calls a deep-research provider (v1:
Perplexity Agent API), and writes `staff_research_dossiers`. These
dossiers are long-form markdown profiles of staff members for the
casting tool — career, recent activity, public persona, tastes/interests
— gathered greedily from public web sources.

## Why a Cloud Run Job

- **Zero public surface.** A Job has no URL, no port, no HTTP listener.
  Nothing to scan or DDoS. The only way it starts is the Cloud Run Admin
  API (`jobs:run`), which is IAM-gated.
- **No IAP fight.** gub-admin is behind Cloud Run integrated IAP. A
  machine trigger (Cloud Scheduler, an OAuth callback, etc.) can't
  cleanly pass IAP — we learned this the hard way with gub-bot-oauth. A
  Job sidesteps it entirely: there's no door for IAP to guard.
- **Long-running.** Perplexity deep-research calls take minutes with a
  30-min+ tail. A Job's task timeout ceiling is 24h; gub-admin's Cloud
  Run *service* request timeout is 5 min — it physically can't host this.
- **Isolated.** The Perplexity API key lives only in this Job's Secret
  Manager mount — never in gub-admin, never in GUB.

## Architecture

```
enqueue (the only trigger — there is NO Cloud Scheduler)
  │
  ├── gub-admin Sync button (human, behind IAP)
  │     → enqueueResearchJobs(): INSERT research_jobs, then jobs:run
  │
  └── scripts/queue-deep-research.ts (operator/CI, ADC)
        → INSERT research_jobs, then jobs:run

gub-research-worker (Cloud Run Job)
  1. reclaimStaleRunning()  — reset orphaned `running` rows → `queued`
  2. drainQueue()           — N-worker pool, SELECT … FOR UPDATE
                              SKIP LOCKED, until the queue is empty
  3. per row: PerplexityAgentProvider.generate() → UPSERT dossier
  4. exit
```

"Enqueue is the trigger." When work is added, the worker is fired. It
drains to empty and exits. Anything enqueued while it runs is swept by
the still-running drain loop (SKIP LOCKED makes concurrent drains safe).

Schema (`research_jobs`, `staff_research_dossiers`) is owned by
`gcp-universal-backend`'s migrations. This worker reads + writes those
tables via its own Prisma client (the schema here is a full mirror — the
same pattern gub-admin uses).

## Concerns this design handles (and how, without a scheduler)

| Concern | Mechanism |
|---|---|
| Who starts the worker | The enqueue event (gub-admin Sync / script). No clock. |
| Failed jobs | In-loop exponential backoff for `attempts < 3`; then `failed` permanently, visible in gub-admin for manual re-run. |
| Jobs running too long | Per-call `AbortController` (`RESEARCH_CALL_TIMEOUT_S`, default 900s). Cloud Run `--task-timeout` is just the outer guard. |
| Orphaned `running` rows (process died) | `reclaimStaleRunning()` at every Job startup resets rows older than `RESEARCH_STALE_RUNNING_S` to `queued`. Self-heal, no resurrector. |
| Concurrency / cost | In-process worker pool capped at `RESEARCH_MAX_CONCURRENCY` (default 3). Latency, not Perplexity's ~5 rpm, is the real throttle. |

## Env

See `.env.example`. Runtime needs `DATABASE_URL` + `PERPLEXITY_API_KEY`
plus the three `RESEARCH_*` tuning knobs (all have safe defaults). The
`GCP_*` vars are only used by the ingestion script to fire the Job.

## Local dev

```bash
cp .env.example .env      # fill DATABASE_URL + PERPLEXITY_API_KEY
npm install
npm run dev               # one drain pass against the dev DB, then exits
```

Enqueue some work without the Job:

```bash
npm run queue -- --staff-ids <uuid,uuid> --preset deep-research --no-trigger
```

## CI / CD

Same convention as the other GUB repos. Single Cloud Build trigger on
`main` → `cloudbuild/dev.yaml`, deploying the Cloud Run Job
`gub-research-worker-dev`. `staging.yaml` / `prod.yaml` are committed
for when prod exists; their triggers are added then. Unlike a Service, a
Job has **no traffic/promotion step** — `jobs deploy` updates the
definition and the next `jobs:run` uses the new image.

### First-time GCP bootstrap

```bash
./scripts/setup-gcp.sh <project-id> us-central1
```

Idempotent. Creates: the Artifact Registry repo; per-env runtime SAs
(`sa-gub-research-worker-{dev,staging,prod}`) with cloudsql.client +
secretmanager.secretAccessor + log/trace/metric writer; two Secret
Manager placeholders per env (`-db-url-`, `-perplexity-api-key-`); Cloud
Build SA permissions; the `main` trigger; and (after the Job exists) a
job-scoped `roles/run.developer` binding for the matching
`sa-gub-admin-<env>` SA so the Sync button can fire it.

The script prints the remaining manual steps:

1. Connect the GitHub repo to Cloud Build (browser, one-time).
2. Populate the secrets:
   ```bash
   for ENV in dev staging prod; do
     gcloud secrets versions access latest --secret="${ENV}-database-url" \
       | gcloud secrets versions add "gub-research-worker-db-url-${ENV}" --data-file=-
   done
   printf '%s' '<perplexity-api-key>' \
     | gcloud secrets versions add gub-research-worker-perplexity-api-key-dev --data-file=-
   ```
3. Push to `main` → first deploy creates the Job.
4. **Re-run `setup-gcp.sh`** — the gub-admin-SA→Job binding can't be
   created until the Job exists.

## Triggering manually

```bash
# Operator laptop (ADC) — fire one drain pass:
gcloud run jobs execute gub-research-worker-dev --region=us-central1

# Or enqueue + fire in one step:
npm run queue -- --staff-ids <uuid,uuid> --preset advanced-deep-research
```

## Prod implementation checklist

When a prod environment exists:

1. `./scripts/setup-gcp.sh <prod-project> us-central1` (idempotent).
2. Connect the repo to Cloud Build if new project.
3. Populate `gub-research-worker-db-url-prod` (reuse `prod-database-url`)
   and `gub-research-worker-perplexity-api-key-prod`. Consider a
   separate prod Perplexity key for cost isolation/attribution.
4. Push to `main`; first deploy creates `gub-research-worker-prod`.
5. Re-run `setup-gcp.sh` to bind `sa-gub-admin-prod` → the prod Job.
6. Confirm gub-admin's env carries `GCP_PROJECT_ID` / `GCP_REGION` /
   `RESEARCH_JOB_NAME=gub-research-worker-prod` so its Sync button fires
   the prod Job (see gub-admin's cloudbuild).
7. Verify end-to-end: enqueue 3 known staff, watch the Job execution in
   Cloud Run job history, confirm `staff_research_dossiers` rows land
   with non-empty `content_markdown` and a parsed `confidence`.

## What stays in GUB / gub-admin

| Thing | Where | Why |
|---|---|---|
| `research_jobs` / `staff_research_dossiers` migrations | gcp-universal-backend | GUB owns the schema |
| `data_sources` row + Sync button + enqueue + Job trigger | gub-admin | Human-facing, behind IAP (correct) |
| `/api/research-jobs/[staffId]` read view | gub-admin | Admin UI reads dossier/job status |
| Provider, prompt, drain loop, the Perplexity key | **here** | Machine-triggered, zero surface, long-running |
