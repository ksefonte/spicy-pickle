# Spicy Pickle Infrastructure

This directory contains infrastructure configuration for self-hosted PostgreSQL on Google Cloud Platform.

## Development vs Production Database

| Environment | Database   | Provider          |
| ----------- | ---------- | ----------------- |
| Local Dev   | SQLite     | `file:dev.sqlite` |
| Production  | PostgreSQL | GCE e2-micro      |

The Prisma schema uses SQLite for local development (simpler setup, no Docker required).
For production deployment, change `provider = "sqlite"` to `provider = "postgresql"` in `prisma/schema.prisma`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Google Cloud Project: spicy-pickle-484622                       │
│ Region: australia-southeast1 (Sydney)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐     ┌─────────────────┐                   │
│  │   Cloud Run     │────▶│  GCE e2-micro   │                   │
│  │  (Spicy Pickle) │     │   (Postgres)    │                   │
│  └─────────────────┘     └────────┬────────┘                   │
│          │                        │                             │
│          │                        ▼                             │
│          │               ┌─────────────────┐                   │
│          │               │  Cloud Storage  │                   │
│          │               │   (Backups)     │                   │
│          │               └─────────────────┘                   │
│          ▼                                                      │
│  ┌─────────────────┐                                           │
│  │  Cloud Pub/Sub  │                                           │
│  │  (Webhooks)     │                                           │
│  └─────────────────┘                                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## GCE VM Setup

### 1. Create the VM

```bash
# Set project
gcloud config set project spicy-pickle-484622

# Create e2-micro instance (free tier eligible)
gcloud compute instances create spicy-pickle-db \
  --zone=australia-southeast1-b \
  --machine-type=e2-micro \
  --image-family=cos-stable \
  --image-project=cos-cloud \
  --boot-disk-size=10GB \
  --boot-disk-type=pd-ssd \
  --tags=postgres-server \
  --metadata=google-logging-enabled=true

# Allow internal traffic from Cloud Run (VPC connector)
gcloud compute firewall-rules create allow-postgres-internal \
  --direction=INGRESS \
  --priority=1000 \
  --network=default \
  --action=ALLOW \
  --rules=tcp:5432 \
  --source-ranges=10.8.0.0/28 \
  --target-tags=postgres-server
```

### 2. SSH into the VM and Set Up Docker

```bash
# SSH into the instance
gcloud compute ssh spicy-pickle-db --zone=australia-southeast1-b

# Create directory for docker-compose
sudo mkdir -p /opt/spicy-pickle
cd /opt/spicy-pickle

# Create .env file (replace with secure password)
cat > .env << 'EOF'
POSTGRES_USER=spicypickle
POSTGRES_PASSWORD=YOUR_SECURE_PASSWORD_HERE
POSTGRES_DB=spicypickle
GCS_BUCKET=spicy-pickle-backups
EOF

# Copy docker-compose.yml (or create it)
# Note: On Container-Optimized OS, use docker directly
docker run -d \
  --name spicy-pickle-db \
  --restart unless-stopped \
  -e POSTGRES_USER=spicypickle \
  -e POSTGRES_PASSWORD=YOUR_SECURE_PASSWORD_HERE \
  -e POSTGRES_DB=spicypickle \
  -v /var/lib/postgresql/data:/var/lib/postgresql/data \
  -p 127.0.0.1:5432:5432 \
  postgres:16-alpine
```

### 3. Get the Internal IP

```bash
# Get the internal IP of the VM
gcloud compute instances describe spicy-pickle-db \
  --zone=australia-southeast1-b \
  --format='get(networkInterfaces[0].networkIP)'
```

Use this IP in your `DATABASE_URL` for Cloud Run.

## VPC Connector Setup

Cloud Run needs a VPC connector to access the GCE instance on its internal IP.

```bash
# Create VPC connector
gcloud compute networks vpc-access connectors create spicy-pickle-connector \
  --region=australia-southeast1 \
  --network=default \
  --range=10.8.0.0/28 \
  --min-instances=2 \
  --max-instances=3

# Verify connector
gcloud compute networks vpc-access connectors describe spicy-pickle-connector \
  --region=australia-southeast1
```

## Cloud Storage Backup Bucket

```bash
# Create backup bucket
gsutil mb -l australia-southeast1 gs://spicy-pickle-backups

# Set lifecycle policy (delete backups older than 30 days)
cat > /tmp/lifecycle.json << 'EOF'
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"age": 30}
    }
  ]
}
EOF

gsutil lifecycle set /tmp/lifecycle.json gs://spicy-pickle-backups
```

## Database Connection String

For local development with port forwarding:

```bash
# SSH tunnel to GCE instance
gcloud compute ssh spicy-pickle-db --zone=australia-southeast1-b -- -L 5432:localhost:5432

# Then use:
DATABASE_URL="postgresql://spicypickle:YOUR_PASSWORD@localhost:5432/spicypickle"
```

For Cloud Run (using VPC connector):

```
DATABASE_URL="postgresql://spicypickle:YOUR_PASSWORD@INTERNAL_IP:5432/spicypickle"
```

## Backup Configuration

### Manual Backup

```bash
# SSH into VM
gcloud compute ssh spicy-pickle-db --zone=australia-southeast1-b

# Run backup script
cd /opt/spicy-pickle
./backup.sh
```

### Automated Daily Backups

Add to VM's crontab:

```bash
# Edit crontab
crontab -e

# Add daily backup at 2 AM AEST
0 2 * * * /opt/spicy-pickle/backup.sh >> /var/log/spicy-pickle-backup.log 2>&1
```

## Estimated Costs

| Resource                | Cost                         |
| ----------------------- | ---------------------------- |
| GCE e2-micro            | Free (1 per billing account) |
| 10GB SSD Boot Disk      | ~$1.70/month                 |
| Cloud Storage (backups) | ~$0.05/month                 |
| VPC Connector           | ~$0.10/month                 |
| **Total**               | **~$2/month**                |

## Restore from Backup

```bash
# Download backup from GCS
gsutil cp gs://spicy-pickle-backups/backups/spicy-pickle-backup-YYYYMMDD_HHMMSS.sql.gz /tmp/

# Restore
gunzip < /tmp/spicy-pickle-backup-*.sql.gz | docker exec -i spicy-pickle-db psql -U spicypickle -d spicypickle
```

## Migration to Cloud SQL

When you outgrow the e2-micro, migrate to Cloud SQL:

```bash
# Export current database
./backup.sh

# Create Cloud SQL instance
gcloud sql instances create spicy-pickle-sql \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=australia-southeast1

# Import backup
gcloud sql import sql spicy-pickle-sql gs://spicy-pickle-backups/backups/LATEST.sql.gz \
  --database=spicypickle
```
