# Infrastructure and Media Storage

## 1. Existing VM context to verify

Prior project context identifies an Azure VM used by Verax:
- VM name: `forfh-korea-vm`
- OS: Ubuntu 24.04.5
- Size previously observed: Standard_B2ats_v2
- Approximate resources previously observed: 2 vCPU and about 1 GiB RAM
- Existing services already run on the VM.

These are historical observations, not a live health check. Re-inspect actual CPU, RAM, disk, services, ports, firewall, and free capacity before deployment.

## 2. Study Verax media pattern — architectural reference only, NOT a shared service

**Organizer decision (confirmed): Flash Peak tournament evidence MUST NOT share a storage instance, service process, database, or publicly reachable path with Verax production media.** The reason is that tournament screenshots (match results, goalkeeper stats) must never be reachable through, or appear alongside, Verax's editorial/redaksi content — there is no legitimate scenario where a news reader should encounter a game screenshot.

What IS reused: the architectural pattern, studied from a local reference copy at `D:\Projects\verax` (inspect this local project, not the live Verax production VM, for pattern reference):
- The public/private/quarantine/temp/backup separation strategy.
- The metadata-sidecar approach (a lightweight local database such as SQLite tracking storage location/path, size, SHA-256, visibility, and status, separate from binary storage).
- The general shape of a storage tree (e.g. distinct top-level folders per visibility/role).

What is NOT reused: the actual running `verax-media` PM2 service, its port, its `/var/lib/verax/media` storage path, or its `media.sqlite` database. Flash Peak gets its own independently deployed instance of this pattern — own service process, own storage path (e.g. `/var/lib/flashpeak/media`), own metadata database — even if it runs on the same VM for cost reasons.

Historical paths previously observed on the Verax production service (for pattern reference only — do not reuse these literal paths for Flash Peak):
- PM2 service named `verax-media`, API port previously identified as `4188`.
- Storage target: `/var/lib/verax/media`; metadata database: `media.sqlite`.
- Storage tree: `public/articles`, `public/thumbnails`, `public/infographics`, `private/editorial`, `quarantine`, `backups`, `tmp`, `database/media.sqlite`.

## 3. Integration requirements

Required approach (revised — separate instance, not reuse):
- Deploy a SEPARATE media service instance for Flash Peak, following the Verax pattern's structure but with its own process, port, storage path, and metadata database.
- Define Flash Peak-specific media roles for tournament evidence (see §4) — these do not need to match Verax's editorial roles since it is a separate schema.
- Do not let the bot write arbitrary paths directly.
- Upload through Flash Peak's own media API or approved internal interface.
- Store returned media ID/storage key and SHA-256 in Turso.
- If, for infrastructure cost/simplicity reasons, the Flash Peak media service ends up running on the same VM as Verax, it MUST still use a fully separate storage directory tree, a separate metadata database file, and (if public serving is needed at all) a separate Nginx server block/path that is never nested under or aliased to any Verax-served path.

## 4. Media classification and access

Recommended media roles:
- `MAIN_MATCH`
- `GOALKEEPER_DETAIL`
- `SUPPORTING_EVIDENCE`
- `MANUAL_REVIEW`

Evidence is private by default unless public access is explicitly required. Do not expose player screenshots through guessable public URLs.

## 5. Integrity and lifecycle

- Preserve original uploaded image.
- Compute SHA-256.
- Store byte size and MIME type.
- Verify file exists and hash matches before AI processing.
- Do not overwrite original evidence.
- Reprocessed derivatives are separate assets with parent reference.
- Quarantine unsupported or suspicious files.
- Apply upload size limits and image decoding safeguards.
- Clean temporary files after successful durable storage.
- Retain evidence according to organizer-defined retention policy.

## 6. Turso connectivity

- Use TLS remote connection.
- Keep database URL and auth token in environment/secret store.
- Use a least-privilege token where available.
- Do not put tokens in repository, prompts, logs, or screenshots.
- Use migrations and transaction boundaries.
- Measure read/write usage and latency.
- Provide backup/export and restore procedures.

## 7. Runtime deployment

- Inspect current Node.js version and PM2 setup.
- Prefer one lightweight service process initially unless load testing justifies workers.
- Use PM2/systemd according to existing host conventions.
- Add health endpoint and readiness checks.
- Restart safely after transient socket/provider failure.
- Ensure process restart restores pending debounce jobs and draw reveal state from database.
- Avoid Docker or heavyweight databases unless capacity analysis justifies them.

## 8. Security

- Baileys auth state is sensitive and must be outside version control.
- Restrict auth/session file permissions.
- API keys are environment secrets.
- Do not store provider secrets in Turso business tables.
- Use HTTPS for external access.
- Restrict private evidence access.
- Keep audit logs.
- Back up database and media metadata.
- Verify backup restore, not merely backup creation.
