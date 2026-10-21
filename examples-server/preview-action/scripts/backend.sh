#!/usr/bin/env bash
# Starts the proof's backend, Postgres and MinIO, in Docker, and creates the
# bucket. Prints the backend's variables as NAME=value lines.
#
#   bash scripts/backend.sh [name-prefix]
set -euo pipefail

prefix="${1:-preview-action}"
pg_port="${PREVIEW_PG_PORT:-15433}"
minio_port="${PREVIEW_MINIO_PORT:-19033}"
pg_password="preview-postgres"
minio_user="preview"
minio_password="preview-minio-secret"
bucket="preview-bundles"

docker rm -f "$prefix-pg" "$prefix-minio" >/dev/null 2>&1 || true
docker run -d --name "$prefix-pg" -p "127.0.0.1:$pg_port:5432" \
  -e POSTGRES_PASSWORD="$pg_password" postgres:16-alpine >/dev/null
# MinIO no longer publishes images: Silo is the maintained fork the other
# example servers use, with the same MINIO_* variables and routes.
docker run -d --name "$prefix-minio" -p "127.0.0.1:$minio_port:9000" \
  -e MINIO_ROOT_USER="$minio_user" -e MINIO_ROOT_PASSWORD="$minio_password" \
  pgsty/silo:RELEASE.2026-09-16T00-00-00Z server /data >/dev/null

for _ in $(seq 60); do
  if docker exec "$prefix-pg" pg_isready -U postgres >/dev/null 2>&1 &&
    curl -fs "http://127.0.0.1:$minio_port/minio/health/ready" >/dev/null; then
    break
  fi
  sleep 1
done
docker exec "$prefix-pg" pg_isready -U postgres >/dev/null
curl -fs "http://127.0.0.1:$minio_port/minio/health/ready" >/dev/null

cat <<VARS
HOT_UPDATER_DATABASE_URL=postgres://postgres:$pg_password@127.0.0.1:$pg_port/postgres
HOT_UPDATER_S3_ENDPOINT=http://127.0.0.1:$minio_port
HOT_UPDATER_S3_REGION=us-east-1
HOT_UPDATER_S3_BUCKET_NAME=$bucket
HOT_UPDATER_S3_ACCESS_KEY_ID=$minio_user
HOT_UPDATER_S3_SECRET_ACCESS_KEY=$minio_password
VARS
