// Upload storage. BS1 resolves prompt attachments through getUpload().
// Layout: <TOWER_DATA_DIR or ~/.local/state/tower>/uploads/<id> (bytes, 600) + <id>.json sidecar; dir 700.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';

export interface StoredUpload {
  id: string;
  name: string; // sanitized basename
  path: string; // absolute path of the stored bytes
  size: number;
}

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const ID_RE = /^[a-f0-9]{32}$/;
const index = new Map<string, StoredUpload>();

export function dataDir(): string {
  return process.env.TOWER_DATA_DIR || path.join(os.homedir(), '.local', 'state', 'tower');
}

export function uploadsDir(): string {
  return path.join(dataDir(), 'uploads');
}

export function sanitizeName(raw: string | null | undefined): string {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  let s = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 100);
  if (!s || /^[._-]*$/.test(s)) s = 'upload';
  return s;
}

export function getUpload(id: string): StoredUpload | undefined {
  if (typeof id !== 'string' || !ID_RE.test(id)) return undefined;
  const hit = index.get(id);
  if (hit) return hit;
  try {
    const dir = uploadsDir();
    const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8')) as StoredUpload;
    const p = path.join(dir, id);
    const st = fs.statSync(p);
    const up: StoredUpload = { id, name: sanitizeName(meta.name), path: p, size: st.size };
    index.set(id, up);
    return up;
  } catch {
    return undefined;
  }
}

export type SaveResult = { ok: true; upload: StoredUpload } | { ok: false; code: 413 | 500; error: string };

/** Streams the request body to disk; on overflow removes the partial file and reports 413 (caller answers + destroys). */
export function saveUpload(req: http.IncomingMessage, rawName: string | null): Promise<SaveResult> {
  const name = sanitizeName(rawName);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return Promise.resolve({ ok: false, code: 413, error: 'upload too large (max 20 MB)' });
  }
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* ignore */
  }
  const id = randomBytes(16).toString('hex');
  const p = path.join(dir, id);
  return new Promise((resolve) => {
    let size = 0;
    let done = false;
    const out = fs.createWriteStream(p, { mode: 0o600 });
    const fail = (code: 413 | 500, error: string) => {
      if (done) return;
      done = true;
      req.unpipe(out);
      out.destroy();
      fs.rm(p, { force: true }, () => {});
      resolve({ ok: false, code, error });
    };
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_UPLOAD_BYTES) fail(413, 'upload too large (max 20 MB)');
    });
    req.on('error', () => fail(500, 'upload aborted'));
    out.on('error', () => fail(500, 'could not store upload'));
    out.on('finish', () => {
      if (done) return;
      done = true;
      const up: StoredUpload = { id, name, path: p, size };
      try {
        fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, name, size }), { mode: 0o600 });
      } catch {
        /* index still works this process */
      }
      index.set(id, up);
      resolve({ ok: true, upload: up });
    });
    req.pipe(out);
  });
}
