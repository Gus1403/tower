// STUB — worker S2 replaces this file. Keeps the build green meanwhile.
import type { AccountsPort } from './ports.js';

export function createAccounts(): AccountsPort {
  return {
    list: () => [],
    envFor: (_kind, accountId) => ({ accountId, env: {} }),
    start: () => {},
    stop: () => {},
  };
}
