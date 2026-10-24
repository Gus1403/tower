import os from 'node:os';
import path from 'node:path';
import { AgentManager, towerDataDir } from './agents.js';
import { createServer } from './http.js';
import { startAgentSocket } from './agent-socket.js';
import { createAccounts } from './accounts.js';
import { createStore } from './store.js';

const token = process.env.TOWER_TOKEN;
if (!token) {
  console.error('TOWER_TOKEN is required; refusing to start');
  process.exit(1);
}

const host = process.env.TOWER_HOST || '127.0.0.1';
const port = Number(process.env.TOWER_PORT || 4747);
const workDir = path.resolve(
  (process.env.TOWER_WORK_DIR || '~/tower-work').replace(/^~/, os.homedir()),
);
const stuckMs = Number(process.env.TOWER_STUCK_MS || 300000);

process.on('unhandledRejection', (err) => console.error('[tower] unhandledRejection:', err));
process.on('uncaughtException', (err) => console.error('[tower] uncaughtException:', err));

const accounts = createAccounts();
const store = createStore();
const manager = new AgentManager({
  workDir,
  stuckMs,
  accounts,
  store,
  notesFile: path.join(towerDataDir(), 'notes.json'),
});
const server = createServer(manager, token);
const closeAgentSocket = startAgentSocket(manager);
accounts.start(
  (list) => server.broadcastAccounts(list),
  (accountId) => manager.countRunning(accountId),
);

server.listen(port, host, () => {
  console.log(`[tower] listening on http://${host}:${port} (work dir ${workDir})`);
});

const shutdown = async () => {
  console.log('[tower] shutting down, stopping agents');
  manager.shutdown();
  closeAgentSocket();
  accounts.stop();
  manager.saveNow();
  await manager.stopAll();
  manager.saveNow();
  server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
