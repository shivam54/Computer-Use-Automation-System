# Production notes

This is a short sketch of how the current repo could grow - the artifact schema and replay contract stay the same.

## What I have today

A local vertical slice: LLM discovery → JSON artifact → deterministic replay, with safety allowlists, evidence logs, CLI escalation, and CI replay canaries against the mock app.

## Likely next steps (in order)

1. **Job API** — Replace CLI with `POST /runs/discovery` and `POST /runs/replay`; store the same JSON run records in Postgres + S3 instead of `./evidence/`.
2. **Artifact registry** — Version artifacts per tenant; keep the existing `draft → approved → quarantined` lifecycle, add canary replays before approval.
3. **Observability** — Export `runLog`, `replayMeta`, and discovery `runMetrics` to OpenTelemetry; alert on quarantine and allowlist violations.
4. **Operator platform** — Swap the CLI mock for a real handoff UI; keep `EscalationManager` pause/resume semantics.
5. **Scale** — Browser worker pool, session affinity for escalation, per-tenant discovery rate limits.

## From monolith to cloud

The assignment stays a single process on purpose. A sensible production path keeps the same code boundaries and splits deployment only when load demands it:

1. **Modular monolith** — One deployable service; discovery, replay, and escalation as internal modules (what this repo already looks like).
2. **Managed runtime** — Containerize and run on ECS/Cloud Run with the mock app replaced by VPN/browser access to real tenant UIs.
3. **Split workers** — Move replay browsers to a dedicated worker pool; keep the job API and artifact registry in a thin control plane.
4. **Multi-tenant cloud** — Per-tenant config, secrets from Vault/KMS, evidence in S3, runs in Postgres — still the same artifact JSON and replay contract.

The schema and replay engine move unchanged; only hosting and ops mature around them.

## Handy commands (today)

```bash
npm run artifact:approve
npm run demo && npm run demo not-found
npm test
```

