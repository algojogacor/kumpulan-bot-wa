# AGENTS.md — Mandatory Instructions for Coding Agents
## Flash Peak TMS

*Read this file before inspecting or modifying the project.*
This repository is developed using a multi-agent / swarm workflow.

This file covers behavior and constraints that apply to nearly every session,
regardless of which feature or module you're working on. Domain-specific
decisions, rules, and implementation details live in their own documents —
read those only when your task actually touches that area. If this file and a
domain document conflict, stop and report it; do not silently pick a version.

---

## Core Behavioral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes.

*Tradeoff:* These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

*Don't assume. Don't hide confusion. Surface tradeoffs.*

Before implementing:
•  State your assumptions explicitly. If uncertain, ask.
•  If multiple interpretations exist, present them - don't pick silently.
•  If a simpler approach exists, say so. Push back when warranted.
•  If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

*Minimum code that solves the problem. Nothing speculative.*

•  No features beyond what was asked.
•  No abstractions for single-use code.
•  No "flexibility" or "configurability" that wasn't requested.
•  No error handling for impossible scenarios.
•  If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

*Touch only what you must. Clean up only your own mess.*

When editing existing code:
•  Don't "improve" adjacent code, comments, or formatting.
•  Don't refactor things that aren't broken.
•  Match existing style, even if you'd do it differently.
•  If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
•  Remove imports/variables/functions that YOUR changes made unused.
•  Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

*Define success criteria. Loop until verified.*

Transform tasks into verifiable goals:
•  "Add validation" → "Write tests for invalid inputs, then make them pass"
•  "Fix the bug" → "Write a test that reproduces it, then make it pass"
•  "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]


Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

*These guidelines are working if:* fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

## 0. Mission

Build Flash Peak TMS: a WhatsApp-first tournament management application. It is
not a game bot and must not attempt to control or reverse-engineer the Flash
Peak game client.

The backend is authoritative. LLMs are evidence extractors and language
interpreters only — no business rule may exist only in an LLM prompt.

## 1. Document index — read only what your task needs

Don't read everything up front. Read the document relevant to the area
you're touching, and re-check it even if you think you already know it —
these documents change as decisions evolve, this file does not.

| If your task touches... | Read |
|---|---|
| Product/feature requirements | PRD.md, FRD.md |
| Competition/tournament rules (grouping, knockout, host assignment, WO, etc.) | COMPETITION_RULES.md, DECISIONS.md |
| System structure, module boundaries | ARCHITECTURE.md |
| Database schema, tables, fields | DATA_MODEL.md |
| End-to-end flows (draw → evidence → approval → lock, etc.) | WORKFLOWS.md |
| AI provider routing, prompts, extraction pipeline | AI_PIPELINE.md, PROMPT_CATALOG.md |
| Goalkeeper identification, screenshot evidence rules | COMPETITION_RULES.md §Goalkeeper, AI_PIPELINE.md |
| Debounce / evidence batching behavior | WORKFLOWS.md §Debounce |
| Draw/randomization mechanics | WORKFLOWS.md §Draw |
| Corrections, approvals, locking | WORKFLOWS.md §Corrections |
| Manual fallback / AI outage handling | WORKFLOWS.md §Manual Fallback, DECISIONS.md |
| Deployment, VM, PM2, media storage | INFRASTRUCTURE.md |
| Testing conventions, fixtures | TESTING.md |
| Multi-agent/swarm coordination for a given task | SWARM_PLAN.md |

If a document you need doesn't exist yet or is silent on your question, stop
and ask — do not invent a rule silently. If what you find in a document
contradicts what you observe in the actual running code, stop and report the
conflict before proceeding.

## 2. Baileys documentation and repository — mandatory research gate

Baileys changes over time and has breaking releases. **Do not implement from
memory or stale tutorials, and do not trust any snapshot date in this
repository's docs as current — always re-check at implementation time.**

Before writing WhatsApp integration code:

1. Identify the official/current repository: https://github.com/WhiskeySockets/Baileys.
2. Inspect the latest repository state, release tags, changelog, migration guide, current README, TypeScript types, examples, and official guide at https://baileys.wiki/.
3. Check the current npm package tags and published version.
4. Check whether the latest version is stable, release candidate, beta, or edge.
5. Read the migration guide for any major version change.
6. If current Baileys documentation is not already available locally, clone the official repository into the project root under:
   ./vendor/baileys-reference/
   Use a shallow clone for disk efficiency, but record the exact commit SHA and tag inspected. Example:
   git clone --depth 1 https://github.com/WhiskeySockets/Baileys.git vendor/baileys-reference
7. Also obtain the current official docs repository/guide if needed. Keep reference materials in vendor/ or a clearly named reference directory at project root.
8. Treat cloned source/docs as a reference, not as application source. Do not modify the reference clone to make application code compile.
9. Record the research date, commit SHA, tag, package version, stability status, and source links in docs/BAILEYS_RESEARCH.md.
10. Pin the chosen dependency version in the lockfile. Do not use a floating dependency in production.
11. If the newest release is a release candidate and the stable release is behind, compare both. Prefer stable for MVP unless a documented required feature/fix justifies the RC and the organizer accepts the risk.
12. Re-check the upstream repository before production release.

Baileys is not an official WhatsApp API and is not affiliated with WhatsApp.
Respect WhatsApp terms and avoid spam/bulk messaging. The system is intended
for a single tournament group and authorized participants.

## 3. General engineering rules

•  Use TypeScript unless repository constraints justify otherwise.
•  Keep modules small and domain-oriented.
•  Validate all external input.
•  Use structured logs with correlation IDs.
•  Never log secrets, session credentials, or full auth files.
•  Use transactions for state transitions that must be atomic.
•  Every inbound event handler must be idempotent.
•  No business rule may exist only in an LLM prompt.
•  Do not use LLM output as SQL or shell commands.
•  Never trust file paths supplied by a user or model.
•  Preserve raw Unicode nicknames.
•  Keep all admin overrides auditable.
•  Do not silently change tournament rules — if a rule needs to change, that's a decision for DECISIONS.md, reported to and confirmed by the organizer, not a code-only change.
•  Avoid overengineering; the existing VM has limited resources and existing services.
•  Command names (the !xxx triggers) are not fixed by this file or by convention — naming is flexible. The one hard requirement: every command must always be fully and accurately listed in !help the moment it's registered, so delegates/organizer can always discover usage directly from the bot.

## 4. Database

•  Use Turso/libSQL.
•  Use @libsql/client and evaluate Drizzle ORM compatibility against current versions.
•  Migrations are mandatory.
•  Use stable internal IDs.
•  Keep raw nickname and derived search fields separate.
•  Store image metadata/references only; do not put image BLOBs in Turso.
•  Store provider credentials and Baileys auth state outside business tables.
•  Do not add unnecessary field-level encryption. Protect credentials and sensitive access paths appropriately.

## 5. WhatsApp identity handling

•  Do not use JID as the canonical database primary key.
•  Model a canonical delegate and multiple verified WhatsApp address aliases.
•  Inspect current Baileys message key/addressing types for JID/LID and linked-device behavior.
•  Store raw observed identifiers and their source.
•  Do not assume phone-only operation is required.
•  Do not merge aliases without evidence.
•  If identity cannot be resolved, deny privileged action and ask organizer to verify.
•  One registered delegate per team/division, unless a specific decision in DECISIONS.md says otherwise for a given flow.

## 6. AI architecture and prompt discipline

•  Implement provider adapters.
•  Check exact model capabilities for image input and structured output.
•  Pin model identifiers and record provider/model metadata.
•  Use JSON Schema/Zod validation.
•  Store prompts in source control and version them.
•  Use clear instruction hierarchy and explicit untrusted-input delimiters.
•  Include examples only when grounded in actual game screenshots.
•  Maintain golden evaluation fixtures.
•  Model output must not mutate records directly.
•  No auto-approval based only on model confidence.
•  Use provider quotas according to current provider terms; never rotate accounts to evade free-tier limits.
•  If all capable providers fail, enter manual mode (see WORKFLOWS.md §Manual Fallback for current behavior — this changes as retry/notification design evolves, so check there rather than assuming a fixed message or flow).

## 7. Media storage

•  Match the architectural pattern already established for this project's media storage (own process, own storage path, own metadata store) — do not commingle with any other project's media storage, live or otherwise.
•  Before changing anything about media storage, check INFRASTRUCTURE.md and docs/MEDIA_INTEGRATION.md for the current, actual setup — don't assume it still needs to be built from scratch.
•  Do not expose private match evidence publicly by default.

## 8. Swarm mode coordination

•  Follow SWARM_PLAN.md.
•  One integration lead owns shared architecture and merges.
•  Assign exclusive file/module ownership.
•  Agents must not concurrently modify shared schema, migrations, core event router, or prompt contracts without coordination.
•  Every agent returns: files changed, decisions, tests run, results, known gaps, and commit/patch reference.
•  Integrate in dependency order.
•  Run full tests after each integration.
•  No agent may mark a task complete without evidence.

## 9. Required implementation artifacts

Create/update as relevant to your task:
•  docs/BAILEYS_RESEARCH.md
•  docs/MEDIA_INTEGRATION.md
•  docs/ARCHITECTURE_DECISIONS.md
•  docs/OPERATIONS_RUNBOOK.md
•  .env.example with placeholder names only
•  migrations
•  tests and fixtures manifest
•  provider capability matrix
•  deployment and rollback instructions

## 10. Definition of done

A feature is done only when:
•  Requirements traced to FRD IDs.
•  Types and validation exist.
•  Unit/integration tests pass.
•  Failure path tested.
•  Logs and audit events exist where required.
•  Documentation updated (including the relevant domain doc from §1 — not this file).
•  No secrets committed.
•  No unresolved TODO hidden as success.

---

## 11. Mandatory Session Worklog Logging (worklog.md)

Every agent or developer working in this repository MUST maintain and update worklog.md at the root of the project.
Before any working session is considered complete:
1. *Log Every Task/Session*: Record date, session/task ID, and purpose.
2. *Document Concrete Changes*: Detail which files were modified and provide a concise summary of what was changed and why.
3. *Record Empirical Verification*: Include the exact tests or dry-run scripts executed, along with concrete command outputs and evidence of success. Claims of "done" without concrete verification output are invalid.
4. *Report New Bugs/Gaps Promptly*: If unexpected bugs or gaps outside the assigned scope are uncovered, log them explicitly in worklog.md with their status (e.g. REPORTED / PENDING_APPROVAL) and report them to the project owner before attempting uncoordinated fixes.
