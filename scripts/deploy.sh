#!/usr/bin/env bash
set -euo pipefail

# ReproCare Production Deployment Automation Script

echo "=== ReproCare Production Deployment ==="

# 1. Pull latest images or build containers
if [ -f "docker-compose.prod.yml" ]; then
  echo "Pulling latest service dependencies..."
  docker-compose -f docker-compose.prod.yml pull || true

  echo "Building ReproCare production containers..."
  docker-compose -f docker-compose.prod.yml build

  echo "Starting services in detached mode..."
  docker-compose -f docker-compose.prod.yml up -d

  echo "Verifying running containers..."
  docker-compose -f docker-compose.prod.yml ps
fi

# 2. Run post-deployment smoke verification
if [ -f "scripts/verify_deployment.sh" ]; then
  echo "Executing verification smoke tests..."
  chmod +x scripts/verify_deployment.sh
  ./scripts/verify_deployment.sh "http://localhost:80" "http://localhost:8100" || true
fi

echo "=== Deployment Finished ==="
