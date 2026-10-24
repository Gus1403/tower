// tmux control for observed tmux cards (send text / keys, capture the screen). execFile only, never a shell.
// When TOWER_TMUX_SOCKET is set every call gets `-L <socket>` (tests use a throwaway `-L tower-test` server).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const ALLOWED_KEYS = ['Escape', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Tab', 'C-c'] as const;
export const MAX_SEND_CHARS = 20000;
const TIMEOUT_MS = 5000;

function tmux(args: string[], stdin?: string): Promise<string> {
  const sock = process.env.TOWER_TMUX_SOCKET;
  const full = sock ? ['-L', sock, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', full, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`tmux ${args[0]} failed: ${String(stderr || err.message).trim().slice(0, 300)}`));
      else resolve(String(stdout));
    });
    if (stdin !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** `=<session>:` exact-match target for a session name (keeps an already formatted target). */
export function formatTarget(session: string): string {
  if (session.startsWith('=')) return session;
  return `=${session}:`;
}

export async function tmuxSend(target: string, text: string): Promise<void> {
  const buf = `tower-${randomBytes(6).toString('hex')}`;
  await tmux(['load-buffer', '-b', buf, '-'], text);
  try {
    await tmux(['paste-buffer', '-p', '-d', '-b', buf, '-t', target]);
  } catch (e) {
    await tmux(['delete-buffer', '-b', buf]).catch(() => {});
    throw e;
  }
  await tmux(['send-keys', '-t', target, 'Enter']);
}

export async function tmuxKey(target: string, key: string): Promise<void> {
  if (!(ALLOWED_KEYS as readonly string[]).includes(key)) throw new Error('key not allowed');
  await tmux(['send-keys', '-t', target, key]);
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

export async function tmuxScreen(target: string): Promise<{ text: string; at: number }> {
  const out = await tmux(['capture-pane', '-p', '-t', target, '-S', '-120']);
  return { text: stripAnsi(out), at: Date.now() };
}
