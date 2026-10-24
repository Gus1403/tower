#!/usr/bin/env bash
# Deploy Tower from this Mac checkout to eva-forge and (re)start the user unit.
# Usage: ops/deploy.sh            (needs ~/.config/tower/env on forge with TOWER_TOKEN=..., see below)
set -euo pipefail

HOST="${TOWER_DEPLOY_HOST:-eva-forge}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="Code/tower" # relative to the remote $HOME

echo "==> rsync $SRC -> $HOST:~/$DEST"
ssh -o BatchMode=yes "$HOST" "mkdir -p ~/$DEST"
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude dist \
  --exclude 'probes/out' --exclude 'probes/work' \
  "$SRC/" "$HOST:$DEST/"

echo "==> install deps, build web, install + restart unit on $HOST"
ssh -o BatchMode=yes "$HOST" bash -s <<'REMOTE'
set -euo pipefail
cd ~/Code/tower
export PATH="$HOME/.local/bin:$PATH"
timeout 300 npm ci --no-audit --no-fund
timeout 300 npm --prefix web ci --no-audit --no-fund
timeout 300 npm run build

mkdir -p ~/.config/tower ~/.config/systemd/user ~/tower-work
if [ ! -f ~/.config/tower/env ]; then
  umask 077
  {
    echo "TOWER_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    echo "TOWER_HOST=127.0.0.1"
    echo "TOWER_PORT=4747"
    echo "TOWER_WORK_DIR=$HOME/tower-work"
    echo "PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
    # Claude/Codex through the account-selecting shims (subswitch) instead of the adapters' bundled CLIs:
    echo "CLAUDE_CODE_EXECUTABLE=$HOME/.local/bin/claude"
    echo "CODEX_PATH=$HOME/.local/bin/codex"
  } > ~/.config/tower/env
  echo "created ~/.config/tower/env (token inside; read it with: grep TOWER_TOKEN ~/.config/tower/env)"
fi

install -m 0644 ops/tower.service ~/.config/systemd/user/tower.service
systemctl --user daemon-reload
systemctl --user enable tower.service >/dev/null 2>&1 || true
systemctl --user restart tower.service
sleep 2
systemctl --user --no-pager --lines=15 status tower.service || true
REMOTE
echo "==> done. Tunnel: ssh -L 4747:127.0.0.1:4747 $HOST  then open http://127.0.0.1:4747/?token=<TOWER_TOKEN>"
