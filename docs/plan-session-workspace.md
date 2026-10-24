# Session workspace

Authorized: full-page session workspace, conversation/terminal tabs, session navigation, context sidebar, multiline composer, responsive desktop/mobile design. No attribution commentary in product or code.

Owns: Tower session experience.
Depends on: authenticated Tower API, exact fleet session mapping, available local history/context.
Touches: web/src, server/src/session-workspace.ts, server/src/extra.ts, server/src/local-history.ts, server/test/local-history.test.ts, server/test/session-workspace.test.ts, server/test/extra.test.ts, shared/contract.ts

| Step | Executor | Reason | Parallel group |
|---|---|---|---|
| Shared contract and integration | Lead | architecture | A |
| Read-only history/context adapter | Sol high via cx | backend | B |
| Exact local history fallback | Sol high via cx | backend | B |
| Session workspace UI | Opus | frontend | B |
| Focused composer, Markdown and demo-mode polish | Opus | frontend | C |
| Integration, test/build, browser verification and deploy | Lead | integration | D |

Workers use separate worktrees. History must be bound to exact session; never guess by title. Real history only; unavailable histories have a clear terminal fallback. No production messages during verification. No unrelated project changes.

Acceptance: preserve existing ACP controls; full workspace with responsive context; conversation history and pagination where available; terminal fallback and guarded send; drafts cannot leak between sessions; navigation restores board; escaped/untrusted content; 40 existing regressions plus adapter tests; desktop/mobile light/dark screenshots and read-only live checks.

Discovery: only one live board card has its external conversation feature enabled. A separate exact process/registry-bound local history adapter supplies read-only Claude transcripts without altering session preferences. Terminal remains the fallback for unsupported/unverified history. Lead owns integration wiring and verification. Frontend lane runs on eva-forge because the Mac Claude OAuth session could not refresh.

Backend verification: 49/49 tests pass after making the existing chunked-upload test finish its request at the cap plus one byte (the same 413 and cleanup assertions remain). Full server typecheck passes. Read-only integration checks of two live sessions returned conversation pages, older pages, summaries and links. Local transcript parsing validated three live sessions and rejects a cursor from another session.

The standard Eva cross-model review wrapper was attempted from this worktree and refused the Tower base (`could not resolve merge-base`); it resolves its own Eva repository. No cross-model review is claimed. Lead integration review and runtime/browser evidence remain required.

A separate frontend polish snapshot addresses the lead-reproduced whitespace-send draft bug, unavailable-history recovery, safe Markdown tables, demo-mode data hiding, and phone composer alignment while the original frontend lane completes its checks. Production stays untouched until integration passes.

Frontend integration: the full workspace passed the lead’s four-layout mock matrix (desktop/phone, light/dark) with no page errors or overflow. The canonical browser flow passed 34 checks including permissions, queueing, attachments and account rotation. Its back-navigation selector now follows the workspace action, and queue submission waits for the previous send acknowledgement. The initial UI lane’s extra legacy-layout batch was stopped after the targeted workspace verification; it is not claimed as a passing gate.

Polish lane: 31/31 focused browser checks pass with no console errors or failed requests. Lead integrates the backend HTTP 409 cursor response into the UI recovery branch (small contract wiring below delegation overhead); the mock now exercises the same rejection status.

Release: f4d3c3e merged and pushed to main, deployed 2026-10-24 21:30 UTC after confirming no active Tower-managed agents. Final integrated build and 31/31 focused polish checks pass, including HTTP 409 recovery; four-layout mock matrix passes and whitespace-send reproduction is green. Live authenticated workspace sweep: 51 sessions, all HTTP 200 with no duplicate item IDs; 38 have readable conversations, 48 have context. Thirteen explicitly fall back to Terminal because identity/history is unavailable or the bounded read limit is exceeded. No production messages were sent by verification.

All 51 live terminal screens are readable. The live pagination verifier was adjusted to observe the automatic load triggered by scrolling to the top, rather than clicking the already-loading button; no product change was needed. Existing visual-style attribution comment removed as requested.

Final live browser matrix passes in desktop 1440×900 and phone 390×844, light/dark: full workspace, conversation, terminal, older history, isolated drafts, deep-link reload, context toggle and Back. Zero browser errors. Desktop and phone screenshots visually inspected. MERGED / IN PROD. Routing matched the plan: Opus UI and polish, Sol backend adapters, lead integration and deterministic verification.
