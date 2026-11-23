# Product Requirements Document (PRD)
## Flash Peak Tour Management System

**Version:** 0.1.0-draft  
**Date:** 18 November 2026  
**Product owner:** Tournament organizer  
**Primary interface:** WhatsApp group via Baileys  
**Database:** Turso/libSQL  
**Media storage:** Existing VM-based Verax media pattern

---

## 1. Product vision

Build a reliable, auditable, WhatsApp-first tournament operations system that reduces repetitive human administration while keeping the organizer in control of rules, exceptions, and official decisions.

The product should automate routine work:
- Register and onboard team delegates.
- Store teams, divisions, players, and WhatsApp identity aliases.
- Randomize and visibly reveal group assignments.
- Generate fixtures and track deadlines.
- Collect match evidence in batches.
- Extract scores and statistics from screenshots.
- Understand natural-language corrections in the context of a specific report.
- Obtain approvals from both team delegates and the organizer.
- Calculate standings, knockout progression, player statistics, and awards.
- Fall back to manual reporting when AI services fail.

The product must not attempt to control, inspect, or integrate directly with the Flash Peak game client. The game remains external. The system relies on participant-submitted evidence and organizer rules.

## 2. Problem statement

Tournament administration currently requires a human to repeatedly:
- Record team and player registration details.
- Track which WhatsApp account represents which team.
- Collect results and screenshots.
- Interpret screenshots and player statistics.
- Resolve corrections and disputes.
- Calculate standings and knockout series.
- Track awards and cumulative statistics.

This is error-prone, time-consuming, and difficult to audit across multiple teams or divisions.

## 3. Goals

1. Create a canonical tournament database.
2. Make WhatsApp the operational channel for delegates.
3. Make onboarding guided and attributable.
4. Make draws visibly progressive and auditable.
5. Reduce duplicate AI calls through a five-second sliding debounce.
6. Extract evidence conservatively, never inventing unreadable data.
7. Preserve a full correction and approval history.
8. Keep official results deterministic and backend-validated.
9. Support multiple AI providers through adapters and lawful, provider-compliant quotas.
10. Deploy a separate, Flash Peak-dedicated media-storage service that follows the architectural pattern of the existing Verax media implementation (studied from local reference `D:\Projects\verax`), but does not share a storage instance, process, or database with Verax production.
11. Keep manual administration possible during AI outages.
12. Keep the system lightweight enough for the existing VM; do not assume spare RAM or install heavyweight infrastructure without measurement.

## 4. Non-goals

- Reverse-engineering or automating the Flash Peak game itself.
- Reading game state directly from a device or game server.
- Changing participant nicknames.
- Automatically adjudicating every dispute.
- Making LLM output authoritative.
- Building a public tournament website in MVP unless separately approved.
- Implementing Swiss format in MVP.
- Replacing the organizer's role in external marketing and relationships.
- Using multiple accounts to evade provider quotas or terms.
- Storing screenshots as large BLOBs in Turso.

## 5. Users and roles

### 5.1 Organizer / administrator
- Uses a personal WhatsApp number separate from the bot number.
- Prepares registrations and tournament configuration.
- Triggers `!onboarding`, `!draw`, and administrative commands.
- Approves reports, resolves disputes, and can initiate manual reporting.
- Can make authorized corrections with mandatory audit records.

### 5.2 Team delegate
- Exactly one delegate per registered team/division.
- Is the team's official WhatsApp representative.
- Completes bot-led onboarding in the central group.
- Submits match evidence, corrections, and approvals.
- Does not need to register every player's WhatsApp number.

### 5.3 Bot identity
- Separate WhatsApp account/number.
- Receives group messages, associates sender identity, manages commands, and sends prompts/status.
- Must not be confused with the organizer's personal identity.

### 5.4 Players
- Stored in team roster.
- Nicknames are immutable during the tournament.
- No direct bot interaction is required in MVP.

## 6. Competition model

MVP supports:
1. Traditional Group Stage.
2. Knockout Stage.

Group Stage default:
- One game per fixture.
- Draws permitted.
- Win 3 points, draw 1, loss 0.
- Proposed default game duration: eight minutes.
- Proposed default: top two per group qualify, but group count, qualification, and bracket validity must be configured before draw.

Knockout:
- BO3 before Grand Final.
- BO5 Grand Final.
- First to two game wins in BO3; first to three in BO5.
- A tied individual knockout game is replayed; the replay's score is added into the existing series score (e.g. series standing 2–1 followed by a tied replay becomes 3–2) rather than recorded as a separate additional game outside the series.
- No drawn series.
- Group count and sizing: teams are grouped in batches of 5, with any remainder absorbed by sizing the last groups at 4 (e.g. 23 teams → groups of 5, 5, 5, 4, 4). Exactly 2 teams qualify from every group regardless of that group's size.
- Registration is open with no cap: every team that contacts the bot is accepted into the tournament.

## 7. Registration and roster

- Five starters required: one goalkeeper and four outfield players.
- Zero to five substitutes.
- Maximum roster ten.
- A five-player-only roster is valid.
- Recommended composition is 5+3, not mandatory.
- Each team has one delegate.
- Multiple divisions under one organization are separate teams for registration and identity purposes, each with its own delegate.
- A player may represent only one team in the same tournament.
- Nickname must match the registered in-game nickname. Nickname changes are prohibited during the tournament.
- Preserve raw Unicode nickname exactly. Similarity matching is only a candidate-finding mechanism.

## 8. Match reporting and goalkeeper evidence

### 8.1 Main evidence
The main match-result screenshot is the primary report evidence. It contains the scoreboard and multi-player statistics. The exact fields must be confirmed against a representative original screenshot before implementation.

### 8.2 Goalkeeper detail evidence
The supplied goalkeeper example is an Individual Player Detail screen:
- It shows one player's character, not a multi-player table.
- It has a result header and score.
- It shows summary metrics: RATING, GOL, ASSIST, UMPAN, DEFENSE.
- The character is visually recognizable as a goalkeeper by cap, goalkeeper gloves, and a ball held in front of the abdomen/chest.
- It does not show a nickname or UID.
- Its detail tabs are SHOOTING, UMPAN, DEFENSE, POSSESSION. Only SHOOTING was open in the supplied example.
- For MVP, do not require all tabs to be opened. Use summary `DEFENSE` as goalkeeper saves, as defined by the organizer.
- Preserve raw `DEFENSE` and store a semantic `goalkeeper_saves` value separately.

The detail screen is linked to a specific game/series using the submitted caption nickname against the submitting team's roster (see 8.3). Cross-matching against the main match screenshot's statistics is not required as an identity mechanism, because the submission policy already fixes which team and which game the screenshot belongs to.

### 8.3 Submission policy
- Group Stage: goalkeeper detail evidence is submitted by the goalkeeper/delegate associated with the winning team after the match. A draw has no winning team and therefore no goalkeeper report under the current rule.
- BO3/BO5: only the goalkeeper/delegate of the series-winning team submits, after the series ends.
- **Submit exactly one goalkeeper detail screenshot for each individual game WON by that goalkeeper's team within the series — not one per game played.** Thus BO3 2–0 = two images; BO3 2–1 = two images (the lost game is not submitted at all); BO5 3–0 = three images; BO5 3–1 = three images; BO5 3–2 = three images. The count is always equal to the series' required winning-game count (2 for BO3, 3 for BO5), never the total games played.
- Every goalkeeper detail submission's message text/caption MUST include the goalkeeper's nickname (e.g. "FOTO 1 HX KINGrajj"). The nickname need not match the registered roster nickname exactly — approximate/fuzzy text matching against the submitting team's roster is sufficient. Because only the series-winning team's goalkeeper submits, the caption is never used to determine which team won; it is used only to resolve which goalkeeper within that team's roster the screenshot belongs to (relevant when a team has more than one registered goalkeeper, e.g. a substitute keeper).
- Award eligibility: since only winning games are ever submitted, every stored goalkeeper detail record is award-eligible by construction. There is no "retained but ineligible" state for goalkeeper records under this corrected policy.

## 9. WhatsApp ingestion and debounce

- All report messages arrive in one central group.
- The system captures text, caption, image/media reference, sender identity, reply context, message key, and timestamp.
- Five-second sliding debounce is per report session, not global.
- Every new relevant message resets the quiet-window timer to five seconds.
- When the quiet window expires, the batch is closed and processed.
- The batch must be durable across process restarts.
- Deduplicate messages by stable WhatsApp message key.
- Late evidence can be attached to an open report session; it must not accidentally create a new fixture report.
- The report session itself has a configurable expiry/escalation policy; do not leave incomplete reports permanently active. A new dispute/objection arriving within the current expiry window extends that window, capped at 3 extensions; after the 3rd extension the session closes under expiry policy regardless of further objections, and any later dispute goes to organizer review instead of auto-extending again.
- A five-second quiet window is a batching optimization, not proof that all evidence has arrived.

## 10. AI and provider strategy

Use provider adapters rather than provider-specific logic in business services.

Providers in use, all on free tier, confirmed by organizer:
- Groq.
- Ollama Cloud.
- Gemini.

Requests are load-balanced/rotated across these three providers rather than pinned to a single default; the adapter layer selects among them (e.g. round-robin or least-recently-used) and falls back to the next provider on failure before surfacing a manual-fallback state.

Important:
- Use only credentials and quotas allowed by each provider's current terms.
- Do not rotate multiple accounts to evade rate limits or free-tier restrictions.
- API keys belonging to the same project/account do not automatically multiply quota.
- Provider availability, vision support, structured-output support, image limits, and model identifiers must be checked at implementation time.
- Provider/model selection must be configurable and pinned to tested versions.
- AI errors must be visible and trigger manual fallback.
- The backend validates all extracted values independently.

## 11. Draw experience

- Organizer triggers `!draw` after onboarding is complete.
- The backend creates and persists the complete random assignment before revealing it.
- Reveal teams one at a time with visible progress.
- Do not reveal all teams in a single response.
- If the bot disconnects, resume the persisted reveal; never rerun randomization.
- Store participant snapshot, group configuration, randomization version, commitment/hash evidence, reveal order, timestamps, and any manual override.
- Organizer approves final group configuration and draw result.
- Randomization must be unbiased and reproducible for audit.

## 12. Result approval and corrections

Each report version requires:
1. Team A delegate approval.
2. Team B delegate approval.
3. Organizer approval.

Approvals attach to a specific immutable report version. A correction creates a new version and invalidates prior approvals. A final locked report can only be reopened by an authorized organizer action with an audit reason.

Natural-language correction must:
- Resolve the report and game context.
- Resolve the intended team and player.
- Identify statistic and replacement value.
- Distinguish correction from discussion.
- Ask for clarification when ambiguous.
- Produce a structured patch for backend validation.
- Never directly mutate the database from model-generated text.

## 13. Storage and privacy

- Turso stores structured records, status, hashes, metadata, and storage references.
- VM media storage stores original images.
- Replicate the existing Verax media service's architectural pattern (folder layout, metadata-sidecar approach, public/private/quarantine separation), studied from the local reference at `D:\Projects\verax`, but deploy a SEPARATE storage instance/service for Flash Peak tournament evidence. Tournament screenshots must never share a storage instance, service, or publicly reachable path with Verax editorial media — this prevents tournament screenshots from ever surfacing through the news site. Do not assume an endpoint or schema without inspecting the live Verax VM for pattern reference.
- Store image SHA-256, byte size, MIME type, visibility, status, storage key/path reference, and ownership.
- Keep database human-inspectable. Do not apply unnecessary field-level encryption.
- Protect secrets, Baileys auth/session state, and API keys separately from ordinary tournament data.
- Apply least-privilege file permissions, HTTPS, backups, and access controls.

## 14. Failure behavior

If image extraction or all configured AI providers fail:
- Do not fabricate a result.
- Tell the delegate automated processing is temporarily unavailable.
- Ask them to contact the organizer.
- Organizer can initiate manual reporting through an admin-only command (provisional name `!manualreport`).
- Manual entry follows the same validation, evidence, approval, and audit lifecycle.
- Mark provenance as `MANUAL_ENTRY`.

## 15. Success metrics

- Percentage of reports processed without manual re-entry.
- Screenshot field-level extraction accuracy.
- False player/team association rate (target zero accepted false matches).
- Time from final report message to draft extraction.
- Duplicate report rate.
- Approval completion time.
- AI failure rate and manual fallback rate.
- Draw reproducibility/audit completeness.
- Storage integrity and backup restore success.

## 16. MVP release gates

Do not launch until:
- Main and goalkeeper screenshot fixtures are documented.
- Parser evaluation set passes agreed accuracy thresholds.
- No ambiguous player identity is silently auto-approved.
- Group draw survives restart without rerolling.
- Duplicate WhatsApp messages are idempotent.
- JID/LID alias mapping is tested across phone and linked-device message paths.
- Corrections and approvals are versioned.
- Manual fallback is tested end-to-end.
- VM storage integration is verified against the existing Verax implementation.
- Rulebook and all open decisions are approved by organizer.
