#!/usr/bin/env bash
set -euo pipefail

service_port="${PORT:?PORT is required}"
export DYNAMODB_PORT=$((service_port + 18000))
export MINIO_API_PORT=$((service_port + 16000))
export MINIO_CONSOLE_PORT=$((service_port + 17000))
export COMPOSE_PROJECT_NAME="hot-updater-hono-dynamodb-${service_port}"
export MINIO_ROOT_USER=minioadmin
export MINIO_ROOT_PASSWORD=minioadmin
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=minioadmin
export AWS_SECRET_ACCESS_KEY=minioadmin
export AWS_DYNAMODB_ENDPOINT="http://127.0.0.1:${DYNAMODB_PORT}"
export AWS_DYNAMODB_TABLE_NAME="hot-updater-e2e-${service_port}"
export AWS_S3_ENDPOINT="http://127.0.0.1:${MINIO_API_PORT}"
export AWS_S3_METADATA_BUCKET="hot-updater-e2e-${service_port}"
export AWS_S3_BUCKET_NAME="${AWS_S3_METADATA_BUCKET}"

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --remove-orphans

for attempt in $(seq 1 60); do
  if aws --endpoint-url "${AWS_DYNAMODB_ENDPOINT}" dynamodb list-tables >/dev/null 2>&1; then
    echo "dynamodb-ready endpoint=${AWS_DYNAMODB_ENDPOINT} attempt=${attempt}"
    break
  fi
  if [[ "${attempt}" = "60" ]]; then
    echo "dynamodb-not-ready endpoint=${AWS_DYNAMODB_ENDPOINT}" >&2
    exit 1
  fi
  sleep 1
done

if ! aws --endpoint-url "${AWS_DYNAMODB_ENDPOINT}" dynamodb describe-table --table-name "${AWS_DYNAMODB_TABLE_NAME}" >/dev/null 2>&1; then
  aws --endpoint-url "${AWS_DYNAMODB_ENDPOINT}" dynamodb create-table \
    --table-name "${AWS_DYNAMODB_TABLE_NAME}" \
    --billing-mode PAY_PER_REQUEST \
    --attribute-definitions \
      AttributeName=pk,AttributeType=S \
      AttributeName=sk,AttributeType=S \
      AttributeName=gsi1pk,AttributeType=S \
      AttributeName=gsi1sk,AttributeType=S \
    --key-schema \
      AttributeName=pk,KeyType=HASH \
      AttributeName=sk,KeyType=RANGE \
    --global-secondary-indexes '[{"IndexName":"hot-updater-update-index","KeySchema":[{"AttributeName":"gsi1pk","KeyType":"HASH"},{"AttributeName":"gsi1sk","KeyType":"RANGE"}],"Projection":{"ProjectionType":"ALL"}}]' >/dev/null
  aws --endpoint-url "${AWS_DYNAMODB_ENDPOINT}" dynamodb wait table-exists --table-name "${AWS_DYNAMODB_TABLE_NAME}"
fi

for attempt in $(seq 1 60); do
  if curl -fsS "${AWS_S3_ENDPOINT}/minio/health/ready" >/dev/null; then
    echo "minio-ready endpoint=${AWS_S3_ENDPOINT} attempt=${attempt}"
    break
  fi
  if [[ "${attempt}" = "60" ]]; then
    echo "minio-not-ready endpoint=${AWS_S3_ENDPOINT}" >&2
    exit 1
  fi
  sleep 1
done

if ! aws --endpoint-url "${AWS_S3_ENDPOINT}" s3api head-bucket --bucket "${AWS_S3_METADATA_BUCKET}" >/dev/null 2>&1; then
  aws --endpoint-url "${AWS_S3_ENDPOINT}" s3api create-bucket --bucket "${AWS_S3_METADATA_BUCKET}" --region "${AWS_REGION}" >/dev/null
fi

pnpm e2e:bootstrap-api-key
exec ./node_modules/.bin/tsx src/index.ts
