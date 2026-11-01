#!/usr/bin/env bash
set -euo pipefail

# ReproCare Automated Backup Script
# Creates timestamped backup of PostgreSQL database and AI model weights.

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="backups/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

echo "=== ReproCare Backup: $TIMESTAMP ==="

# 1. Backup PostgreSQL database
if docker ps --format '{{.Names}}' | grep -q "reprocare.*db"; then
  DB_CONTAINER=$(docker ps --format '{{.Names}}' | grep "reprocare.*db" | head -n 1)
  echo "Dumping database from container $DB_CONTAINER..."
  docker exec "$DB_CONTAINER" pg_dump -U reprocare reprocare_db > "$BACKUP_DIR/reprocare_db_$TIMESTAMP.sql"
else
  echo "Database container not running; using local pg_dump if available..."
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump -U reprocare -d reprocare_db > "$BACKUP_DIR/reprocare_db_$TIMESTAMP.sql"
  fi
fi

# 2. Backup model weights if present
if [ -d "imaging-service/models" ]; then
  mkdir -p "$BACKUP_DIR/models"
  cp -r imaging-service/models/* "$BACKUP_DIR/models/" 2>/dev/null || true
fi

# 3. Compress backup archive
tar -czvf "backups/reprocare_backup_$TIMESTAMP.tar.gz" -C "backups" "$TIMESTAMP"
rm -rf "$BACKUP_DIR"

# 4. Clean old backups older than 7 days
find backups/ -name "reprocare_backup_*.tar.gz" -type f -mtime +7 -delete 2>/dev/null || true

echo "✔ Backup completed: backups/reprocare_backup_$TIMESTAMP.tar.gz"
