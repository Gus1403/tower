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

- [ ] Regression proves unrelated display titles map by exact session, preserving full work and routine/customer board/state.
- [ ] Missing/malformed Forja state falls back to discovered tmux sessions; demo redaction still hides names/work.
- [ ] Full server tests and frontend build pass.
- [ ] Deployed API matches actual Forja identities; every discovered screen returns text.
- [ ] Desktop and phone screenshots inspected; named cards open live screens without browser errors.

Scope limits: existing running tmux fleet only; sleeping customer sessions without a process are not silently started. No customer messages, provider subscription changes, or hackathon submission. ACP-owned agents retain their existing controls; legacy fleet sessions use their actual terminal.
