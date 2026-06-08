#!/bin/bash
# Nightly MongoDB backup to S3
# Schedule via cron: 0 2 * * * /path/to/backup.sh >> /var/log/backup.log 2>&1
#
# Requires: mongodump, awscli, gzip
# Env vars: MONGO_URI, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, BACKUP_S3_BUCKET

set -euo pipefail

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="/tmp/mongo_backup_${TIMESTAMP}"
ARCHIVE="/tmp/mongo_backup_${TIMESTAMP}.tar.gz"
BUCKET="${BACKUP_S3_BUCKET:-}"
RETENTION_DAYS=30

if [ -z "$BUCKET" ]; then
  echo "[backup] ERROR: BACKUP_S3_BUCKET is not set"
  exit 1
fi

echo "[backup] Starting backup at ${TIMESTAMP}"

# Dump
mongodump --uri="${MONGO_URI}" --out="${BACKUP_DIR}" --quiet

# Compress
tar -czf "${ARCHIVE}" -C "/tmp" "mongo_backup_${TIMESTAMP}"
rm -rf "${BACKUP_DIR}"

# Upload to S3
aws s3 cp "${ARCHIVE}" "s3://${BUCKET}/backups/backup_${TIMESTAMP}.tar.gz" \
  --region "${AWS_REGION:-ap-south-1}"

rm -f "${ARCHIVE}"
echo "[backup] Uploaded backup_${TIMESTAMP}.tar.gz to s3://${BUCKET}/backups/"

# Prune backups older than RETENTION_DAYS
CUTOFF=$(date -d "-${RETENTION_DAYS} days" +"%Y-%m-%dT%H:%M:%S" 2>/dev/null || \
         date -v -${RETENTION_DAYS}d +"%Y-%m-%dT%H:%M:%S")

aws s3 ls "s3://${BUCKET}/backups/" --region "${AWS_REGION:-ap-south-1}" | while read -r line; do
  FILE_DATE=$(echo "$line" | awk '{print $1"T"$2}')
  FILE_NAME=$(echo "$line" | awk '{print $4}')
  if [[ "$FILE_NAME" == backup_*.tar.gz ]] && [[ "$FILE_DATE" < "$CUTOFF" ]]; then
    aws s3 rm "s3://${BUCKET}/backups/${FILE_NAME}" --region "${AWS_REGION:-ap-south-1}"
    echo "[backup] Pruned old backup: ${FILE_NAME}"
  fi
done

echo "[backup] Done"
