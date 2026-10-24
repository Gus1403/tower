# Plan: Tower — one control tower for every coding agent

Built 2026-10-24 at the Devin AI Hackathon @ Georgia Tech, entirely with Devin.

## Goal

One self-hosted board that launches and supervises Devin, Claude Code and Codex the same way, through the open
Agent Client Protocol (ACP): live cards per agent, one "Needs you" inbox for every permission request, stuck
detection, and per-agent capacity. Runs on the owner's own server (eva-forge), reached over Tailscale with a token.

## Decisions

| Decision | Choice | Rejected |
|---|---|---|
| Agent transport | ACP over stdio (`devin acp`, `@agentclientprotocol/claude-agent-acp`, `@agentclientprotocol/codex-acp`) | tmux screen scraping (Forja's approach; regex on terminals) |
| Code origin | New code, written today; Forja is only the inspiration | Copying Forja / subswitch |
| Agent sandbox | Every agent works in `~/tower-work/<id>`; never a real repo | Pointing agents at production repos |
| Exposure | Bind to loopback or the Tailscale IP + bearer token | Public internet |
| Stack | Node 22 + TypeScript (tsx), `ws`; web: Vite + React + plain CSS | Frameworks with more setup |
| Dependency pins | Versions published ≥7 days ago (`@agentclientprotocol/sdk@1.9.0`, `claude-agent-acp@0.93.0`) | Latest (published < 7 days) |

## Increments

1. Contract (`shared/contract.ts`) — lead. 🟩
2. Server: ACP agent manager, HTTP + WS API, stuck detection, tests. 🟥
3. Web board: cards by status, Needs-you inbox, agent panel with live feed, launcher, phone layout. 🟥
4. Host: Devin CLI + ACP adapters on eva-forge, real handshake probes, capacity probe, tmux read-only discovery. 🟥
5. Integration on eva-forge, review, Playwright browser verification, README. 🟥

## Execution strategy

| Step | Executor | Reason | Parallel group |
|---|---|---|---|
| 1 Contract | lead (Devin) | crux | — |
| 2 Server | Devin sidekick | backend | G1 |
| 3 Web | Devin subagent B | frontend | G1 |
| 4 Host + probes | Devin subagent C | environment | G1 |
| 5 Integrate / review / verify | lead + Devin review subagent | integration | G2 |

Owns: tower repo. Depends on: nothing.
Touches: shared/contract.ts, server/**, web/**, ops/**, probes/**, docs/**, README.md
