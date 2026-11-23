# Architecture Decisions Register (ADR) — Flash Peak TMS

**Document Version:** 1.0.0  
**Project:** Flash Peak Tournament Management System (Flash Peak TMS)  
**Authoritative Standard:** AGENTS.md §14, DECISIONS.md §A–E

This document records the definitive architectural decisions (D-001 through D-034) and organizer policy resolutions (O-001 through O-015) implemented across the Flash Peak TMS codebase.

---

## Part 1: Confirmed Architecture Decisions (D-001 to D-034)

| ID | Title / Decision | Rationale | Implementation Location |
| :--- | :--- | :--- | :--- |
| **D-001** | Automated Flash Peak TMS via WhatsApp | WhatsApp is the native communication medium for competitive mobile football communities in Indonesia. Avoids requiring custom app installs. | `src/whatsapp/connection.ts`, `src/index.ts` |
| **D-002** | Marketing & PR Separation | Operational bot focuses purely on authoritative tournament lifecycle; promotional content is handled out-of-band by organizers. | `src/whatsapp/router.ts` |
| **D-003** | Pre-registration + Guided Onboarding | Organizers upload team & player rosters; delegates claim operational binding sequentially to prevent unauthorized impersonation. | `src/identity/onboarding.ts` |
| **D-004** | One Official Delegate per Team/Division | Prevents competing claims. Multi-division clans must register distinct phone numbers for each team division. | `src/identity/resolver.ts` |
| **D-005** | Distinct Bot & Organizer Numbers | Separates bot automated messages from organizer human escalation, preserving trust and rate limits. | `src/whatsapp/router.ts`, `.env.example` |
| **D-006** | Central WhatsApp Group Scope | Commands and match reports are scoped to the official tournament group (`centralGroupJid`) to prevent unauthorized DM interactions. | `src/whatsapp/router.ts` |
| **D-007** | Sequential Onboarding (`!onboarding`) | Bot prompts one team at a time; delegate must quote/reply directly to bind their phone/JID. | `src/identity/onboarding.ts` |
| **D-008** | Traditional Groups + Knockout (Swiss Deferred) | Simplifies tournament operations for community managers while providing standard competitive integrity. | `src/competition/draw.ts`, `src/competition/fixtures.ts` |
| **D-009** | Group Stage Valid Draws (3/1/0 Points) | Matches standard football group points model: Win = 3, Draw = 1, Loss = 0. | `src/competition/standings.ts` |
| **D-010** | Knockout BO3 / Grand Final BO5 | Best of 3 before finals (first to 2 wins); Best of 5 for Grand Final (first to 3 wins). | `src/competition/series.ts` |
| **D-011** | Series Target Wins Definition | BO3 requires first to 2 game wins; BO5 requires first to 3 game wins. | `src/competition/series.ts` |
| **D-012** | 5 Starters (1 GK + 4 Outfield) + up to 5 Subs | Strictly enforces in-game lineup rules: 5 players per team in every match. | `src/reports/validation.ts` |
| **D-013** | Immutable Nicknames During Tournament | Registered in-game Unicode nicknames cannot be modified mid-tournament to prevent ringer substitutions. | `src/reports/validation.ts` |
| **D-014** | Screenshot-Based Match Reporting | Primary evidence is in-game match summary scoreboard image uploaded by delegates. | `src/ingestion/capture.ts`, `src/ai/classifier.ts` |
| **D-015** | Goalkeeper Detail as Supplementary Screen | Goalkeeper individual detail view is captured as secondary proof for saves and award eligibility. | `src/ai/extractors/goalkeeper.ts` |
| **D-016** | Goalkeeper Visual Avatar Cues | Visually grounded in cap, goalkeeper gloves, and ball held in front of abdomen/chest. | `src/ai/extractors/goalkeeper.ts` |
| **D-017** | Goalkeeper Saves Mapped from DEFENSE | Summary scoreboard `DEFENSE` column is mapped authoritatively to `goalkeeper_saves`. | `src/reports/stats.ts`, `src/reports/validation.ts` |
| **D-018** | Winner-Only Goalkeeper Submission | In Group Stage and KO, only the winning team's goalkeeper/delegate submits detail screenshots after the match/series. | `src/ai/extractors/gk-identity.ts` |
| **D-019** | Goalkeeper Award Limited to Won Matches | Award eligibility (`is_award_eligible = 1`) is strictly granted to won games to avoid non-neutral sample skew. | `src/reports/stats.ts`, `src/stats/awards.ts` |
| **D-020** | 5-Second Sliding Quiet Window Debounce | Incoming evidence messages reset the session timer to `now + 5s`, allowing multiple screenshots to arrive cleanly in one batch. | `src/ingestion/debounce.ts` |
| **D-021** | Dedicated Media Service (Verax Pattern) | Replicates Verax architecture (storage tree, metadata sidecar, HMAC tokens), but runs on dedicated port 4188 and path `/var/lib/flashpeak/media` without commingling with editorial files. | `services/flashpeak-media/`, `src/media/client.ts` |
| **D-022** | Turso / libSQL Relational Database | Edge-ready SQLite dialect with strong foreign key enforcement, migrations, and transactional integrity. | `src/db/client.ts`, `migrations/001_initial.sql` |
| **D-023** | AI Failure Notification & Manual Fallback | Failures never guess numbers or halt matches; users are directed to organizer for `!manualreport`. | `src/whatsapp/failure.ts`, `src/reports/manual.ts` |
| **D-024** | Comprehensive Markdown Specs & Swarm Plan | All domain requirements traced to PRD, FRD, and ADR for multi-agent reproducibility. | `docs/`, `flash-peak-tms/` |
| **D-025** | Pinned Baileys Stable v6 Line | Selected `@whiskeysockets/baileys@6.7.24` to ensure account safety, exponential reconnect, and avoid experimental v7 regressions. | `docs/BAILEYS_RESEARCH.md`, `package.json` |
| **D-026** | Open Registration Uncapped Team Count | Accepts any number of pre-registered teams; group sizing absorbs any total dynamically. | `src/competition/draw.ts` |
| **D-027** | Group Sizing Batches of 5, Remainder 4 | Groups sized 5 with remainder groups sized 4. Minimum 8 teams (2 groups of 4). Top 2 advance. | `src/competition/draw.ts` |
| **D-028** | Tied KO Game Replayed & Added to Series Score | Drawn individual KO games are replayed; replay result is merged into the series win count without creating standalone extra slots. | `src/competition/series.ts` |
| **D-029** | Room Host Advisory: Left-Side Default | Fixture's left-side team is recommended host; substitute allowed; refusal to host grants opponent forfeit. | `src/competition/fixtures.ts`, `src/competition/walkover.ts` |
| **D-030** | Goalkeeper Caption Fuzzy Matching | GK identity resolved solely via caption text fuzzy match against submitting team roster. Vector stat matching strictly prohibited. | `src/ai/extractors/gk-identity.ts` |
| **D-031** | Group Stage Double Room Unavailability = Double WO | If neither team can provide a room card, 0 points each and 0 stats recorded (distinct from in-game 1-1 draw). | `src/competition/walkover.ts` |
| **D-032** | KO Double Room Card Unavailability = Double Loss (bye) | KO requires decisive winner ("no drawn series"); with both sides failing, both teams lose and the next-round pairing advances via automatic bye. [Revised 20 Nov 2026 — replaces prior reschedule ruling.] | `src/competition/walkover.ts` |
| **D-033** | Report Session Expiry Extension Capped at 3 | Objections within window extend session by base duration, capped at 3 extensions before organizer review. | `src/ingestion/session.ts` |
| **D-034** | Balanced Group Stage Left/Right Host Count | Fixture generator circle method ensures team host count differs by at most 1 across all group games. | `src/competition/fixtures.ts` |
| **D-035** | Unregistered Player Policy ("Pemain Gelap") | Winning/drawing team fielding unregistered player: victory voided, overturned to WO 3-0 for opponent upon 2-party consensus. Losing team fielding unregistered player: actual score stands to protect innocent winner's GD & GF, unregistered player marked INELIGIBLE (is_award_eligible = 0). | `src/reports/validation.ts`, `src/reports/stats.ts` |

---

## Part 2: Organizer Policy Resolutions (O-001 to O-015)

| ID | Issue / Topic | Authoritative Resolution | Code Realization |
| :--- | :--- | :--- | :--- |
| **O-001** | Goalkeeper Screenshot Submission Count | BO3 winner submits 2 screenshots (games won); BO5 winner submits 3 screenshots. Lost games are omitted by policy. | `src/reports/stats.ts` |
| **O-002** | Match Duration & Kickoff Defaults | Game duration is confirmed 8 minutes. 21:00 WIB kickoff and 20:00 confirmation deadline are configurable defaults. | `src/shared/types/index.ts` |
| **O-003** | Group Sizing Combinatorics | Enforces 5-team batches with 4-team remainder groups. Requires >= 8 registered teams; rejects totals < 8 explicitly. | `src/competition/draw.ts` |
| **O-004** | Group Qualification Count | Exactly top 2 teams in every group advance to Knockout Stage regardless of group size (5 or 4). | `src/competition/standings.ts` |
| **O-005** | Knockout Tied Games | Replayed in-game; replay winner takes the game win. Series score increments towards target wins. | `src/competition/series.ts` |
| **O-006** | Group Stage Round-Robin Scope | Single round-robin: every team plays every other team in its group exactly once. | `src/competition/fixtures.ts` |
| **O-007** | Room Host Selection | Advisory left-side host recommendation; opponent substitution permitted; forfeit on refusal. | `src/competition/fixtures.ts` |
| **O-008** | Group Tie-Breaker Order | 1. Points, 2. Goal Difference, 3. Goals For, 4. Head-to-Head Points, 5. H2H GD, 6. H2H GF, 7. Playoff. | `src/competition/standings.ts` |
| **O-009** | Walkover Scores | Group Stage WO = 3–0 (3 pts to winner); Double WO = 0–0 (0 pts each, no stats); KO forfeit = 0–2 or 0–3. | `src/competition/walkover.ts` |
| **O-010** | Multi-Provider Rotation | Free-tier rotation across Gemini, Groq, and Ollama Cloud with circuit breakers and rate limits. | `src/ai/router.ts` |
| **O-011** | Dedicated Media Service Instance | Dedicated Flash Peak media storage on port 4188 (`flashpeak-media`); completely segregated from Verax editorial media. | `services/flashpeak-media/` |
| **O-012** | Session Expiry Duration & Extensions | Base 10-minute quiet window, auto-extended up to 3 times on incoming disputes, then escalated to organizer. | `src/ingestion/session.ts` |
| **O-013** | Tournament Awards Formula | Single defining metric ranking (no weighted/composite formulas). Exact ties result in co-winners. | `src/stats/awards.ts` |
| **O-014** | Three-Party Report Consensus | Approvals require Team A delegate, Team B delegate, and Organizer before transition to `LOCKED`. | `src/reports/approval.ts` |
| **O-015** | Odd/Variable Team Count Handling | Programmatic group sizing absorbs remainder teams into 4-team groups. Top 2 advance from each. | `src/competition/draw.ts` |
