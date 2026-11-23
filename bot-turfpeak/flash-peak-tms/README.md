# Flash Peak Tour Management System (Flash Peak TMS)

**Documentation baseline:** `0.1.1-draft`  
**Prepared:** 18 November 2026 (revised same day — see `MANIFEST.json` changelog)  
**Status:** Engineering handoff draft; organizer decisions resolved — see `DECISIONS.md` section D for the full list of resolved open items.

Flash Peak TMS is a WhatsApp-group-operated tournament administration system. It manages team onboarding, roster validation, fixtures, group draws, match reports, screenshot-based statistics extraction, corrections, three-party approvals, standings, knockout series, awards, and manual fallback.

## Read this first

1. `PRD.md` — product scope and goals.
2. `FRD.md` — functional requirements and acceptance criteria.
3. `COMPETITION_RULES.md` — competition rules and configurable defaults.
4. `WORKFLOWS.md` — state machines and end-to-end flows.
5. `AI_PIPELINE.md` and `PROMPT_CATALOG.md` — image extraction, goalkeeper interpretation, correction parsing, and prompt contracts.
6. `DATA_MODEL.md` — Turso/libSQL data model.
7. `ARCHITECTURE.md` and `INFRASTRUCTURE.md` — runtime and VM/media integration.
8. `AGENT.md` and `SWARM_PLAN.md` — mandatory coding-agent instructions and swarm coordination.
9. `TESTING.md` — test and evaluation requirements.
10. `DECISIONS.md` — accepted baseline, assumptions, and unresolved organizer decisions.

## Authority and precedence

- The organizer's explicit decisions in `DECISIONS.md` override proposed defaults.
- `COMPETITION_RULES.md` is the source of truth for tournament rules after organizer approval.
- `FRD.md` is the source of truth for observable system behavior.
- `DATA_MODEL.md` is the source of truth for persistent data semantics.
- If documents conflict, stop implementation of the conflicting behavior and raise the conflict. Do not silently choose.
- This package is a draft. It is not permission to publish rules to participants without organizer approval.

## Current key decisions

- MVP competition formats: traditional Group Stage and Knockout Stage only. No Swiss format in MVP.
- Group allocation is randomized by the bot through an organizer-triggered `!draw`, revealed one team at a time.
- Team roster: five starters (one goalkeeper + four outfield players), plus zero to five substitutes; maximum ten.
- One official WhatsApp delegate per registered team/division.
- WhatsApp bot number and organizer's personal number are separate identities.
- Match evidence is submitted in a central WhatsApp group.
- The main match-result screenshot is the primary evidence. The goalkeeper Individual Player Detail screenshot is supplementary and contains one player's statistics only.
- Goalkeeper avatar visual cues: cap, goalkeeper gloves, and a ball held in front of the abdomen/chest. This is a visual classification cue, not an identity credential.
- The goalkeeper's summary `DEFENSE` value is interpreted as saves, per organizer rule. Preserve the original raw field and value.
- Goalkeeper evidence is submitted by the goalkeeper/delegate of the series-winning team after the BO3/BO5 series concludes, with exactly one detail screenshot per game WON (BO3 always 2, BO5 always 3) — never per game actually played. Every submitted record is award-eligible by construction. Identity is resolved via a nickname typed in the message caption (fuzzy-matched against that team's roster), not by comparing statistics against the main match screenshot.
- Registration is open with no cap on team count. Groups are sized in batches of 5, with remainder groups sized 4; every group — any size — sends exactly its top 2 teams to Knockout Stage.
- Room host defaults to the fixture's left-side team as a recommendation only; if that team can't host and the opponent won't substitute, the opponent wins by forfeit. If both teams can't provide a room card, Group Stage records a double walkover (0 points each) and Knockout declares BOTH teams losers (double loss, revised 20 Nov 2026) — the next-round pairing of that fixture then advances automatically via a bye.
- A five-second sliding quiet-window debounce collects messages and media before processing. Every new message resets the timer to five seconds.
- Database: Turso/libSQL. Images are stored in a Flash Peak-dedicated media service that follows the architectural pattern of the existing Verax media service but runs as a fully separate instance (own storage path, own metadata database) — tournament evidence must never share storage with Verax editorial media.
- AI is an assistive extractor, never the authority for official results. Corrections and approvals remain explicit.
- If AI providers are unavailable, report the failure and route the delegate to the organizer's manual process.

## AI-native expansion (2026-11-22, D-037..D-040)

The system now includes AI-native participant- and organizer-facing features:

- `!ai <question>` — **Omak Peak**, a read-only AI assistant for any group participant. Open-scope (turnamen, Flash Peak, casual chat), santai persona, rolling-window rate limit (2/min/user). Delegate contacts shareable per the tournament's open-communication norm; internal system data is never exposed.
- `!agent <instruction>` / `!agentconfirm <code>` / `!agentcancel <code>` — **organizer AI agent**: turns natural-language instructions into a typed action plan from a closed catalog (reopen, override-lock, forfeit/WO, reschedule, cancel, set-tournament-status, record-KO-score, announce). Explicit confirm-by-code, idempotent (double-confirm explicitly rejected), transactional execution (all-or-nothing), full audit trail, crash recovery. Replaces the manual SQL UPDATE previously used to pause the tournament.
- `!qna` — living FAQ list (any role). `!saveqna [n]` (organizer) — AI extracts Q&A pairs from the last N group messages.
- `!trivia` — random verified Flash Peak fact (curated DB, AI rephrases only). `!quiz` — quiz with delayed answer reveal.
- `!pantun` — AI-generated Flash-Peak-themed pantun (no factual claims).
- **Engagement hooks**: hype recap after KO series completion; champion celebration on Grand Final completion — grounded in real DB facts, AI formats presentation only.

See `DECISIONS.md` D-037 through D-040 for the full confirmed design. New tables: `ai_action_plans`, `qna_entries` (migration 004). `provider_usage.task_type` CHECK expanded for the new AI tasks.

## Research notes

Prompt design in this package follows current official guidance: clear instruction hierarchy, separated context and untrusted inputs, explicit output schemas, examples, and repeatable evaluation. See:
- OpenAI prompt engineering: https://developers.openai.com/api/docs/guides/prompt-engineering
- OpenAI Structured Outputs: https://developers.openai.com/api/docs/guides/structured-outputs
- Google multimodal prompt design: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/design-multimodal-prompts
- Google prompt design strategies: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/prompts/prompt-design-strategies

Baileys is an unofficial, reverse-engineered WhatsApp Web library and is not affiliated with WhatsApp. The official WhiskeySockets repository currently documents a major v7 breaking-change notice; npm/release state must be rechecked when implementation begins. See `AGENT.md` and:
- https://github.com/WhiskeySockets/Baileys
- https://baileys.wiki/
- https://github.com/WhiskeySockets/Baileys/releases
