# Workflows and State Machines

## 1. Registration preparation

1. Organizer receives team application outside the bot.
2. Organizer enters team, division, delegate, roster, and player positions into admin-prepared data.
3. Bot number and organizer personal number remain distinct.
4. Team is marked `PRE_REGISTERED`.
5. No team is eligible for draw until registration and delegate verification pass.

## 2. `!onboarding`

Preconditions:
- Organizer is authorized.
- All expected teams have been pre-registered.
- Central group is configured.

Flow:
1. Organizer sends `!onboarding`.
2. Bot creates or resumes onboarding session.
3. Bot prompts for the next team/division by its pre-registered name.
4. The official delegate replies directly to that bot prompt.
5. System captures sender identifier(s), reply context, group ID, and timestamp.
6. Identity resolver associates observed JID/LID aliases with the canonical delegate.
7. Bot confirms team association without exposing unnecessary personal data.
8. Repeat for each team.
9. Final checks verify exactly one delegate per team and no unresolved identity conflicts.
10. Bot reports onboarding complete or lists unresolved teams.

Do not treat an unrelated group message as an onboarding answer. If reply context is missing, ask the sender to reply to the exact prompt.

## 3. JID/LID and multi-device identity

- Treat JID/LID as observed addresses, not as the internal user ID.
- Use canonical `delegate_id`.
- Store each verified address as an alias with provenance.
- Do not create a second delegate when the same human appears from a linked device.
- Do not assume that every JID/LID pair can be mapped automatically.
- If the library exposes alternate addressing fields, inspect current Baileys types/docs and capture them in a version-specific adapter.
- If alias mapping is ambiguous, require organizer verification.
- Do not impose “phone-only” as the default workaround unless operational tests show it is necessary.

## 4. `!draw`

Preconditions:
- Onboarding complete.
- All eligible teams approved.
- Group configuration validated.
- Organizer authorized.

Flow:
1. Bot shows the eligible team count and proposed group structure.
2. Organizer confirms draw configuration.
3. Backend snapshots participants.
4. Backend randomizes using a cryptographically secure unbiased algorithm.
5. Full assignment and reveal order are persisted transactionally.
6. Bot publishes draw-start message.
7. Bot reveals one team at a time, with group and progress.
8. Each successful reveal advances persisted index.
9. Restart resumes from next unrevealed team.
10. Final group list is published and draw marked complete.
11. Audit material and any organizer override are recorded.

No LLM is involved in random selection.

## 5. Fixture and schedule lifecycle

`SCHEDULED → READY → IN_PROGRESS → REPORT_PENDING → COMPLETED`

Alternative terminal/exception states:
- `WALKOVER`
- `DISPUTED`
- `CANCELLED`

Bot announces:
- Fixture ID.
- Teams.
- Stage/group/round.
- Scheduled kickoff.
- Host team.
- Reporting instructions.

Reschedule:
- Capture both delegates' agreement or organizer override.
- Update fixture schedule with audit event.
- Notify both teams.

## 6. Report collection and five-second debounce

For each inbound message:
1. Normalize event.
2. Deduplicate by provider message key.
3. Resolve group, sender, team, and reply context.
4. Attach to an active report session or create a provisional session.
5. Download media to VM media service using the approved Verax integration.
6. Store media metadata and hash.
7. Persist the message and media reference.
8. Set `debounce_due_at = now + 5 seconds`.
9. If another relevant message arrives before expiry, reset due time to five seconds after the latest message.
10. Worker claims session only after due time passes and no new version supersedes it.
11. Process all collected evidence as one logical batch.

A message from Team A must not reset Team B's unrelated report timer. A goalkeeper detail screenshot must attach to the correct game/series context.

## 7. Report extraction

1. Classify every image.
2. Detect missing primary evidence.
3. Extract score and player table from main result screenshot.
4. Extract single-player detail data from goalkeeper screenshot if present.
5. Detect goalkeeper visual cues.
6. Cross-link detail screenshot to the correct player row.
7. Run deterministic backend validation.
8. If ambiguous, create `NEEDS_REVIEW`; do not force a match.
9. Create report draft version.
10. Send concise summary and correction instructions.

## 8. Goalkeeper submission

Group Stage:
- Winning team's goalkeeper/delegate submits detail screenshot after match.
- Draw: no winning-team goalkeeper report under current rule.
- The detail image is supplementary to main result evidence.

BO3/BO5:
- Wait until series winner is known.
- Only the goalkeeper/delegate of series-winning team submits.
- Submit one individual detail screenshot for each game played in the series.
- Expected count equals number of games actually played.
- Link each screenshot to the corresponding game using score/result and stat fingerprint.
- Store raw DEFENSE and derived saves.
- Award eligibility follows the organizer's winner-only policy.

If a screenshot is missing, tell delegate which game number is missing. Do not silently treat another game's screenshot as a replacement.

## 9. Natural-language corrections

Example:
“player urutan 3 salah di umpan, umpannya seharusnya 6 bukan 9, btw ini yang salah tim Astra Lumina ya”

Interpretation steps:
1. Resolve active report/version from reply or explicit reference.
2. Resolve team `Astra Lumina`.
3. Resolve player ordinal 3 within the exact roster ordering used in the report.
4. Resolve metric `umpan` → `passes`.
5. Parse old value 9 and new value 6.
6. Check extracted value is actually 9.
7. If all unambiguous, stage patch.
8. Show proposed correction to authorized delegate/admin.
9. On confirmation, create new report version.
10. Reset all approvals.

If team, player ordering, or target report is ambiguous, ask one focused clarification.

## 10. Three-party approval

1. Bot displays one versioned report summary.
2. Team A delegate approves/rejects.
3. Team B delegate approves/rejects.
4. Organizer approves/rejects.
5. Only when all three approve same version does it become `LOCKED`.
6. Any correction creates a new version and resets approval status.
7. A rejected report returns to correction/dispute workflow.

## 11. AI failure and manual mode

- Bot explains that automated processing is unavailable.
- Bot instructs delegate to contact organizer.
- Organizer invokes admin-only `!manualreport` (provisional).
- Manual entry records values and evidence references.
- Same validation and three-party approval applies.
- Provenance is `MANUAL_ENTRY`.
- AI recovery does not automatically overwrite manual data.

## 12. Draw and bracket lifecycle

- Group draw complete → fixtures generated.
- Group Stage completed → standings computed from locked games.
- Tie-break procedure applied.
- Qualified teams inserted into bracket.
- KO fixture created with BO3 or BO5 configuration.
- Series ends when target game wins reached.
- Grand Final uses BO5.
- Champion and awards calculated from locked eligible data.

## 13. AI-native flows (D-037..D-040, 2026-11-22)

### 13.1 `!ai` Omak Peak (read-only chat)

1. Any participant (or delegate, or organizer) sends `!ai <question>` in the central group or DM.
2. Rate limiter checks rolling window: max 2 uses per sender per 60 seconds. On exceed, reply with retry-after hint. No state mutation.
3. Context builder gathers read-only DB state: active tournament, fixtures, standings, teams+delegates, qna entries, rules summary.
4. AI provider router executes CHAT_OMAK_PEAK task with the Omak Peak system prompt + trusted context + delimited user message.
5. Reply is sent. Truncated to 1800 chars if needed.
6. On AI failure: graceful fallback message (not a crash). On rate limit: explicit cooldown message.
7. NO write to tournament state ever occurs. The only persistence is the broad text capture of the inbound `!ai` message itself (AI-NATIVE-001, applies to all central-group TEXT messages).

### 13.2 `!agent` / `!agentconfirm` / `!agentcancel` (organizer AI agent)

**Plan staging (`!agent <instruction>`):**
1. Organizer sends `!agent <instruction>`.
2. Planner context built: active tournament, recent fixtures with IDs, action catalog (action_id + description + parameter shapes).
3. AI executes PLAN_AGENT task → returns JSON `{ actions: [{ action_id, params, rationale }] }`.
4. For each proposed action: backend validates action_id exists, params match Zod schema, preview() passes (no validation errors). Invalid actions reject the whole plan with a per-action error list.
5. On valid plan: generate unique plan_code (e.g. `AGENT-7F3K`), insert into `ai_action_plans` (status PENDING, expires_at = now + 10 min).
6. Reply with plan preview: per-action summary (old → new), plan_code, confirm/cancel instructions, TTL.

**Confirm & execute (`!agentconfirm <code>`):**
1. Load plan by plan_code.
2. Authorize: only the stager may confirm.
3. Status gate: if not PENDING, EXPLICITLY reject with prior outcome + timestamp (idempotency — double-confirm is rejected, not silently ignored). Expired plans are lazily flipped to EXPIRED.
4. Atomic claim: `UPDATE status='EXECUTING' WHERE plan_code=? AND status='PENDING' AND expires_at > now`. If affected rows = 0, lost the race — re-read and report actual state.
5. Open a libSQL transaction (`db.transaction('write')`). For each action: re-preview inside tx (catches races), then execute. If any action fails, rollback the entire transaction, mark plan FAILED with reason, record audit_event AI_AGENT_PLAN_FAILED, reply with failure message.
6. On success: commit, update plan status EXECUTED with execution_result_json, record audit_event AI_AGENT_PLAN_EXECUTED with before/after JSON, send post-commit side-effects (announce messages via sender).
7. Crash recovery: at app start, `recoverInterruptedPlans()` marks stale EXECUTING (older than 5 min) as FAILED.

**Cancel (`!agentcancel <code>`):** only PENDING plans can be cancelled; sets status CANCELLED.

### 13.3 `!qna` / `!saveqna` (living FAQ)

**`!qna` (any role):** list active qna_entries (newest first, max 50), formatted with Q/A/category.

**`!saveqna [n]` (organizer):**
1. Rate guard: 30-second cooldown between invocations.
2. Fetch last N (default 10, max 50) TEXT messages from central group in inbound_messages (broad capture AI-NATIVE-001).
3. Fetch existing qna_entries for dedup.
4. AI executes EXTRACT_QNA task → returns JSON `{ pairs: [{ question, answer, category, duplicate_of_existing }] }`.
5. Persist non-duplicate pairs via `INSERT OR IGNORE` (UNIQUE(question, answer) is the final guard).
6. Reply with summary: messages read, pairs inserted, duplicates skipped.

### 13.4 Engagement hooks (automatic)

- **KO series completion**: after the official result message is returned, a detached follow-up calls `EngagementService.buildHypeRecap(facts)` (non-FINAL) or `buildChampionCelebration(facts)` (Grand Final). Facts come from DB (series score, margin, round, champion path). AI formats presentation only. Silently skips if AI unavailable.
- **Group-stage report-lock hype**: designed but not yet wired (documented follow-up).
- **`!trivia` / `!quiz` / `!pantun`**: on-demand engagement commands; see PROMPT_CATALOG §12.
