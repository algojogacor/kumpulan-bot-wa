# System Architecture
## Flash Peak TMS v0.1

## 1. Architectural principles

1. Deterministic backend owns rules and state.
2. LLMs extract, classify, and interpret; they do not commit official results.
3. WhatsApp is an event transport and user interface, not the source of truth.
4. Turso is the canonical structured database.
5. VM media storage holds original image files; database stores references and metadata.
6. Each external provider is behind an adapter.
7. Every asynchronous task is idempotent and restart-safe.
8. Keep deployment lightweight; inspect current VM capacity and services before changes.

## 2. Logical components

- **WhatsApp Adapter:** Baileys socket, event normalization, outbound messages.
- **Identity Resolver:** maps observed JID/LID/address variants to internal delegate identity.
- **Command Router:** authorization and command dispatch.
- **Onboarding Service:** guided registration and delegate binding.
- **Competition Engine:** groups, fixtures, standings, BO3/BO5, brackets.
- **Draw Service:** unbiased randomization, persisted reveal state, audit proof.
- **Ingestion Service:** durable message capture and five-second debounce.
- **Media Adapter:** separate, Flash Peak-dedicated media upload/storage service, structurally modeled on the Verax media pattern (own process, path, and metadata DB — never a shared instance with Verax production; see `INFRASTRUCTURE.md` §2–3).
- **AI Orchestrator:** provider selection, retries, timeouts, circuit breakers, quota telemetry.
- **Vision Extraction:** image type classification and structured field extraction.
- **Correction Interpreter:** natural-language correction to typed patch.
- **Validation Engine:** deterministic roster, score, stats, and fixture checks.
- **Approval Service:** three-party approvals and version locking.
- **Manual Entry Service:** organizer fallback.
- **Statistics/Awards Service:** aggregates only approved/eligible game records.
- **Audit Service:** append-only event history.
- **Admin Interface:** may be a CLI or lightweight web page; exact UI is not mandated for MVP.

## 3. Recommended runtime flow

WhatsApp event
→ normalize message
→ deduplicate
→ resolve chat/delegate/team
→ attach to report session
→ persist event and media
→ reset per-session debounce to five seconds
→ when quiet window expires, atomically claim batch
→ classify image(s)
→ extract structured candidate data
→ validate with backend
→ create report draft version
→ send review summary
→ accept corrections
→ collect Team A + Team B + organizer approvals
→ lock official report
→ update standings/series/stats.

## 4. Provider abstraction

Define an internal interface such as:
- `classifyImages(input)`
- `extractMatchSummary(input)`
- `extractPlayerDetail(input)`
- `parseCorrection(input)`
- `healthCheck()`

Provider adapter responsibilities:
- Map internal request to provider-specific request.
- Verify image and structured-output support for the chosen model.
- Apply timeouts and bounded retries.
- Normalize provider errors.
- Record provider/model/version/latency/token usage where available.
- Never expose API keys to prompts or logs.

Provider selection:
1. Check provider health and capability.
2. Check configured budget/quota status.
3. Select a tested model for the required task.
4. Fall back only to a compatible provider.
5. If all compatible providers fail, activate manual mode.

Do not rotate accounts to bypass limits. Use only provider credentials and quota usage permitted by current terms.

## 5. Five-second debounce design

Use a durable report session with fields:
- `report_session_id`
- `scope_key`
- `last_message_at`
- `debounce_due_at`
- `status`
- `version`
- `lease_owner`
- `lease_expires_at`

On each relevant message:
1. Insert normalized message event with unique provider message key.
2. If duplicate, no-op.
3. Attach event to the resolved session.
4. Set `debounce_due_at = current_time + 5 seconds`.
5. Increment session version.
6. A worker claims only when `debounce_due_at <= now`.
7. Worker rechecks session version and due time before close.
8. If another message arrived, release/requeue rather than processing stale batch.
9. Atomically mark batch closed/processing.

The debounce scope must separate concurrent reports. Do not use one global timer. If fixture/game context is not known yet, use a provisional session keyed by chat + delegate + active report context, then resolve or ask clarification.

## 6. Draw architecture

- Validate onboarding and group configuration.
- Snapshot eligible teams.
- Generate cryptographically secure random permutation.
- Persist full result and reveal sequence in a transaction.
- Publish a commitment/hash before reveal where feasible.
- Reveal one team per message or controlled paced sequence.
- Persist `next_reveal_index` after each successful send.
- On restart, resume from persisted index.
- After final reveal, disclose audit material needed to verify the draw.
- Manual override is a new audited event, never mutation of the original random draw.

LLM must not randomize, choose groups, or generate outcomes.

## 7. Correction architecture

Conversation history is not the database. Persist a compact report context:
- active report and version
- fixture and game IDs
- both teams
- ordered player lists
- extracted values
- prior corrections
- pending ambiguities
- approvals

LLM returns a typed patch. Backend validates sender permission, target existence, metric type/range, old-value precondition if supplied, and report version. A patch is staged for confirmation, then applied as a new report version.

## 8. Data and consistency

- Use transactions for draw persistence, report version creation, approvals, and final locking.
- Use foreign keys/constraints where supported and tested.
- Use unique constraints for message dedupe, roster membership, fixture/game identity, and approvals per report version/approver.
- Keep immutable audit events.
- Recompute standings from locked game records or use transactional projections with a rebuild path.
- Never trust LLM-supplied totals; calculate totals in backend code.

## 9. Observability

Structured logs should include:
- correlation ID
- message/report/fixture/game IDs
- provider/model
- processing stage
- duration
- retry count
- error class
- image hash
- state transition

Never log API keys, auth credentials, or full private session files.

## 10. Security boundaries

- WhatsApp message text, captions, and screenshots are untrusted input.
- Prompt injection embedded in image/text must not override system instructions.
- LLM cannot execute SQL, shell commands, admin commands, or direct state mutations.
- Commands require server-side authorization.
- Media paths must be validated; never accept arbitrary filesystem paths from a user.
- Admin override requires identity and reason.
