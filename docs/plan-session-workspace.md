# Session workspace

Authorized: full-page session workspace, conversation/terminal tabs, session navigation, context sidebar, multiline composer, responsive desktop/mobile design. No attribution commentary in product or code.

Owns: Tower session experience.
Depends on: authenticated Tower API, exact fleet session mapping, available local history/context.
Touches: web/src, server/src/session-workspace.ts, server/src/extra.ts, server/test/session-workspace.test.ts, shared/contract.ts

| Step | Executor | Reason | Parallel group |
|---|---|---|---|
| Shared contract and integration | Lead | architecture | A |
| Read-only history/context adapter | Sol high via cx | backend | B |
| Session workspace UI | Opus | frontend | B |
| Integration, test/build, browser verification and deploy | Lead | integration | C |

Workers use separate worktrees. History must be bound to exact session; never guess by title. Real history only; unavailable histories have a clear terminal fallback. No production messages during verification. No unrelated project changes.

Acceptance: preserve existing ACP controls; full workspace with responsive context; conversation history and pagination where available; terminal fallback and guarded send; drafts cannot leak between sessions; navigation restores board; escaped/untrusted content; 40 existing regressions plus adapter tests; desktop/mobile light/dark screenshots and read-only live checks.
