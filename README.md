# Tower

**One control tower for every coding agent.** Launch and supervise Devin, Claude Code and Codex side by side on
your own server, through the open [Agent Client Protocol](https://agentclientprotocol.com): live cards per agent,
one "Needs you" inbox for every permission request, stuck detection, and per-agent capacity — on desktop or phone.

Built in one afternoon at the **Devin AI Hackathon @ Georgia Tech** (2026-10-24), entirely with Devin.

## Why

I run a company with one human and about forty AI coding agents on a 96-core server. The question I ask all day is
"which agent needs me right now?" — and every vendor's dashboard only shows its own agents. My previous board
(Forja, private) watched agents by scraping their terminals with regular expressions. Tower drops the scraping:
every agent speaks ACP, so Tower receives real, structured events — messages, tool calls, plans and permission
requests — from Devin, Claude Code and Codex in the same shape.

Tower complements Devin Cloud rather than replacing it: Devin Cloud runs Devin on managed machines; Tower is the
board above every agent on your own machine — your repos, your secrets, the subscriptions you already have.

## What it does

- **Launch any agent** (Devin, Claude Code, Codex) with a task; each works in its own folder under `~/tower-work/`.
- **Live board**: Working · Needs you · Stuck · Done, with the agent's last words, tool-call count and plan progress.
- **Needs you inbox**: every permission request from every agent in one list; Allow / Reject in one tap.
- **Agent panel**: the live feed (messages, thoughts, tool calls, plan) and a composer to keep talking to the agent.
- **Stuck detection**: a working agent that goes silent past a threshold turns red.
- **Capacity chips**: which agent kinds are installed, logged in and running.
- **Observed sessions**: existing tmux agent sessions on the host appear as read-only cards.

## Architecture

```
 phone / laptop ──Tailscale + token──▶  Tower server (Node, TypeScript)  ──stdio ACP──▶  devin acp
                     HTTP + WebSocket   agent manager · inbox · stuck    ──stdio ACP──▶  claude-agent-acp
                                        capacity · tmux discovery        ──stdio ACP──▶  codex-acp
```

- `shared/contract.ts` — the single contract between server and web (types, routes, events).
- `server/` — ACP client per agent, in-memory state, HTTP API, WebSocket broadcast, static web.
- `web/` — Vite + React board (plain CSS), with a `?mock=1` mode.
- `ops/` — systemd user unit and deploy script.

## Run

```bash
npm install && npm --prefix server install && npm --prefix web install
npm run build                         # builds web/dist
TOWER_TOKEN=$(openssl rand -hex 16) TOWER_HOST=127.0.0.1 npm start
open "http://127.0.0.1:4747/?token=$TOWER_TOKEN"
```

Environment: `TOWER_TOKEN` (required), `TOWER_HOST` (default `127.0.0.1`), `TOWER_PORT` (default `4747`),
`TOWER_WORK_DIR` (default `~/tower-work`), `TOWER_STUCK_MS` (default `300000`).

## Security

Tower can run coding agents on the machine it lives on, so it binds to loopback or a private (Tailscale) address,
requires a bearer token on every request and the WebSocket, and confines each agent's file reads and writes to its
own work folder. Never expose it to the public internet.

## How it was built

Everything in this repository was written on 2026-10-24 during the hackathon, by Devin: a lead Devin session wrote
the contract and plan, then three Devin workers built the server, the web board and the host setup in parallel,
followed by a Devin code review and headless browser verification. Forja (my earlier private board) was the
inspiration only; no code was copied from it.
