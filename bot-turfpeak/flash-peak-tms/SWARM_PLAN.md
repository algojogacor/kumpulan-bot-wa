# Swarm Development Plan

## 1. Coordination model

Use one integration lead (human or designated lead agent) as the only owner of cross-module decisions. Other agents work on isolated modules with explicit contracts.

## 2. Suggested agent roles

### Agent 0 — Architect / Integrator
Owns:
- project skeleton
- architecture decisions
- shared interfaces
- integration plan
- final review
Must not delegate away responsibility for consistency.

### Agent 1 — Baileys / WhatsApp Adapter
Owns:
- Baileys research
- connection lifecycle
- inbound event normalization
- outbound messaging
- JID/LID alias observation
- group command transport

### Agent 2 — Identity and Onboarding
Owns:
- teams/delegates/identity aliases
- `!onboarding`
- authorization checks
- onboarding state machine

### Agent 3 — Competition Engine
Owns:
- tournament configuration
- `!draw`
- group/fixture generation
- standings
- BO3/BO5 series logic
- walkover handling

### Agent 4 — Ingestion and Media
Owns:
- five-second debounce
- message dedupe
- report sessions
- Verax media API integration
- media integrity metadata

### Agent 5 — AI / Vision / Prompt Engineering
Owns:
- provider adapter contracts
- screenshot classification/extraction
- goalkeeper visual cue and DEFENSE-to-saves mapping
- correction parser
- prompt catalog and evaluation harness

### Agent 6 — Report / Approval / Manual Mode
Owns:
- report versioning
- validation orchestration
- three-party approval
- disputes
- manual report command

### Agent 7 — QA / Security / Operations
Owns:
- test strategy
- failure injection
- load/resource checks
- backup/restore tests
- deployment/runbook review

## 3. File ownership

| Area | Primary owner | Shared edits |
|---|---|---|
| `src/whatsapp/**` | Agent 1 | Integrator review |
| `src/identity/**` | Agent 2 | No concurrent edits |
| `src/competition/**` | Agent 3 | Schema contract review |
| `src/ingestion/**` | Agent 4 | Shared event contract only |
| `src/ai/**` | Agent 5 | Prompt contract review |
| `src/reports/**` | Agent 6 | Shared report types only |
| `src/db/**`, migrations | Integrator | Agents submit migration proposals |
| `tests/**` | Agent 7 | Module owners add tests |
| `docs/**` | Each module owner | Integrator reconciles |

## 4. Dependency order

1. Baileys research and VM inspection.
2. Domain model and schema proposal.
3. Shared types and database migrations.
4. WhatsApp event adapter and identity.
5. Onboarding.
6. Media upload and durable ingestion.
7. Debounce/session worker.
8. Competition engine and draw.
9. AI extraction and provider adapters.
10. Report validation/corrections/approvals.
11. Statistics and awards.
12. Full integration and operational hardening.

Parallel work is allowed only after interfaces are agreed.

## 5. Inter-agent contract

Every task request must specify:
- Objective.
- Owned files/directories.
- Inputs and outputs.
- Shared interfaces.
- Non-goals.
- Acceptance criteria.
- Tests required.
- Dependencies.
- Prohibited concurrent changes.

Every agent completion report must include:
```json
{
  "task_id": "string",
  "status": "DONE | BLOCKED | PARTIAL",
  "files_changed": [],
  "interfaces_changed": [],
  "tests": [
    {
      "command": "string",
      "result": "PASS | FAIL | NOT_RUN"
    }
  ],
  "decisions": [],
  "known_gaps": [],
  "risks": [],
  "commit_or_patch": "string"
}
```

## 6. Shared-file conflict policy

- Only Integrator edits shared schema and core interfaces.
- Other agents submit proposed changes as patches.
- No two agents run schema migrations against the same development database concurrently.
- Do not cherry-pick unreviewed changes that break the contract.
- Resolve conflicts by referring to PRD/FRD/DECISIONS.

## 7. Quality gates

- Static typecheck.
- Lint.
- Unit tests.
- Integration tests.
- Provider contract tests with mocked responses.
- Screenshot golden-set evaluation.
- WhatsApp event replay tests.
- JID/LID alias tests.
- Debounce race/restart tests.
- Draw restart/no-reroll tests.
- Approval invalidation tests.
- Manual fallback tests.
- VM resource and storage integrity tests.

## 8. Swarm anti-patterns to avoid

- All agents editing one giant file.
- Multiple agents independently inventing schema.
- Agents changing rules to make tests pass.
- Agents using undocumented Baileys APIs.
- Agents calling live AI providers for every test.
- Agents storing secrets in source.
- Agents implementing business rules only in prompts.
- Agents treating mocked success as production verification.
- Agents declaring done without tests.
