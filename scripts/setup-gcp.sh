#!/usr/bin/env bash
###############################################################################
# setup-gcp.sh  (gub-research-worker)
#
# One-time GCP provisioning for the deep-research worker Cloud Run JOB.
# Idempotent — safe to re-run; existing resources are skipped.
#
# Assumes gcp-universal-backend's setup-gcp.sh + setup-cloud-sql.sh have
# already run (they provision the shared Cloud SQL instance + the
# <env>-database-url secrets this worker copies from).
#
# Usage:
#   ./scripts/setup-gcp.sh <project-id> <region>
###############################################################################
set -euo pipefail

PROJECT_ID="${1:?Usage: $0 <project-id> <region>}"
REGION="${2:?Usage: $0 <project-id> <region>}"
AR_REPO="gub-research-worker"
REPO_OWNER="bpriddy"
REPO_NAME="gub-research-worker"
ENVS=("dev" "staging" "prod")

echo "Setting up gub-research-worker GCP resources in $PROJECT_ID / $REGION"
echo ""
gcloud config set project "$PROJECT_ID"

# ── Enable required APIs ─────────────────────────────────────────────────────
echo "→ Enabling APIs..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  sqladmin.googleapis.com

# ── Artifact Registry repository ─────────────────────────────────────────────
echo "→ Creating Artifact Registry repository: $AR_REPO..."
gcloud artifacts repositories create "$AR_REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="gub-research-worker container images" \
  2>/dev/null || echo "   (already exists, skipping)"

JOB_BIND_FAILED=0

# ── Per-environment resources ────────────────────────────────────────────────
for ENV in "${ENVS[@]}"; do
  JOB="gub-research-worker-$ENV"
  SA_NAME="sa-$JOB"
  SA_EMAIL="$SA_NAME@$PROJECT_ID.iam.gserviceaccount.com"
  # The gub-admin runtime SA for this env is what fires the Job (Sync button).
  ADMIN_SA="sa-gub-admin-$ENV@$PROJECT_ID.iam.gserviceaccount.com"

  echo ""
  echo "── Environment: $ENV ─────────────────────────────────────────────────"

  echo "→ Creating service account: $SA_NAME..."
  if gcloud iam service-accounts create "$SA_NAME" \
       --display-name="gub-research-worker $ENV runtime" \
       2>/dev/null; then
    echo "   waiting for IAM to see the new SA..."
    until gcloud iam service-accounts describe "$SA_EMAIL" >/dev/null 2>&1; do
      sleep 2
    done
  else
    echo "   (already exists, skipping)"
  fi

  echo "→ Granting runtime IAM roles to $SA_NAME..."
  for ROLE in \
    roles/secretmanager.secretAccessor \
    roles/cloudtrace.agent \
    roles/logging.logWriter \
    roles/monitoring.metricWriter \
    roles/cloudsql.client; do
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
      --member="serviceAccount:$SA_EMAIL" \
      --role="$ROLE" \
      --quiet
  done

  echo "→ Creating Secret Manager secrets for $ENV..."
  for SECRET in \
    "gub-research-worker-db-url-$ENV" \
    "gub-research-worker-perplexity-api-key-$ENV"; do
    gcloud secrets create "$SECRET" \
      --replication-policy=automatic \
      2>/dev/null || echo "   (secret $SECRET already exists, skipping)"
  done

  # Allow gub-admin (its runtime SA) to start THIS env's Job via the
  # Admin API. The Job resource doesn't exist until the first Cloud Build
  # deploy, so this binding fails on a fresh project — handled gracefully,
  # re-run after the first deploy. roles/run.developer includes
  # run.jobs.run; scoping it to the job (not the project) keeps it tight.
  echo "→ Binding $ADMIN_SA as run.developer on job $JOB..."
  if gcloud run jobs add-iam-policy-binding "$JOB" \
       --region="$REGION" \
       --member="serviceAccount:$ADMIN_SA" \
       --role="roles/run.developer" \
       --quiet 2>/dev/null; then
    echo "   bound."
  else
    echo "   (job $JOB does not exist yet — re-run after first deploy)"
    JOB_BIND_FAILED=1
  fi
done

# ── Cloud Build service account permissions ──────────────────────────────────
echo ""
echo "── Cloud Build permissions ───────────────────────────────────────────────"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
CB_SA="$PROJECT_NUMBER@cloudbuild.gserviceaccount.com"

echo "→ Granting Cloud Build SA permissions..."
for ROLE in \
  roles/run.admin \
  roles/iam.serviceAccountUser \
  roles/artifactregistry.writer \
  roles/secretmanager.secretAccessor \
  roles/cloudsql.client; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$CB_SA" \
    --role="$ROLE" \
    --quiet
done

# ── Cloud Build trigger ──────────────────────────────────────────────────────
# Single trigger on `main` → cloudbuild/dev.yaml, matching the established
# convention in this org (gub-admin-trigger, gub-trigger). Staging/prod
# yamls are committed for when prod exists; their triggers are added then.
echo ""
echo "── Creating Cloud Build trigger ─────────────────────────────────────────"
TRIGGER_FAILED=0
TRIGGER_NAME="gub-research-worker-trigger"
echo "→ Creating trigger: $TRIGGER_NAME (branch: ^main$, config: cloudbuild/dev.yaml)..."
if out=$(gcloud builds triggers create github \
            --name="$TRIGGER_NAME" \
            --repo-name="$REPO_NAME" \
            --repo-owner="$REPO_OWNER" \
            --branch-pattern='^main$' \
            --build-config="cloudbuild/dev.yaml" \
            --region="$REGION" 2>&1); then
  echo "   created."
elif echo "$out" | grep -qi "already exists"; then
  echo "   (already exists, skipping)"
else
  echo "   FAILED: $out"
  TRIGGER_FAILED=1
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "========================================================================="
if [ "$TRIGGER_FAILED" -eq 1 ]; then
  echo "  gub-research-worker setup PARTIALLY complete."
  echo ""
  echo "  Trigger creation failed — usually the GitHub repo isn't connected"
  echo "  to Cloud Build yet. Connect it, then RE-RUN this script. Everything"
  echo "  else is idempotent and will be skipped on the re-run."
  echo "    https://console.cloud.google.com/cloud-build/triggers/connect"
else
  echo "  gub-research-worker setup complete."
fi
echo ""
echo "  Next steps:"
echo ""
echo "  1. Connect the GitHub repo to Cloud Build if not already (browser):"
echo "     https://console.cloud.google.com/cloud-build/triggers/connect"
echo "     → select $REPO_OWNER/$REPO_NAME"
echo ""
echo "  2. Populate the secrets per env:"
echo ""
echo "     # Reuse the shared GUB DB URL"
echo "     for ENV in dev staging prod; do"
echo "       gcloud secrets versions access latest --secret=\"\${ENV}-database-url\" \\"
echo "         | gcloud secrets versions add \"gub-research-worker-db-url-\${ENV}\" --data-file=-"
echo "     done"
echo ""
echo "     # Perplexity API key (same key per env is fine for dev/staging;"
echo "     # use a separate prod key if you want cost isolation)"
echo "     printf '%s' '<perplexity-api-key>' \\"
echo "       | gcloud secrets versions add gub-research-worker-perplexity-api-key-<env> --data-file=-"
echo ""
echo "  3. Push to main to trigger the first deploy (creates the Job)."
echo ""
if [ "$JOB_BIND_FAILED" -eq 1 ]; then
  echo "  4. RE-RUN THIS SCRIPT after the first deploy — the gub-admin SA →"
  echo "     job run.developer binding can't be created until the Job exists."
  echo ""
fi
echo "========================================================================="
