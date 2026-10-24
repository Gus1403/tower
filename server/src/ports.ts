// Seams between the agent manager (agents.ts, http.ts, main.ts — worker S1) and the accounts / persistence
// modules (accounts.ts, store.ts — worker S2). Change only through the lead.
import type { Account, AgentKind, AgentSummary, FeedItem } from '../../shared/contract.js';

export interface LaunchEnv {
  accountId?: string; // the Account.id actually chosen (resolves 'auto')
  env: Record<string, string>; // extra env for the agent process, e.g. { CLAUDE_CONFIG_DIR: '/home/x/.claude-12' }
}

export interface AccountsPort {
  list(): Account[]; // cached; running counts come from countRunning
  envFor(kind: AgentKind, accountId?: string): LaunchEnv; // throws Error('unknown account') for a bad id
  start(onChange: (accounts: Account[]) => void, countRunning: (accountId: string) => number): void; // begins periodic refresh
  stop(): void;
}

export interface PersistedAgent {
  summary: AgentSummary;
  feed: FeedItem[];
  sessionId?: string;
}

export interface StorePort {
  load(): PersistedAgent[]; // on boot; the manager marks them stopped + resumable
  save(agents: PersistedAgent[]): void; // called debounced by the manager; must be atomic (tmp + rename)
}
