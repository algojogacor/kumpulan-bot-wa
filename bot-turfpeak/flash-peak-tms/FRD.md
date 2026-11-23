# Functional Requirements Document (FRD)
## Flash Peak TMS

**Version:** 0.1.0-draft | **Date:** 18 November 2026

This document defines observable system behavior. The backend, not an LLM, enforces permissions, state transitions, score calculations, and official outcomes.

## 1. Requirement notation

- `MUST`: mandatory for MVP.
- `SHOULD`: strongly recommended.
- `MAY`: optional/configurable.
- Each requirement has an ID for traceability.

## 2. Identity, authorization, and group

### FR-ID-001 — Separate bot and organizer identities
The system MUST store the bot WhatsApp identity separately from the organizer's personal identity.

### FR-ID-002 — One delegate per team
Each registered team MUST have exactly one active delegate identity. Separate divisions are separate teams and may each have one delegate.

### FR-ID-003 — Canonical identity with aliases
The system MUST use an internal `delegate_id` as the stable identity. JID, LID, phone-address, and other observed WhatsApp identifiers are aliases linked to that delegate after verification. Never create a second delegate solely because the same person appears under a different JID/LID representation.

### FR-ID-004 — Identity ambiguity
An unknown or conflicting sender MUST be denied privileged actions and routed to organizer review. Do not infer authority from display name alone.

### FR-ID-005 — Group scope
Commands and reports MUST be accepted only in the configured central tournament group unless an explicitly documented private admin flow is implemented.

### FR-ID-006 — Reply context
During onboarding and report correction, the bot SHOULD require replies to the relevant bot prompt/report where that is needed to disambiguate the target.

## 3. Onboarding

### FR-ON-001 — Admin pre-registration
Organizer prepares team, division, roster, and delegate details through an admin workflow before group onboarding.

### FR-ON-002 — Trigger
Only the organizer may trigger `!onboarding`.

### FR-ON-003 — Sequential prompts
Bot MUST ask for one team/delegate at a time and associate replies with the current onboarding session. It must not assume that any arbitrary group message answers the current question.

### FR-ON-004 — Reply binding
The delegate must reply to the relevant bot prompt. The system records sender aliases and associates the sender with the pre-registered team.

### FR-ON-005 — Completion checks
Onboarding is complete only when every expected team has exactly one verified delegate and all required fields are complete.

### FR-ON-006 — Idempotency
Repeated `!onboarding` must resume or report current status; it must not create duplicate teams/delegates.

### FR-ON-007 — Multiple divisions
AVOID Eclipse, AVOID Prime, and AVOID Impact (example) are separate team records, each with its own delegate.

## 4. Roster

### FR-RO-001 — Roster cardinality
Each team MUST have five starters: one goalkeeper and four outfield players; zero to five substitutes; ten players maximum.

### FR-RO-002 — Nickname immutability
The registered in-game nickname MUST remain unchanged for the tournament. Changes require organizer policy handling; the system must not silently normalize the visible nickname.

### FR-RO-003 — Unicode preservation
Store the exact raw nickname as Unicode text. Keep derived normalized/search forms separately. Never replace symbols or confusable characters in the canonical display name.

### FR-RO-004 — Candidate matching
Similarity scores (including the proposed 70% threshold) MAY generate candidate matches only. They MUST NOT independently authorize player identity. Exact match or explicit human confirmation is required for ambiguous cases.

### FR-RO-005 — Player uniqueness
A player may belong to only one team in a tournament. Duplicate detection must use organizer review, not nickname alone.

### FR-RO-006 — Lineup validation
A match lineup requires five eligible players, including one goalkeeper, subject to the final game rules.

## 5. Competition and draw

### FR-COMP-001 — Supported formats
MVP MUST support traditional Group Stage and Knockout Stage only.

### FR-COMP-002 — Group draw trigger
Only organizer may trigger `!draw`; onboarding must be complete and group configuration valid.

### FR-COMP-003 — Randomization
Backend MUST use a cryptographically secure random source or a well-reviewed unbiased shuffle (e.g. Fisher–Yates with cryptographic random integers). LLMs must never decide draw outcomes.

### FR-COMP-004 — Persist before reveal
The full draw MUST be persisted before any reveal message is sent.

### FR-COMP-005 — Progressive reveal
Bot reveals one team at a time, with progress. A reconnect resumes the reveal from stored state.

### FR-COMP-006 — No reroll on retry
Retrying a failed message or restarting the process MUST NOT randomize again.

### FR-COMP-007 — Audit
Store input team snapshot, group config, algorithm/version, commitment/hash, seed handling, result, reveal order, timestamps, and organizer overrides.

### FR-COMP-008 — Bracket validation
Before draw, backend validates that group count, group sizes, qualification slots, byes, and bracket size produce a valid competition. Invalid combinations require organizer configuration.

### FR-COMP-009 — Open registration, no cap
The system MUST accept every team that completes registration/onboarding with the bot; there is no maximum team count and no minimum required to begin, beyond what bracket validation (FR-COMP-008) requires to form a valid Knockout bracket from the qualifiers.

### FR-COMP-010 — Group sizing with remainder
Groups are formed in batches of 5 teams. If total team count is not evenly divisible by 5, the remainder is absorbed by sizing the final groups at 4 instead of 5 (e.g. 23 teams → four groups of 5 and one group of... correction: 23 → 5+5+5+4+4 = 24 is wrong arithmetic from the organizer's own example; the backend must compute this programmatically from actual registered count, not hardcode the example). Group sizes used MUST only be 5 or 4; never form a group smaller than 4 or larger than 5.

### FR-COMP-011 — Fixed qualifiers per group regardless of size
Exactly 2 teams qualify to Knockout Stage from every group, whether that group has 5 teams or 4 teams. Qualifier count MUST NOT scale with group size.

### FR-COMP-012 — Round-robin within group
Every team in a group plays every other team in that same group exactly once (single round-robin): 4 games per team in a 5-team group, 3 games per team in a 4-team group.

### FR-COMP-013 — Balanced left/right side assignment (host fairness)
Because the fixture's left-side team is the default recommended room host (FR-FIX-005), fixture generation MUST balance how often each team is assigned the left side across its own group-stage fixtures, so no single team is disproportionately expected to host (or disproportionately gets to sit on the right side and never host) across the Group Stage. Within a round-robin group, a standard round-robin scheduling algorithm (e.g. circle method) MUST alternate/rotate each team's side assignment across its fixtures rather than fixing one team to always-left or always-right. For an odd number of fixtures for a given team (e.g. 3 games in a 4-team group), the side count differs by at most one (e.g. 2 lefts/1 right or 1 left/2 rights), never a 3/0 split. Side assignment is generated once at fixture-generation time and is part of the fixture record (FR-FIX-001), not re-randomized per match. Knockout fixtures are single-elimination pairings generated from bracket seeding and are not required to balance side assignment the same way, since each team typically plays few KO fixtures and bracket position already determines pairing; but a left/right assignment is still stored per KO fixture for host-default purposes (FR-FIX-005).

## 6. Fixtures and scheduling

### FR-FIX-001
Each fixture has a stable ID, stage, group/round, participating teams, scheduled time, host, and status.

### FR-FIX-002
Default timezone is `Asia/Jakarta` (WIB). Store timestamps in UTC and preserve the tournament timezone for display.

### FR-FIX-003
Kickoff 21:00 WIB, confirmation deadline 20:00 WIB, eight-minute game, and ten-minute grace period are proposed configurable defaults, not hard-coded constants.

### FR-FIX-004
Rescheduling requires both delegates' agreement or organizer override and an audit record.

### FR-FIX-005 — Room host assignment and forfeit
Default room host recommendation is the fixture's left-side team; this is advisory, not a strict requirement. Which team is assigned "left" for a given fixture is determined at fixture-generation time under the balancing rule in FR-COMP-013 — it is not freely chosen by either delegate at match time. If the designated host has no room card but the opposing team is willing to host instead, the match proceeds normally with the opposing team hosting. If the opposing team is unwilling to host in that situation, the opposing team wins the match by forfeit (the team that could not host, and whose opponent declined to step in, loses).

### FR-FIX-006 — Double room-card unavailability
If BOTH teams in a fixture are unable to provide a room card (neither the designated host nor a willing substitute host exists):
- Group Stage: record as a double walkover — zero points to both teams, no player statistics recorded. This is distinct from a genuine in-game draw (which still earns 1 point each per existing draw policy) because no game was actually played.
- Knockout (BO3/BO5): BOTH teams are declared losers (double loss, revised 20 Nov 2026; previously mandatory reschedule). The fixture cannot be resolved as a draw because "no drawn series" applies in KO, and no fair administrative winner exists — so both teams lose and the team scheduled to meet the winner of this fixture in the next round advances automatically without playing (bye). No player statistics are recorded.

## 7. Report ingestion and debounce

### FR-ING-001 — Event capture
Capture message ID/key, chat ID, sender raw identifier, participant identifier, message timestamp, received timestamp, text, caption, reply context, media type, media metadata, and media reference.

### FR-ING-002 — Per-session buffer
Debounce MUST be scoped to a report session/fixture/team/game context, never a global timer.

### FR-ING-003 — Five-second quiet window
After each relevant incoming message, set `debounce_due_at = now + 5 seconds`. Any new relevant message resets it to five seconds after that latest message.

### FR-ING-004 — Durable timer
Store debounce state in durable storage or a durable job queue. Process restart must not lose pending batches.

### FR-ING-005 — Atomic close
Only one worker may close and process a given batch. Use a lock/lease or atomic state transition.

### FR-ING-006 — Deduplication
Duplicate WhatsApp events must be idempotently ignored using a stable message key.

### FR-ING-007 — Late evidence
Evidence arriving after initial batch processing must be attached to the existing open report session where context matches. It must not silently create a second official report.

### FR-ING-008 — Session expiry
An incomplete report session must eventually be marked `INCOMPLETE` or `EXPIRED` under configurable base-window policy (organizer-suggested starting point: 10 minutes). A new dispute/objection arriving within the current window extends that window by the same base duration. This extension is capped at 3 occurrences per report session. After the 3rd extension, the session closes under expiry policy regardless of further incoming objections, and any subsequent dispute is routed to organizer manual review rather than triggering a 4th extension.

### FR-ING-009 — Batch payload
Batch includes all relevant text, captions, media, sender identity, reply references, timestamps, fixture hints, and message IDs.

## 8. Image classification and extraction

### FR-AI-001
Classify each image as main match summary, individual player detail, unrelated/unknown, or unreadable.

### FR-AI-002
Main match summary is primary evidence. Individual detail screenshot is supplementary and cannot independently create a complete match report.

### FR-AI-003
Preserve raw OCR/vision values and confidence/evidence references.

### FR-AI-004
Missing or uncertain values remain null/unknown. Never invent or silently infer.

### FR-AI-005
Validate numeric ranges, score consistency, player counts, team mapping, and roster membership in deterministic backend code.

### FR-AI-006
Do not infer team identity from screenshot left/right position alone unless the report's perspective and main screenshot establish the mapping.

### FR-AI-007
A report may proceed to review only when required evidence is present and validation passes, or when explicitly routed to manual review.

## 9. Goalkeeper-specific requirements

### FR-GK-001 — Visual cue
The goalkeeper detail screen is a one-player Individual Player Detail view. Recognizable cues from the supplied sample include a cap, goalkeeper gloves, and a ball held in front of the abdomen/chest. Use these cues as supporting classification evidence.

### FR-GK-002 — No visible nickname
The supplied detail screen contains no nickname or UID. Do not claim that it identifies the account directly.

### FR-GK-003 — Summary metric mapping
For the goalkeeper, map the summary `DEFENSE` value to `goalkeeper_saves` per organizer rule. Preserve both:
- `raw_defense_value`
- `goalkeeper_saves`

### FR-GK-004 — No all-tabs requirement
MVP does not require opening all detail tabs. The sample showed SHOOTING active; UMPAN, DEFENSE, POSSESSION detail-tab contents were not visible. The summary `DEFENSE` metric is the MVP source for saves.

### FR-GK-005 — Caption-based identification (replaces cross-screen statistical matching)
Every goalkeeper detail submission's message text/caption MUST include the goalkeeper's nickname (example format: "FOTO 1 HX KINGrajj"). Caption text is matched against the submitting team's roster using approximate/fuzzy text matching — an exact match to the registered nickname is NOT required, only enough similarity to resolve to a single roster entry.
Because only the goalkeeper/delegate of the series-winning team ever submits (FR-GK-006), the caption is never used to determine which team is associated with the screenshot — team identity is already fixed by submission policy. The caption's sole purpose is to resolve WHICH goalkeeper within that team's roster the screenshot belongs to, which matters only when a team has more than one registered goalkeeper (e.g. starter plus substitute keeper). If fuzzy matching against the submitting team's roster does not resolve to a unique goalkeeper, request manual confirmation from the submitting delegate; do not fall back to statistical cross-matching against the main match screenshot.

### FR-GK-006 — Submission
Only the goalkeeper/delegate of the winning team in Group Stage submits goalkeeper detail evidence. For BO3/BO5, only the goalkeeper/delegate of the series-winning team submits, after series completion — one screenshot per individual game WON by that team within the series.

### FR-GK-007 — Count expected
Expected detail screenshot count equals the series' required winning-game count, NOT the number of games actually played:
- BO3: always 2 (win games only; the series always ends at 2 wins for the winner, whether the loser won 0 or 1 games).
- BO5: always 3 (win games only; regardless of whether the series ended 3–0, 3–1, or 3–2).
A count equal to total games played (e.g. 3 for a 2–1 BO3) is INCORRECT and must be rejected by this spec; implementers should not generalize from "games played" but from "games won by the submitting team."

### FR-GK-008 — Award eligibility
Because only won games are ever submitted (FR-GK-006/007), every stored goalkeeper detail record is award-eligible by construction. There is no "retained but ineligible" state under this corrected policy — the prior draft's premise (screenshots from lost games being retained but flagged ineligible) does not apply, since lost-game screenshots are never submitted in the first place.

### FR-GK-009 — Identity fallback
If the visual goalkeeper cue (FR-GK-001) is not confidently present, or the caption does not resolve to a unique goalkeeper on the submitting team's roster (FR-GK-005), do not assign the record automatically — request manual confirmation from the submitting delegate.

## 10. Corrections and contextual understanding

### FR-COR-001
The system must maintain report context across multiple messages using explicit persisted state, not implicit LLM conversational memory.

### FR-COR-002
A natural-language correction can refer to a player by roster order, nickname, team, or combination of clues.

### FR-COR-003
Correction parser outputs a structured patch containing target report/version, team, player, metric, old value if stated, new value, reason, and ambiguity flags.

### FR-COR-004
A correction such as “player urutan 3 salah di umpan, seharusnya 6 bukan 9, yang salah tim Astra Lumina” must resolve team first, then player ordinal within that team's defined ordering, then metric and replacement.

### FR-COR-005
If “urutan 3” could refer to more than one list or if team is unclear, ask a clarification. Do not guess.

### FR-COR-006
The backend verifies sender authority and applies validated patches to a new draft version.

### FR-COR-007
Keep original extraction, all correction messages, parsed patches, accepted/rejected state, and version history.

## 11. Approvals

### FR-APR-001
Each report version requires Team A delegate, Team B delegate, and organizer approval.

### FR-APR-002
Approvals are tied to immutable report version IDs.

### FR-APR-003
Any accepted correction creates a new version and resets all approvals.

### FR-APR-004
Only organizer may lock, reopen, or override a report, with reason and audit event.

## 12. Competition calculations

### FR-CALC-001
Group Stage points: win 3, draw 1, loss 0.

### FR-CALC-002
Proposed tiebreak order: points, goal difference, goals scored, head-to-head points, head-to-head goal difference, head-to-head goals scored, then playoff/organizer procedure.

### FR-CALC-003
BO3 winner is first to two game wins. BO5 winner is first to three.

### FR-CALC-004
A tied individual KO game is not a series win and is replayed. The replay's result is added into the existing series score — it does NOT create a new game record outside the series' win count. Example: series standing 2–1 (best of 5), next game ties, is replayed, and the replay's winner brings the series standing to 3–1 — the tied game itself is not counted as one of the games toward either team's win total, only the replay's decisive result is.

### FR-CALC-005
Store each individual game score separately from series score. A replayed tied game and its replacement share the same `game_number` slot in the series (the tie does not consume a numbered slot of its own); only the decisive replay result is persisted as that slot's official result.

### FR-CALC-006
Walkovers do not generate player statistics.

### FR-CALC-007
Standings and awards are derived from approved/locked records only.

## 13. Failure and manual mode

### FR-FAIL-001
Provider timeout, rate limit, invalid response, unsupported image, and network error must be distinguishable in logs.

### FR-FAIL-002
When AI processing is unavailable, bot informs participants and directs them to organizer.

### FR-FAIL-003
Admin-only manual report command (provisional `!manualreport`) creates a manual draft.

### FR-FAIL-004
Manual data undergoes same business validation, evidence linking, and approvals.

### FR-FAIL-005
Manual provenance is stored as `MANUAL_ENTRY`.

## 14. Acceptance criteria

MVP is accepted only if:
- Onboarding maps each delegate to exactly one registered team.
- A second device/JID/LID representation does not create a duplicate delegate.
- A random draw is persisted before reveal and never rerolled after restart.
- Every new report message resets the correct five-second debounce timer.
- Simultaneous reports from two teams remain isolated.
- Duplicate message delivery creates no duplicate evidence.
- Main and detail screenshot types are distinguished.
- Goalkeeper saves are mapped from summary DEFENSE without confusing the hidden DEFENSE tab.
- Ambiguous detail-to-player linking requires human review.
- Correction context is maintained across separate messages and team references.
- Approval invalidation works after corrections.
- Provider failure reaches manual mode.
- VM media references remain verifiable by hash.
- Every official result can be traced to evidence, extraction, corrections, approvals, and final lock.
