#!/bin/bash
# Database backup script for Spicy Pickle PostgreSQL
# Runs pg_dump and uploads to Google Cloud Storage
#
# Usage: ./backup.sh
# 
# Environment variables required:
#   POSTGRES_USER - Database user
#   POSTGRES_PASSWORD - Database password
#   POSTGRES_DB - Database name
#   GCS_BUCKET - Google Cloud Storage bucket name (e.g., spicy-pickle-backups)
#
# Recommended: Run via cron daily
#   0 2 * * * /path/to/infrastructure/backup.sh >> /var/log/spicy-pickle-backup.log 2>&1

set -euo pipefail

# Configuration
BACKUP_DIR="/tmp/spicy-pickle-backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="spicy-pickle-backup-${TIMESTAMP}.sql.gz"
RETENTION_DAYS=30

# Ensure backup directory exists
mkdir -p "${BACKUP_DIR}"

echo "[$(date)] Starting backup..."

# Create compressed backup
PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
  -h localhost \
  -U "${POSTGRES_USER}" \
  -d "${POSTGRES_DB}" \
  --no-owner \
  --no-acl \
  | gzip > "${BACKUP_DIR}/${BACKUP_FILE}"

echo "[$(date)] Backup created: ${BACKUP_FILE}"

# Upload to Google Cloud Storage
if [[ -n "${GCS_BUCKET:-}" ]]; then
  gsutil cp "${BACKUP_DIR}/${BACKUP_FILE}" "gs://${GCS_BUCKET}/backups/${BACKUP_FILE}"
  echo "[$(date)] Uploaded to gs://${GCS_BUCKET}/backups/${BACKUP_FILE}"
  
  # Clean up old backups from GCS (keep last RETENTION_DAYS days)
  CUTOFF_DATE=$(date -d "-${RETENTION_DAYS} days" +%Y%m%d 2>/dev/null || date -v-${RETENTION_DAYS}d +%Y%m%d)
  gsutil ls "gs://${GCS_BUCKET}/backups/" | while read -r file; do
    # Extract date from filename
    FILE_DATE=$(echo "${file}" | grep -oP '\d{8}' | head -1 || echo "")
    if [[ -n "${FILE_DATE}" && "${FILE_DATE}" < "${CUTOFF_DATE}" ]]; then
      echo "[$(date)] Deleting old backup: ${file}"
      gsutil rm "${file}"
    fi
  done
else
  echo "[$(date)] WARNING: GCS_BUCKET not set, backup not uploaded to cloud storage"
fi

# Clean up local backup
rm -f "${BACKUP_DIR}/${BACKUP_FILE}"

echo "[$(date)] Backup complete!"
