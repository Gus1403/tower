# Recover the stopped Tower fleet work

Requested outcome: show the actual running fleet with correct names, boards, states and readable live screens.

Recovered Devin session: toothsome-asphalt, last node 6399, head b8b6269. Baseline: 39/39 tests; all 48 discovered live screens return nonempty text. The remaining proven defect is guessed display-name slug mapping: SEO diario runs as shell-141358; Social as seo-geo-social-media. The CLI truncates work at 60 characters and omits session IDs.

## Execution strategy

| Step | Executor | Reason | Parallel group |
|---|---|---|---|
| Recover evidence and validate live screens | Codex lead | deterministic | A |
| Independent transcript audit | Devin Opus 5.5 | review | A |
| Replace guessed identity with structured Forja socket state, regression, deploy | Codex lead | crux | B |

Devin audit refused before work: weekly quota exhausted (saved locally). Lead implements this bounded integration repair because the adapter is the crux and delegation is unavailable; no alternate paid workers or quota purchase. No frontend change is planned.

Owns: fleet identity integration. Depends on: existing Forja read-only board socket.
Touches: server/src/agents.ts, server/test/waved.test.ts, docs/plan-fleet-recovery.md

## Acceptance

- [x] Regression proves unrelated display titles map by exact session, preserving full work and routine/customer board/state.
- [x] Missing/malformed Forja state falls back to discovered tmux sessions; demo redaction still hides names/work.
- [x] Full server tests and frontend build pass.
- [x] Deployed API matches actual Forja identities; every discovered screen returns text.
- [x] Desktop and phone screenshots inspected; named cards open live screens without browser errors.

Scope limits: existing running tmux fleet only; sleeping customer sessions without a process are not silently started. No customer messages, provider subscription changes, or hackathon submission. ACP-owned agents retain their existing controls; legacy fleet sessions use their actual terminal.

## Evidence

Deployed identity repair: 50 discovered sessions, 50 interactive screens returning text, zero mismatches against live board names/boards/states. Server suite 40/40; frontend build and server typecheck pass. Desktop and phone in light/dark render without overflow or console errors. Screenshot capture now waits for the panel entrance animation to finish; the apparent phone transparency was an intermediate animation frame, not a persistent defect.

Local evidence: `/tmp/devin-takeover/live-summary.json`, `comparison.json`, `browser-results.json`, `tests-final.log`, `build.log`. Screenshots contain private fleet text and are not committed. Session-workspace redesign follows in a separate plan.
