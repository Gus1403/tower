#!/usr/bin/env bash
# Read-only tmux discovery for Tower. Prints TSV:
#   session  pane_id  current_command  pane_pid  activity_epoch(window_activity; tmux 3.4 has no pane_activity)  agent(claude|codex|devin|-)
# Classification: pane_current_command first, then the pane's descendant processes (ps), by argv0 basename / args.
# Never attaches, never sends keys.
set -u
ps_snapshot=$(ps -eo pid=,ppid=,args= 2>/dev/null)
tmux list-panes -a -F '#{session_name}	#{pane_id}	#{pane_current_command}	#{pane_pid}	#{window_activity}' 2>/dev/null |
while IFS=$'\t' read -r sess pane cmd pid act; do
  agent=-
  case "$cmd" in
    claude*) agent=claude ;;
    codex*) agent=codex ;;
    devin*) agent=devin ;;
  esac
  if [ "$agent" = - ]; then
    # walk descendants of the pane pid (BFS over the ps snapshot)
    desc=$(awk -v root="$pid" '
      { pid[NR]=$1; ppid[NR]=$2; $1=""; $2=""; args[NR]=$0 }
      END {
        want[root]=1; changed=1
        while (changed) { changed=0; for (i=1;i<=NR;i++) if (want[ppid[i]] && !want[pid[i]]) { want[pid[i]]=1; changed=1 } }
        for (i=1;i<=NR;i++) if (want[pid[i]] && pid[i]!=root) print args[i]
      }' <<<"$ps_snapshot")
    if grep -qE '(^|[ /])claude( |$)|claude-agent-acp|@anthropic-ai/claude-code' <<<"$desc"; then agent=claude
    elif grep -qE '(^|[ /])codex( |$)|codex-acp|@openai/codex' <<<"$desc"; then agent=codex
    elif grep -qE '(^|[ /])devin( |$)' <<<"$desc"; then agent=devin
    fi
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$sess" "$pane" "$cmd" "$pid" "$act" "$agent"
done
