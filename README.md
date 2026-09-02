# Computer-Use Automation System

A system that lets an AI agent **discover** how to complete tasks in legacy UI applications (no API), **records** successful runs as reusable capability artifacts, and **replays** them deterministically without the LLM in the loop.

See [REPORT.md](./REPORT.md) for architecture, **trade-offs**, error taxonomy, safety model, and what was deliberately cut.

## Architecture Overview

```
Goal (natural language)
    ↓
Discovery Agent (LLM observe → decide → act)
    ↓
Capability Artifact (typed, versioned, reviewable)
    ↓
Replay Engine (deterministic, no LLM)
    ↓
Structured Result (success | business_outcome | failure)
```



## Prerequisites

- Node.js 20+
- An Anthropic or OpenAI API key (for discovery runs only — replay works without it)



## Setup

```bash
git clone <your-repo-url>
cd InterfaceAI
npm install
npx playwright install chromium
cp .env.example .env
# Edit .env and paste ANTHROPIC_API_KEY (starts with sk-ant-)
```



## Running the Mock App

The mock app simulates a legacy credit union back-office system (table layouts, iframes, no test IDs):

```bash
npm run mock-app
# Runs at http://localhost:3847
# Login: shivam / demo123
# Test members: 12345 (Jane Doe, active), 67890 (John Smith), 11111 (Maria Garcia, frozen)
```



## Demo Path (No API Key Required)

With the mock app running in another terminal:

```bash
# Success case — member 12345, extracts savings balance
npm run demo

# Error case — member 99999, returns MEMBER_NOT_FOUND business outcome
npm run demo not-found

# Recoverable error — session timeout → re-login → replay
npm run demo:recoverable

# Human escalation evidence (non-interactive)
npm run demo:escalate
```

This runs deterministic replay using a pre-built artifact and saves evidence to `/evidence/`.

## Full Discovery + Replay Flow (Requires API Key)

**Terminal 1:** Start mock app

```bash
npm run mock-app
```

**Terminal 2:** Run LLM discovery

```bash
npm run discover -- "Log into Shivam CU, look up member 12345, and read their savings balance"
```

**Terminal 3:** Replay the saved artifact

```bash
npm run replay -- evidence/member-lookup-capability.json --memberId=12345
```



## Human Escalation Demo

```bash
npm run escalate
# Pauses automation, opens browser for manual control
# Type 'action <description>' to record human steps
# Type 'done' to hand control back to automation
```



## Project Structure

```
├── mock-app/           # Legacy-style credit union UI (Express + static HTML)
├── src/
│   ├── schema/         # Capability artifact schema (Zod)
│   ├── surface/        # Surface abstraction (Playwright driver)
│   ├── discovery/      # LLM agent loop
│   ├── replay/         # Deterministic replay engine
│   ├── safety/         # Allowlist, redaction, policy guard
│   ├── escalation/     # Human handoff mechanism
│   ├── observability/  # Structured logging
│   └── cli/            # CLI commands
├── evidence/           # Saved artifacts, logs, screenshots
├── REPORT.md           # Design write-up
└── README.md
```



## Tests

```bash
npm test
```



## Production depth (governance & policy)

```bash
# Approve artifact for production replay (draft → approved)
npm run artifact:approve

# Replay unapproved discovery output (dev only)
npm run replay -- evidence/member-lookup-capability.json --memberId=12345 --allow-draft

# Escalation triggered from replay (risky step → pause → resume)
npm run demo:escalate-replay
```

Optional production sketch: [PRODUCTION.md](./PRODUCTION.md) (not a assignment deliverable).

## Safety

- **Allowlists** — domains, routes, and action types enforced on every navigation and step
- **Secret handling** — passwords redacted as `[REDACTED]` in all persisted logs; credentials injected at runtime via `SecretProvider`
- **Screenshot balance redaction** — savings/checking dollar amounts blurred in PNG evidence; member name, ID, and status stay visible (`SCREENSHOT_REDACT_PII`, default on)
- **LLM rate limiting** — discovery capped at `LLM_RATE_LIMIT_RPM` calls/minute to prevent runaway loops



## Configuration


| Variable                  | Default                 | Description                                        |
| ------------------------- | ----------------------- | -------------------------------------------------- |
| `ANTHROPIC_API_KEY`       | —                       | Claude API key (recommended)                       |
| `LLM_PROVIDER`            | `anthropic`             | `anthropic` or `openai`                            |
| `ANTHROPIC_MODEL`         | `claude-sonnet-5`       | Claude model for discovery                         |
| `OPENAI_API_KEY`          | —                       | OpenAI key (if using openai provider)              |
| `OPENAI_MODEL`            | `gpt-4o`                | OpenAI model for discovery                         |
| `MOCK_APP_URL`            | `http://localhost:3847` | Target app URL                                     |
| `MAX_AGENT_STEPS`         | `25`                    | Discovery step limit                               |
| `ALLOWED_DOMAINS`         | `localhost,127.0.0.1`   | Permitted hostnames                                |
| `ALLOWED_ROUTES`          | see `.env.example`      | Permitted URL paths (`*` wildcards supported)      |
| `ALLOWED_ACTIONS`         | all standard actions    | Permitted step action types                        |
| `BLOCKED_ACTIONS`         | —                       | Explicitly blocked action types                    |
| `SCREENSHOT_REDACT_PII`   | `true`                  | Blur savings/checking balances in screenshots only |
| `LLM_RATE_LIMIT_RPM`      | `30`                    | Max discovery LLM calls per minute                 |
| `LLM_RATE_LIMIT_DISABLED` | —                       | Set `true` to disable rate limiting                |




## Evidence

See `/evidence/` for:

- `member-lookup-capability.json` — saved capability artifact
- `discovery-run.json` — discovery run summary + structured `runLog` + `runMetrics` (LLM latency, tokens, cost)
- `runs/` — one JSON file per replay run (never overwritten)
- `replay-runs.jsonl` — append-only index of all replay runs
- `screenshots/` — failure and handoff screenshots

Each replay creates `evidence/runs/replay-<runId>.json` with `correlationId`, `artifactVersion`, parameters, outputs, `replayMeta`, and full `runLog`.

Artifacts include a `lifecycle` block: `version`, `status` (draft | approved | quarantined), and drift tracking via `consecutiveFailures`.