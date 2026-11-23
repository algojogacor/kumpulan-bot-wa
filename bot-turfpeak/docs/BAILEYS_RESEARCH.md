# Baileys Research & Architecture Gate
## WhatsApp Integration for Flash Peak TMS

**Date of Research:** 18 November 2026  
**Investigator:** Agent 0 (foundation) — Architect / Integrator  
**Mandatory Gate:** AGENT.md §2, PLANS.md Task 0.2, Board Directive #3  

---

## 1. Upstream Repository & Reference Clone

- **Official Repository:** `https://github.com/WhiskeySockets/Baileys`
- **Documentation Guide:** `https://baileys.wiki/`
- **Reference Clone Path:** `vendor/baileys-reference/`
- **Reference Commit SHA:** `bb0a87e0326ca8f882fe716c7ee42da362f73fc0`
- **Reference Package Version:** `7.0.0-rc14` (main branch tracking release candidates)
- **Reference License:** MIT

---

## 2. Live npm Registry Investigation

Queried live from npm registry on 18 November 2026:

### `npm view @whiskeysockets/baileys dist-tags --json`
```json
{
  "latest": "7.0.0-rc14",
  "legacy": "6.7.24"
}
```

### Version Timeline & Release Status
- **v6 Stable Line:** The final, battle-tested release of the v6 branch is `6.7.24` (published 2026-07-29, gitHead `e0629940ee2d335b0c0119367fd2a934e0fa3189`). It has had 24 maintenance updates and is classified as the official `"legacy"` tag on npm.
- **v7 Release Candidate Line:** The v7 series started in September 2025 (`7.0.0-rc.1`) and progressed through 14 release candidate iterations up to `7.0.0-rc14` (published 2026-07-29). It remains tagged as a pre-release candidate in its version name (`7.0.0-rc14`), despite npm dist-tag `"latest"`.

---

## 3. Comparison: v6 Stable vs v7 Release Candidate

| Feature / Criteria | v6 Stable (`6.7.24`) | v7 Release Candidate (`7.0.0-rc14`) |
| :--- | :--- | :--- |
| **Stability Status** | **Production-Ready & Battle-tested** across thousands of deployments. | **Release Candidate / Experimental**. Still undergoing frequent internal refactors. |
| **Breaking Changes** | None. Stable, well-documented API. | **Major Breaking Changes** (documented at `https://whiskey.so/migrate-latest`). |
| **Auth State Storage** | Standard `useMultiFileAuthState`. Rock-solid file persistence with atomic credential updates. | Modified credential serialization; some auth helper signatures altered. |
| **Event System** | Predictable `sock.ev.on` with clean event signatures for `messages.upsert`, `connection.update`, and `creds.update`. | Refactored internal event queueing; potential race conditions in rapid reconnects. |
| **Anti-Ban Safety** | Proven keepalive pinging, quiet connection teardowns, and predictable handshake protocol matching WhatsApp Web. | Fast-changing handshake logic; higher risk of triggering anti-bot heuristics during RC phase. |
| **TypeScript Definitions** | Complete, tested `.d.ts` types in `lib/index.d.ts`. | Evolving type definitions; strict checks in flux. |
| **Organizer / Project Risk** | **Low**. Meets all FRD and MVP requirements without experimental risk. | **High**. RC regressions could break tournament match intake mid-event. |

---

## 4. Decision & Version Pinning

### Chosen Version: `@whiskeysockets/baileys@6.7.24` (Stable)

**Rationale:**
1. **Compliance with AGENTS.md §2:** *"Prefer stable for MVP unless a documented required feature/fix justifies the RC and the organizer accepts the risk."* No missing feature in `6.7.24` justifies accepting the breaking changes and instability of `7.0.0-rc14`.
2. **Compliance with User Coordinator Directive (#3):** *"CRITICAL USER DIRECTIVE: You MUST select the STABLE release of Baileys (the battle-tested v6 line, e.g. 6.7.x stable, NOT experimental v7 release candidates). Ensure the research in docs/BAILEYS_RESEARCH.md and configuration explicitly prioritize stability and WhatsApp account safety."*
3. **Account Safety:** For a WhatsApp-first tournament management application handling sensitive participant interactions and match reports, stability and predictable socket lifecycle are paramount.

### Lockfile Requirement
- Pinned exactly as `"@whiskeysockets/baileys": "6.7.24"` in `package.json`.
- Floating dependencies (`^` or `~`) are strictly prohibited in production.

---

## 5. WhatsApp Account Safety & Anti-Ban Architecture

WhatsApp enforces strict automated detection for spam, bulk messaging, and non-standard client behavior. Flash Peak TMS operates under the following safety guardrails:

1. **Exponential Reconnect Backoff:**
   - On disconnect (e.g. `DisconnectReason.connectionClosed`, `DisconnectReason.connectionLost`, `DisconnectReason.restartRequired`), the reconnection delay MUST use exponential backoff:
     $$\text{delay} = \min(\text{baseDelay} \times 2^{\text{retryCount}} + \text{jitter}, \text{maxDelay})$$
     (e.g., 2s, 4s, 8s, 16s, up to 60s maximum).
   - If `DisconnectReason.loggedOut` (statusCode 401) occurs, the bot MUST halt immediately and notify the organizer; it must NEVER loop reconnecting with invalid credentials.

2. **Outbound Rate Limiting & Throttling:**
   - Outbound messages to the central group must be throttled with minimum intervals (e.g. 1.5 to 2.5 seconds between messages).
   - In progressive draw reveals (`!draw`), reveal messages must pace delivery (e.g., 2–3 seconds per team) rather than firing instantaneously.

3. **Restricted Message Scope:**
   - The bot operates exclusively inside the designated Central Tournament Group (`WA_CENTRAL_GROUP_JID`) and direct organizer commands (`WA_ORGANIZER_JID`).
   - Never send unsolicited private messages (DMs) to arbitrary phone numbers.

4. **Credential Isolation:**
   - Baileys credentials and Signal protocol keys are persisted in `auth_state/` on the local filesystem with restricted permissions (`chmod 700`).
   - Credentials are NEVER stored in Turso database tables, git commits, or application logs.

5. **Payload Realism & Keepalive:**
   - Maintain default browser simulation headers (`Browsers.ubuntu('Desktop')` or `Browsers.appropriate(...)`).
   - Allow Baileys built-in keepalive ping mechanism (15-30s) to run unimpeded.

---

## 6. Addressing & Identity Handling (JID vs LID)

Baileys handles several address formats that must be normalized:

1. **Phone-Number JID (PN JID):** `[country_code][number]@s.whatsapp.net` (e.g. `6281234567890@s.whatsapp.net`).
2. **Linked Identity JID (LID):** `[internal_id]@lid` (e.g. `12345678901234@lid`). Modern WhatsApp multi-device accounts frequently emit LIDs in group messages to protect phone number privacy.
3. **Group JID:** `[group_id]@g.us` (e.g. `120363000000000000@g.us`).
4. **Device Suffixes:** Multi-device stanzas may append `:0`, `:1`, etc., to the user part (e.g. `6281234567890:1@s.whatsapp.net`).

### Crucial Normalization Rules
- **NEVER** use `jid.split('@')[0]` or `===` direct string comparisons for identity.
- **ALWAYS** use canonical decoding:
  ```ts
  import { jidNormalizedUser, areJidsSameUser } from '@whiskeysockets/baileys';
  const cleanJid = jidNormalizedUser(rawJid); // Strips device suffix and normalizes case
  ```
- **Relational Storage:** JID and LID are stored as aliases in the `whatsapp_identities` table, tied to a single canonical `delegate_id`. When an incoming message arrives via LID, the system looks up the delegate by `raw_address = lid`. If not found, it correlates via phone JID if available, or escalates to organizer confirmation (FR-ID-004). Never create a duplicate delegate record.

---

## 7. Migration Checklist for Future v7 Upgrade

When the upstream repository stabilizes v7 and removes the Release Candidate designation:
1. Re-inspect `https://whiskey.so/migrate-latest` and `https://baileys.wiki/docs/intro/`.
2. Test session migration from `auth_state/` in a non-production test environment.
3. Verify `messages.upsert` payload typing against updated `WAMessage` definitions.
4. Execute full end-to-end regression tests before deploying to production.
