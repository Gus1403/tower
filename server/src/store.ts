// Persists agent cards + feeds to TOWER_DATA_DIR/agents.json (atomic tmp + rename).
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PersistedAgent, StorePort } from './ports.js';

export function createStore(): StorePort {
  const dir = process.env.TOWER_DATA_DIR || path.join(os.homedir(), '.local', 'state', 'tower');
  const file = path.join(dir, 'agents.json');
  let warned = false;
  return {
    load(): PersistedAgent[] {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        return [];
      }
      try {
        const data = JSON.parse(raw);
        if (!Array.isArray(data)) throw new Error('not an array');
        return data.filter((x) => x && typeof x === 'object' && x.summary && Array.isArray(x.feed)) as PersistedAgent[];
      } catch (e) {
        if (!warned) {
          warned = true;
          console.warn(`[tower] store: ignoring unreadable ${file}: ${(e as Error).message}`);
        }
        return [];
      }
    },
    save(agents: PersistedAgent[]): void {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(agents), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    },
  };
}
