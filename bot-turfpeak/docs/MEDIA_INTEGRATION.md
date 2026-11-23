# Media Storage Service & Ingestion Integration
## Flash Peak TMS — Fase 2 Technical Documentation

---

## 1. Verax Architectural Reference & Independence Verification

Per **AGENTS.md §5**, **DECISIONS.md (D-021, D-022)**, and **Organizer Decision O-011**:
- Tournament evidence (screenshots, goalkeeper statistics) **must never** be commingled with Verax production editorial media.
- The architectural pattern was inspected from local reference copy at `D:\Projects\verax\services\media-storage`.
- What is reused:
  - Public/private/quarantine/tmp/backup directory separation pattern.
  - Local SQLite metadata sidecar (`database/media.sqlite`) tracking physical storage location, size, SHA-256, visibility, and status.
  - Cryptographically bound HMAC-SHA256 request authentication with one-time nonce replay protection.
- What is independent:
  - **Process:** Independent PM2 service `flashpeak-media`.
  - **Port:** Default port `4189` (Verax uses port `4188`).
  - **Storage Root:** `/var/lib/flashpeak/media` (or `./data/flashpeak-media` locally), completely isolated from `/var/lib/verax/media`.
  - **Database:** Dedicated `database/media.sqlite` instance.
  - **Visibility:** Match evidence is strictly **private by default** (INFRASTRUCTURE.md §4).

---

## 2. Media Service Endpoints Contract

Base URL: `http://127.0.0.1:4189` (configurable via `FLASHPEAK_MEDIA_API_URL`)

### 2.1 `GET /health`
- **Auth:** Public (unauthenticated)
- **Response:** `200 OK`
```json
{
  "status": "ok",
  "service": "flashpeak-media",
  "database": "ok",
  "storage": "ok",
  "timestamp": "2026-11-18T10:00:00.000Z"
}
```

### 2.2 `GET /api/v1/media/stats`
- **Auth:** HMAC-SHA256 (`action: "stats"`)
- **Response:** `200 OK`
```json
{
  "status": "ok",
  "storage": {
    "storageRoot": "/var/lib/flashpeak/media",
    "usedBytes": 1048576,
    "quotaBytes": 5368709120,
    "freeBytes": 5367660544,
    "usagePercent": "0.02"
  },
  "media": {
    "totalItems": 12,
    "activeItems": 11,
    "quarantinedItems": 1,
    "totalFileBytes": 1048576
  },
  "timestamp": "2026-11-18T10:00:00.000Z"
}
```

### 2.3 `POST /api/v1/media/upload`
- **Auth:** HMAC-SHA256 (`action: "upload"`)
- **Headers:**
  - `Content-Type`: `image/jpeg` | `image/png` | `image/webp`
  - `Content-Length`: `<byte_count>`
  - `X-Media-Role`: `MAIN_MATCH` | `GOALKEEPER_DETAIL` | `SUPPORTING_EVIDENCE` | `MANUAL_REVIEW`
  - `X-Original-Filename`: `<filename>`
  - `X-Media-Auth-Signature`: `<hmac_sha256_hex>`
  - `X-Media-Auth-Payload`: `<json_payload>`
- **Body:** Binary octet stream
- **Validation Pipeline:**
  1. HMAC signature and nonce replay verification.
  2. Storage quota availability check.
  3. Incremental streaming to `tmp/upload_<uuid>.tmp`.
  4. Max file size enforcement (default 10MB; sends `413 FILE_TOO_LARGE` on limit breach).
  5. Magic bytes sniffing (JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP `RIFF ... WEBP`). Rejects spoofed extensions with `415 UNSUPPORTED_MEDIA_TYPE`.
  6. Disallowed format inspection (rejects SVG/XML, HTML/script, PE executables, ELF binaries, shell scripts with `400 DISALLOWED_FORMAT`).
  7. On-the-fly SHA-256 computation and image dimension extraction.
  8. Atomic rename to target role directory: `${storageRoot}/${roleDir}/${uuid}.${ext}`.
  9. Record inserted into SQLite `media_items` table.
- **Response:** `201 Created`
```json
{
  "id": "7f8b9c0d-1e2f-4a5b-8c9d-0e1f2a3b4c5d",
  "storage_key": "private/match_evidence/7f8b9c0d-1e2f-4a5b-8c9d-0e1f2a3b4c5d.png",
  "relative_path": "private/match_evidence/7f8b9c0d-1e2f-4a5b-8c9d-0e1f2a3b4c5d.png",
  "original_filename": "match_score.png",
  "mime_type": "image/png",
  "byte_size": 254120,
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "media_role": "MAIN_MATCH",
  "visibility": "private",
  "status": "stored",
  "width": 1920,
  "height": 1080,
  "created_at": "2026-11-18T10:00:00.000Z"
}
```

### 2.4 `GET /api/v1/media/:id`
- **Auth:** HMAC-SHA256 (`action: "download"`, `resourceId: ":id"`)
- **Response:** `200 OK` with binary stream, `Content-Type`, `Content-Length`, `ETag: "<sha256>"`, `Cache-Control: "private, no-cache"`.

### 2.5 `GET /api/v1/media/:id/metadata`
- **Auth:** HMAC-SHA256 (`action: "metadata"`, `resourceId: ":id"`)
- **Response:** `200 OK` with JSON metadata record.

### 2.6 `DELETE /api/v1/media/:id`
- **Auth:** HMAC-SHA256 (`action: "delete"`, `resourceId: ":id"`)
- **Behavior:** Moves file from storage role folder to `quarantine/${timestamp}_${filename}`, marks status in SQLite as `'quarantined'`, subsequent GET requests return `404 Not Found`.
- **Response:** `200 OK`
```json
{
  "success": true,
  "id": "7f8b9c0d-1e2f-4a5b-8c9d-0e1f2a3b4c5d",
  "status": "quarantined"
}
```

---

## 3. Storage Hierarchy & Role Mapping

```
/var/lib/flashpeak/media/
├── private/
│   ├── match_evidence/       # MAIN_MATCH screenshots
│   ├── goalkeeper_detail/    # GOALKEEPER_DETAIL screenshots
│   ├── supporting/           # SUPPORTING_EVIDENCE, other match proof
│   └── manual_review/        # MANUAL_REVIEW disputed images
├── quarantine/               # Soft-deleted / quarantined files
├── tmp/                      # Active chunk streaming temp files
├── backups/                  # Online VACUUM INTO database snapshots
└── database/
    └── media.sqlite          # Metadata sidecar & nonce tracking database
```

---

## 4. Client Adapter (`src/media/client.ts`)

The `FlashPeakMediaClient` encapsulates communication between the bot application and the media storage service:
1. **Pre-upload SHA-256 calculation:** Computes hash from local binary buffer before transmission.
2. **Deterministic storage key generation:** Paths are created solely by the media service, never trusting user input (ARCHITECTURE.md §10).
3. **Post-upload hash assertion:** Compares local hash against service-computed hash; throws on mismatch.
4. **Authoritative metadata sync:** Records asset into Turso `media_assets` table with `storage_provider = 'FLASHPEAK_VM_MEDIA'`.
5. **Download integrity verification:** Downloads binary stream and verifies SHA-256 checksum against stored database record.
6. **Quarantine synchronization:** Calls remote deletion and updates Turso status to `'QUARANTINED'`.

---

## 5. Ingestion Pipeline & Debounce Engine

### 5.1 Inbound Message Capture (`src/ingestion/capture.ts`)
- Idempotent capture using stable `provider_message_key` unique constraint (FR-ING-006).
- Duplicate messages are identified, preserved, and returned with `isDuplicate: true` without overwriting earlier evidence.

### 5.2 Session Lifecycle & Late Evidence (`src/ingestion/session.ts`)
- Active report session scoped by `(fixture_id, submitting_team_id)`.
- **Late evidence attachment (FR-ING-007):** If an active session exists in `COLLECTING` or `PROCESSING`, incoming evidence attaches to that session rather than creating duplicate report drafts.
- **Session expiry & 3x extension cap (FR-ING-008 / D-033):** Default 10-minute expiry window. Extensions are permitted up to 3 times (`extension_count <= 3`). Upon the 4th extension request, extension is rejected and flagged with `requiresOrganizerReview: true`.

### 5.3 5-Second Sliding Debounce Window (`src/ingestion/debounce.ts`)
- **Sliding quiet window (FR-ING-002/003):** Each new message resets `debounce_due_at = now + 5000` and increments `version = version + 1`.
- **Session isolation:** Resetting Session A updates only Session A's timers; Session B is never affected. No global timers.
- **Atomic batch close (FR-ING-005):** Claims are guarded by optimistic locking on `version` and `lease_expires_at`, preventing concurrent workers from dual-processing the same batch.
- **Restart safety:** Orphaned leases from crashed processes are automatically reclaimed via `recoverOrphanedLeases()`.
