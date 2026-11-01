#!/usr/bin/env bash
set -euo pipefail

echo "=== ReproCare Pre/Post-Deployment Verification ==="

BASE_URL="${1:-http://localhost:8080}"
IMAGING_URL="${2:-http://localhost:8100}"

echo "1. Checking Web App Health..."
WEB_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL" || true)
if [ "$WEB_CODE" -eq 200 ] || [ "$WEB_CODE" -eq 302 ] || [ "$WEB_CODE" -eq 307 ]; then
  echo "✔ Web App responding at $BASE_URL (HTTP $WEB_CODE)"
else
  echo "⚠ Web App returned unexpected HTTP code: $WEB_CODE"
fi

echo "2. Checking Imaging Service Health..."
IMG_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$IMAGING_URL/health" || true)
if [ "$IMG_CODE" -eq 200 ]; then
  echo "✔ Imaging Service healthy at $IMAGING_URL/health (HTTP $IMG_CODE)"
else
  echo "⚠ Imaging Service returned HTTP $IMG_CODE (is the service started?)"
fi

echo "3. Testing Security Headers on Imaging Service..."
HEADER_CHECK=$(curl -s -I "$IMAGING_URL/health" | grep -i "x-content-type-options: nosniff" || true)
if [ -n "$HEADER_CHECK" ]; then
  echo "✔ Security header 'X-Content-Type-Options: nosniff' verified."
else
  echo "⚠ Security header not found on imaging service."
fi

echo "=== Verification Finished ==="

