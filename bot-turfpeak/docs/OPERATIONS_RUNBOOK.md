# Flash Peak TMS — Operations & Deployment Runbook

**Document Version:** 1.0.0  
**Target Environment:** 1–2 GB RAM Debian/Ubuntu Linux VM  
**Process Manager:** PM2  
**Authoritative Standard:** AGENTS.md §14, INFRASTRUCTURE.md §1–6

---

## 1. System Architecture & Port Allocations

Flash Peak TMS runs as two decoupled, independently supervised services on the VM to maximize stability and prevent memory exhaustion:

```
┌────────────────────────────────────────────────────────┐
│                        Linux VM                        │
│                                                        │
│  ┌─────────────────────────┐  ┌─────────────────────┐  │
│  │ flashpeak-bot           │  │ flashpeak-media     │  │
│  │ (TMS Core & Baileys WA) │  │ (Media Storage Svc) │  │
│  │ RAM: max 300MB          │  │ RAM: max 150MB      │  │
│  │ PM2 ID: 0               │  │ Port: 4189          │  │
│  └───────────┬─────────────┘  └──────────┬──────────┘  │
│              │                           │             │
│              ▼                           ▼             │
│  ┌─────────────────────────┐  ┌─────────────────────┐  │
│  │ Turso / libSQL DB       │  │ /var/lib/flashpeak/ │  │
│  │ (local.sqlite)          │  │ media (Evidence)    │  │
│  └─────────────────────────┘  └─────────────────────┘  │
└────────────────────────────────────────────────────────┘
```

| Service Name | Description | Port | Base Path / Storage | Memory Limit |
| :--- | :--- | :---: | :--- | :---: |
| `flashpeak-bot` | Main TMS Orchestrator, Baileys WA Socket, Debounce Worker | — | Working dir / `auth_state/` | 300 MB |
| `flashpeak-media`| Dedicated Evidence Media Service (Verax pattern clone) | **4189** | `/var/lib/flashpeak/media` | 150 MB |

---

## 2. Prerequisites & Installation

### System Dependencies
- Node.js >= 24.0.0
- npm >= 10.0.0
- PM2 globally installed (`npm install -g pm2`)
- SQLite3 CLI

### Environment Setup
1. Clone the repository to the production directory:
   ```bash
   git clone <repo_url> /opt/flashpeak-tms
   cd /opt/flashpeak-tms
   ```
2. Install production dependencies and build:
   ```bash
   npm ci
   npm run build
   ```
3. Prepare the dedicated media storage directory:
   ```bash
   sudo mkdir -p /var/lib/flashpeak/media
   sudo chown -R $USER:$USER /var/lib/flashpeak/media
   sudo chmod -R 750 /var/lib/flashpeak/media
   ```
4. Configure `.env` from template:
   ```bash
   cp .env.example .env
   chmod 600 .env
   nano .env
   ```

---

## 3. Configuration Reference (`.env`)

```ini
# Environment
NODE_ENV=production
LOG_LEVEL=info

# WhatsApp Bot & Identity
WA_AUTH_PATH=./auth_state
WA_CENTRAL_GROUP_JID=120363000000000000@g.us
WA_ORGANIZER_PHONE=6281234567890
WA_ORGANIZER_JID=6281234567890@s.whatsapp.net

# Database (Turso / libSQL)
TURSO_DATABASE_URL=file:local.sqlite
# Or remote Turso:
# TURSO_DATABASE_URL=libsql://your-db.turso.io
# TURSO_AUTH_TOKEN=your-token

# Flash Peak Media Service
MEDIA_SERVICE_PORT=4188
MEDIA_STORAGE_PATH=/var/lib/flashpeak/media
MEDIA_SECRET_KEY=generate-a-strong-32-byte-hex-secret-here
MEDIA_SERVICE_URL=http://127.0.0.1:4188

# AI Providers (Free-tier rotation)
GEMINI_API_KEY=your-gemini-api-key
GROQ_API_KEY=your-groq-api-key
OLLAMA_BASE_URL=https://ollama.your-domain.com
OLLAMA_API_KEY=your-ollama-api-key
```

---

## 4. PM2 Process Management

### Startup with Ecosystem Config
Start both services in one command:
```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

### Process Control Commands
```bash
# Check status and memory usage
pm2 status
pm2 monit

# Stream logs
pm2 logs flashpeak-bot
pm2 logs flashpeak-media

# Graceful restart / zero-downtime reload
pm2 reload flashpeak-media
pm2 restart flashpeak-bot

# Stop services
pm2 stop ecosystem.config.cjs
```

---

## 5. Health Checks & Verification

### 1. Media Service Health Check
```bash
curl -f http://127.0.0.1:4188/health
```
**Expected Response:**
```json
{"status":"healthy","uptime":3600,"storage":"/var/lib/flashpeak/media"}
```

### 2. Database Integrity Check
```bash
npx tsx -e "import { getDb } from './src/db/client.js'; const db = getDb(); db.execute('SELECT 1').then(() => console.log('DB Healthy'));"
```

### 3. Orphaned Lease Recovery
If the server abruptly restarted mid-debounce, recover stalled leases:
```bash
npx tsx -e "import { getDb } from './src/db/client.js'; import { recoverOrphanedLeases } from './src/ingestion/debounce.js'; recoverOrphanedLeases(getDb()).then(n => console.log('Recovered leases:', n));"
```

---

## 6. Backup & Disaster Recovery Procedures

### Automated Daily Backup Script (`backup.sh`)
```bash
#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR="/var/backups/flashpeak"
DATE=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

echo "Backing up Turso SQLite..."
sqlite3 /opt/flashpeak-tms/local.sqlite ".backup '$BACKUP_DIR/flashpeak_db_$DATE.sqlite'"

echo "Backing up WhatsApp auth state..."
tar -czf "$BACKUP_DIR/wa_auth_$DATE.tar.gz" -C /opt/flashpeak-tms auth_state/

echo "Backing up Evidence Media metadata..."
sqlite3 /var/lib/flashpeak/media/media.sqlite ".backup '$BACKUP_DIR/media_meta_$DATE.sqlite'"

echo "Backup complete: $DATE"
find "$BACKUP_DIR" -type f -mtime +14 -delete
```

### Restore Procedure
1. Stop running services:
   ```bash
   pm2 stop ecosystem.config.cjs
   ```
2. Restore database:
   ```bash
   cp /var/backups/flashpeak/flashpeak_db_YYYYMMDD_HHMMSS.sqlite /opt/flashpeak-tms/local.sqlite
   ```
3. Restore WhatsApp auth credentials:
   ```bash
   tar -xzf /var/backups/flashpeak/wa_auth_YYYYMMDD_HHMMSS.tar.gz -C /opt/flashpeak-tms/
   ```
4. Restart services and verify logs:
   ```bash
   pm2 start ecosystem.config.cjs
   pm2 logs
   ```

---

## 7. Incident Response Runbooks

### Incident 1: WhatsApp Session Disconnected / Banned / Logged Out
- **Symptom:** Logs show `ConnectionClosed: 401 Unauthorized` or `loggedOut`.
- **Action:**
  1. Check if number was banned or logged out in WhatsApp mobile app.
  2. If session expired, clear stale state:
     ```bash
     pm2 stop flashpeak-bot
     rm -rf /opt/flashpeak-tms/auth_state/*
     ```
  3. Start bot in interactive terminal mode to scan fresh QR code:
     ```bash
     npm start
     ```
  4. Once connected, stop foreground process (`Ctrl+C`) and resume PM2:
     ```bash
     pm2 start ecosystem.config.cjs
     ```

### Incident 2: Total AI Provider Outage (Groq + Gemini + Ollama Rate-Limited)
- **Symptom:** Inbound screenshots trigger the automated failure message:
  *"Pemrosesan tangkapan layar otomatis sementara tidak tersedia..."*
- **Action:**
  1. The tournament continues uninterrupted.
  2. The organizer reviews match evidence manually from the group chat.
  3. The organizer inputs the official match result via WhatsApp:
     ```
     !manualreport <fixture_id>
     ```
  4. Both delegates and organizer approve the manual report.
  5. The result is locked and written to official standings and stats.

### Incident 3: Media Service Port 4188 Collision or Failure
- **Symptom:** `flashpeak-media` fails to bind to port 4188.
- **Action:**
  1. Identify process occupying port 4188:
     ```bash
     sudo lsof -i :4188
     ```
  2. If a legacy process is bound, terminate it:
     ```bash
     sudo kill -9 <PID>
     ```
  3. Restart media service:
     ```bash
     pm2 restart flashpeak-media
     ```

---

## 8. Rollback Procedures

If a deployment contains an unexpected regression:
1. Roll back Git repository to previous stable release tag:
   ```bash
   git checkout tags/v0.1.0-stable
   ```
2. Clean rebuild:
   ```bash
   npm ci
   npm run build
   ```
3. Reload processes without dropping active state:
   ```bash
   pm2 restart ecosystem.config.cjs
   ```
4. Verify tests on host:
   ```bash
   npm test
   ```
