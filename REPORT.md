# Design Report — Computer-Use Automation System

## 1. Architecture

### What the system does (one sentence)

An LLM **discovers** how to complete a task in a legacy UI once; the run is saved as a **capability artifact**; production replays that artifact **deterministically** with no LLM in the loop.

### End-to-end flow

1. **Discover** — You give a goal in plain English (e.g. “look up member 12345 and read savings balance”). An LLM observes the page, decides the next action, and acts until the goal is done or it gets stuck.
2. **Record** — A successful discovery produces a JSON **artifact**: ordered steps, locators, parameters, outputs, checkpoint, and error handlers. This is *not* a raw LLM transcript.
3. **Replay** — Given the artifact + inputs (e.g. `memberId=12345`), the replay engine executes the same steps with no LLM. It returns success, a business outcome (e.g. member not found), or a failure with evidence.
4. **Escalate (when needed)** — If discovery or replay cannot proceed safely, automation **pauses**, a human uses the **same browser session**, then automation **resumes**.

### Architecture diagram

```mermaid
flowchart TB
  subgraph pipeline [Main pipeline]
    Goal[Goal in natural language]
    Discover[Discovery Agent\nLLM observe → decide → act]
    Artifact[Capability Artifact\nJSON, versioned, reviewable]
    Replay[Replay Engine\nno LLM, deterministic]
    Result[Structured result\nsuccess | business_outcome | failure]
    Goal --> Discover --> Artifact --> Replay --> Result
  end

  subgraph cross [Cross-cutting — all phases]
    Surface[Surface Driver\nPlaywright today]
    Safety[Safety Guard\nallowlists + redaction]
    Evidence[Evidence / runLog\nJSON + screenshots]
  end

  subgraph escalate [Human escalation]
    EscMgr[Escalation Manager\npause / resume]
    Human[Human operator\nCLI mock console]
  end

  Discover --> Surface
  Replay --> Surface
  Safety --> Surface
  Discover --> Evidence
  Replay --> Evidence
  Replay --> EscMgr
  Discover --> EscMgr
  EscMgr --> Human
  Human --> Surface
  EscMgr --> Replay
```

**How to read this:** Discovery and Replay both drive the UI through the **Surface Driver**. The **Safety Guard** wraps every action (allowed domains/routes, redacted secrets). **Escalation** pauses automation on the live session — it does not start a new browser.

### Main components

| Component | Role | LLM used? |
|-----------|------|-----------|
| `DiscoveryAgent` | Runs observe→decide→act loop until goal or stuck | Yes |
| `CapabilityArtifact` | Typed, reusable description of the flow | No |
| `ReplayEngine` | Executes artifact steps + checkpoint + error handlers | No |
| `SurfaceDriver` | Perceive and act on UI (Playwright for web) | No |
| `SafetyGuard` | Allowlists, risk checks, secret redaction | No |
| `EscalationManager` | Pause, human handoff, resume same session | No |

### Key decisions (summary)

- **Single-process monolith** — one repo, `npm run demo`, no queues or K8s for the take-home.
- **`SurfaceDriver` seam** — UI driver is swappable; artifact schema is not Playwright-specific.
- **Zod-validated artifact** — invalid artifacts fail before they touch a browser.
- **Legacy-first locators** — `table_row` / role / text, not CSS `#id` (matches real bank UIs).

### Trade-offs

Six decisions that shaped the system. Each one favors a working, reviewable take-home over production completeness.

| Choice | Why | Cost |
|--------|-----|------|
| **Playwright + DOM/a11y** over screenshot + pixel clicks | Legacy bank UIs are messy but stable. Label-based targeting (“Sign In”, “User ID:”) survives layout tweaks; coordinates do not. | Web-only for now. Canvas-only apps would need a different driver. |
| **LLM in discovery only** — replay never calls the model | Replay must be cheap, fast, and identical on every run. Production agents invoke artifacts, not re-reason about the UI. | Broken locators fail or escalate; replay cannot adapt to surprise UI changes alone. |
| **Structured artifact** over LLM transcript | Callers need typed parameters, outputs, and error codes — not prose and hidden credentials. | Up-front schema work. Failed discovery runs are not automatically replayable. |
| **Semantic locators** (`table_row`, role, text) over CSS `#id` | Real core banking screens do not ship with test IDs. Operators read row labels; our locators match that. | Breaks if label copy or table structure changes. More resolver logic than `#username`. |
| **Single-process monolith** over queues and workers | A reviewer should `git clone`, run the mock app, and see the full loop in minutes. | No horizontal scale, job API, or per-tenant isolation in this repo. |
| **CLI operator mock** over a co-browsing console | Pause/resume on the *same* browser session is the hard problem; the UI is replaceable. | No screen-share, routing, or supervisor dashboard. |

**Core assumption:** Record-once / replay-many works because enterprise UIs change slowly. Playwright is the web implementation; `SurfaceDriver` is the seam for desktop later.

## 2. Artifact schema

The artifact is an **agent-invocable contract** — a calling agent must know what to pass in, what comes back, and what can go wrong. It is not a dump of the LLM transcript.

**Core fields:**
- `parameters[]` — typed inputs the calling agent supplies (e.g., `memberId: string`)
- `outputs[]` — typed return values with extraction locators (e.g., `savingsBalance: string`)
- `steps[]` — ordered actions with locators, values, and risk levels
- `checkpoint` — post-condition assertion (not "assume the click worked")
- `errorHandlers[]` — pattern-matched runtime conditions with outcome classification

**Why this shape:**
- An AI agent calling this capability needs to know what to pass in and what to expect back — hence typed parameters and outputs, not just steps.
- Locators carry a `strategy` enum and `fallbacks[]` chain, making robustness reasoning explicit and reviewable.
- `errorHandlers` separate business outcomes ("member not found") from hard failures, which is the most common design mistake in this domain.
- `lifecycle` governs promotion: discovery saves `draft`; replay in production requires `approved`; repeated failures quarantine the artifact.
- `metadata.recordedBy` tracks provenance (discovery vs human vs import) for approval workflows.
- `targetApp.tenantId` and `appVariant` fields prepare for multi-tenant reuse without requiring it now.

## 3. Determinism & error handling

Replay must behave the same way every time: same inputs → same steps → same result. The LLM is never consulted during replay.

**How determinism is achieved:**
1. **Locator resolution** tries primary strategy, then fallbacks in order, with explicit waits for element visibility.
2. **No LLM in replay path** — every decision is encoded in the artifact.
3. **Checkpoint verification** after all steps complete — asserts expected text/state is present.
4. **Parameter substitution** uses `{{paramName}}` templates, resolved before execution.
5. **Step ordering** — steps sorted by id (`step-1`, `step-2`, …) regardless of JSON array order.

**Three outcome classes** (the most important design choice in this project):

| Class | Example | Replay behavior |
|---|---|---|
| `business_outcome` | "No member found", empty member ID, frozen account | Return structured result with outcome code; not a crash |
| `recoverable` | Session timeout, unexpected dialog | Attempt recovery step if defined; retry |
| `hard_failure` | Element not found, checkpoint failed, unknown error | Stop, screenshot, return debug info (step, expected, observed) |

**Critical design choice:** Business errors often appear *after* a step succeeds (e.g. clicking Search returns an inline error, not a thrown exception). We check `errorHandlers` both after each step and before checkpoint verification — so "member not found" is classified correctly instead of becoming a misleading `CHECKPOINT_FAILED`.

**Policy module (`src/replay/policy.ts`):** Error classification and routing are table-driven — `classifyPageOutcome` → `resolveErrorPolicy` decides whether to return, recover, escalate, or fail. Keeps the engine as an executor, not a policy dump.

**Run correlation:** Every discovery run generates a `correlationId` propagated to the artifact lifecycle, replay results, and evidence index — linking discovery → replay → escalation in audit logs.

**Replay confidence:** Successful/failed replays attach `replayMeta` (duration, steps executed, fallback count). Three consecutive hard failures quarantine the artifact.

**Edge cases handled:**

| Edge case | Handling |
|---|---|
| Member not found (99999) | `business_outcome: MEMBER_NOT_FOUND` |
| Empty member ID | `hard_failure: EMPTY_PARAMETER` (pre-flight) or `VALIDATION_ERROR` (in-app) |
| Frozen account (11111) | Lookup succeeds; `outputs.memberStatus: "frozen"` in logs |
| Wrong login credentials | Step fails at fill/click; screenshot captured |
| Steps out of order in artifact | Sorted by step id before execution |
| iframe not loaded | `switch_frame` step + auto-switch after Member Inquiry click |
| LLM omits css/value during discovery | `enrichAction` infers from page phase and interactive elements |
| Agent loop (same action 3x) | Loop detection injects recovery hint |
| Domain or route outside allowlist | `POLICY_VIOLATION` before/at/after each action |
| Irreversible step | Escalates with `CONFIRMATION_REQUIRED` |
| Sensitive params in logs | Redacted via `sensitive: true` on parameter schema |

## 4. Heterogeneity & multi-tenant

*Design only — not fully built.* The take-home runs against one mock credit-union UI; this section explains how the same design would extend to desktop apps and hundreds of bank tenants.

**Surface abstraction:** The `SurfaceDriver` interface is the seam. Web (Playwright), legacy web (same driver, different locator strategies), and desktop (future: OS accessibility APIs like AXUIElement on macOS, UI Automation on Windows) all implement the same interface. The artifact schema is surface-agnostic — it records actions and locators, not Playwright-specific selectors.

**Multi-tenant reuse:** Artifacts include `targetApp.tenantId` and `appVariant`. The design supports:
- **Shared base artifact** for a vendor product (e.g., "Fiserv DNA member lookup")
- **Per-tenant overrides** for branding, URL, or locator differences
- **Canonicalization** of concrete values into parameterized patterns (`/member/12345` → `/member/:id`)
- **Drift detection** by comparing replay checkpoint failures across tenants running the same base artifact

I did not implement multi-tenant plumbing — the schema fields and REPORT design story are the deliverable.

## 5. Escalation & handoff

When automation cannot safely continue, a human takes over the **same live browser session** — not a fresh one — then hands control back.

**When escalation triggers:**
- Discovery agent returns `action: "stuck"` after 3 consecutive failures
- Replay hits an irreversible step (`riskLevel: "irreversible"`)
- Replay encounters an unrecoverable error

**Handoff steps:**
1. `EscalationManager` creates an intervention request with full context (goal, step, screenshot, session ID)
2. `PlaywrightSurface.pauseAutomation()` sets `controller: "human"` — all automated actions throw if attempted
3. Human operates the **same live browser session** (not a fresh one)
4. Human actions are recorded via CLI (`action <description>`)
5. `resumeAutomation()` hands control back; replay continues from current state
6. **Replay-integrated escalation:** when replay hits a `risky`/`irreversible` step, the engine creates an `EscalationManager` request automatically (`demo:escalate-replay`)

The operator console is a minimal CLI, not a full co-browsing UI. The control-transfer model (pause/resume, controller state, session preservation) is real and testable.

## 6. Safety

Regulated financial data requires guardrails on *what* the agent can do and *what* gets persisted.

**Allowlist model:**
- Configurable `allowedDomains` via `ALLOWED_DOMAINS` (default: localhost only)
- Configurable `allowedRoutes` via `ALLOWED_ROUTES` (path patterns with `*` wildcards)
- Per-action-type allowlist via `ALLOWED_ACTIONS` / `BLOCKED_ACTIONS`
- URL validation before every navigation (discovery, replay, and surface driver)
- Post-step location check catches redirects to out-of-policy URLs
- Artifact pre-flight validation rejects out-of-policy steps before browser actions

**Risk classification:**
- Steps tagged `safe`, `risky`, or `irreversible`
- `risky` and `irreversible` steps trigger escalation (human confirmation required before execution)

**Data handling (production-style secrets):**
- **Never encrypt secrets into logs** — production systems redact or omit them entirely; encrypted ciphertext in logs still leaks if the key is nearby
- Login credentials stored as `parameterRef` only — no literal secrets in artifacts
- `SecretProvider` injects sensitive values at runtime from `DEMO_USERNAME` / `DEMO_PASSWORD` (or Vault/KMS in production)
- CLI flags for sensitive params (e.g. `--password=`) are ignored with a warning — secrets must not appear in process argv
- Discovery fills passwords from env, not from LLM output
- Parameters marked `sensitive: true` are redacted in all persisted evidence (`[REDACTED]`)
- Set `REQUIRE_ENV_SECRETS=true` to disable demo defaults and fail fast if env secrets are missing
- Screenshot evidence: **selective redaction** blurs account *balances* only (savings/checking dollar amounts) — member name, member ID, and status stay visible for debugging. Passwords remain redacted in JSON logs. Disable screenshot blur with `SCREENSHOT_REDACT_PII=false`.

**Limits:** Redaction uses DOM text/heuristics on our mock surfaces — not a general OCR pipeline. Centralized persistent audit storage (DB/S3) is out of scope; this take-home uses append-only JSONL + immutable run files under `/evidence/`.

**Rate limiting:** Discovery LLM calls are gated by a token bucket (`LLM_RATE_LIMIT_RPM`, default 30/min). Prevents runaway loops from burning API budget. Disable locally with `LLM_RATE_LIMIT_DISABLED=true`.

**Observability:** Every discovery, replay, and escalation run persists a structured `runLog` array (timestamped entries with step id, action, message, and data). Discovery runs include a `runMetrics` summary with LLM call count, latency percentiles (p50/p95), token usage, and estimated cost. Replay runs attach `replayMeta` (duration, steps executed). Replay runs are stored as immutable files under `/evidence/runs/<runId>.json` with an append-only `replay-runs.jsonl` index — runs are never overwritten by status. Failures capture full-page screenshots.

## 7. Cuts

The assignment asks for a complete vertical slice, not a production platform. This section separates what I added, what I skipped, and what would come next.

### Beyond the required scope

Extras that go past the minimum brief but stay small and testable:

- **Artifact lifecycle** — `draft` → `approved` → `quarantined`; `npm run artifact:approve` gates replay
- **Run correlation** — `correlationId` links discovery, replay, and escalation evidence
- **Replay metadata** — `replayMeta` (duration, steps run) on each replay result
- **Balance redaction in screenshots** — blur savings/checking amounts only; passwords stay out of JSON logs
- **Discovery rate limit** — token bucket on LLM calls so stuck loops do not burn API budget

### Intentionally out of scope

Not forgotten — deferred so the core loop stays deep instead of wide:

- Real operator co-browsing UI (CLI mock proves pause/resume on the live session)
- Desktop/native app driver (designed via `SurfaceDriver`, not implemented)
- Multi-tenant artifact registry and per-bank overrides (schema fields only)
- Agent catalog / tool-calling API to invoke capabilities by name
- Single-step LLM recovery when replay fails
- Cross-tenant artifact reuse demo and replay flakiness (N-run) reporting

### Where I'd invest next

Rough priority if this moved toward production:

1. Job API (`POST /runs/replay`) and durable evidence storage (S3 + Postgres)
2. Per-tenant artifact overrides and canonicalized routes
3. Bounded, policy-checked LLM fallback for one replay step
4. Replay canary suite and flakiness metrics per artifact version
5. Full operator console and OCR-based screenshot redaction

Optional one-pager: [PRODUCTION.md](./PRODUCTION.md) — high-level rollout order, not part of the assignment deliverables.
