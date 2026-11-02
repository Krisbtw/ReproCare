#!/usr/bin/env bash
set -euo pipefail

# ReproCare Production Deployment Automation Script
# Supports Docker Compose v2 (`docker compose`) and legacy v1 (`docker-compose`).

if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD=(docker-compose)
else
  echo "Error: Neither 'docker compose' nor 'docker-compose' is installed." >&2
  exit 1
fi

echo "=== ReproCare Production Deployment ==="

if [ -f "docker-compose.prod.yml" ]; then
  echo "1. Validating docker-compose.prod.yml configuration..."
  "${COMPOSE_CMD[@]}" -f docker-compose.prod.yml config -q

  echo "2. Pulling base images..."
  "${COMPOSE_CMD[@]}" -f docker-compose.prod.yml pull db prometheus grafana || true

  echo "3. Building production web and imaging-service images..."
  "${COMPOSE_CMD[@]}" -f docker-compose.prod.yml build

  echo "4. Starting PostgreSQL and running release database migrations (advisory-locked)..."
  "${COMPOSE_CMD[@]}" -f docker-compose.prod.yml up -d db
  "${COMPOSE_CMD[@]}" -f docker-compose.prod.yml run --rm migrate

  echo "5. Starting production services in detached mode..."
  "${COMPOSE_CMD[@]}" -f docker-compose.prod.yml up -d

  echo "6. Verifying running containers..."
  "${COMPOSE_CMD[@]}" -f docker-compose.prod.yml ps
fi

if [ -f "scripts/verify_deployment.sh" ]; then
  echo "7. Executing post-deployment smoke verification..."
  chmod +x scripts/verify_deployment.sh
  ./scripts/verify_deployment.sh "${DEPLOY_VERIFY_WEB_URL:-http://localhost:80}" "${DEPLOY_VERIFY_IMAGING_URL:-http://localhost:8100}"
fi

echo "=== Deployment Finished ==="
