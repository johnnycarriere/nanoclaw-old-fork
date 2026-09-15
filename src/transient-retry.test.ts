import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectAndRetryTransient } from './transient-retry.js';

let inbound: Database.Database;
let outbound: Database.Database;
let dir: string;
let outPath: string;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date());
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-retry-'));
  outPath = path.join(dir, 'outbound.db');
  inbound = new Database(':memory:');
  outbound = new Database(outPath);
  inbound.exec('CREATE TABLE messages_in (id TEXT PRIMARY KEY, status TEXT, tries INTEGER, process_after TEXT)');
  outbound.exec(
    'CREATE TABLE messages_out (in_reply_to TEXT, content TEXT, timestamp TEXT, kind TEXT); CREATE TABLE processing_ack (message_id TEXT PRIMARY KEY)',
  );
  inbound.prepare("INSERT INTO messages_in VALUES ('m1', 'completed', 0, NULL)").run();
});
afterEach(() => {
  inbound.close();
  outbound.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});
function report(attempt?: number, text = 'Error: ECONNRESET') {
  outbound.prepare("INSERT INTO messages_out VALUES ('m1', ?, ?, 'chat')").run(
    JSON.stringify({
      text,
      ...(attempt !== undefined ? { providerError: { source: 'runner', attempt } } : {}),
    }),
    new Date().toISOString(),
  );
  outbound.prepare("INSERT OR REPLACE INTO processing_ack VALUES ('m1')").run();
}
function state() {
  return inbound.prepare("SELECT * FROM messages_in WHERE id = 'm1'").get() as {
    status: string;
    tries: number;
    process_after: string;
  };
}
function sweep() {
  detectAndRetryTransient(inbound, outbound, outPath);
}

describe('explicit provider error retries', () => {
  it('does not retry successful replies mentioning a network error', () => {
    report(undefined, 'I fixed the fetch failed error and the service is healthy.');
    sweep();
    expect(state()).toMatchObject({ status: 'completed', tries: 0 });
  });
  it('fails closed for unmarked legacy errors and malformed reports', () => {
    report();
    outbound.prepare("INSERT INTO messages_out VALUES ('m1', ?, ?, 'chat')").run('{bad json', new Date().toISOString());
    report(-1);
    report(0.5);
    sweep();
    expect(state()).toMatchObject({ status: 'completed', tries: 0 });
  });
  it('does not retry permanent provider errors', () => {
    report(0, 'Error: billing_error');
    sweep();
    expect(state()).toMatchObject({ status: 'completed', tries: 0 });
  });
  it('retries every new failed attempt with backoff, then stops at the limit', () => {
    const now = Date.now();
    for (let attempt = 0; attempt < 5; attempt++) {
      inbound.prepare("UPDATE messages_in SET status = 'completed'").run();
      report(attempt);
      sweep();
      expect(state()).toMatchObject({ status: 'pending', tries: attempt + 1 });
      expect(Date.parse(state().process_after)).toBe(now + 60_000 * 2 ** attempt);
      expect(outbound.prepare('SELECT * FROM processing_ack').all()).toEqual([]);
      sweep();
      expect(state().tries).toBe(attempt + 1);
    }
    inbound.prepare("UPDATE messages_in SET status = 'completed'").run();
    report(5);
    sweep();
    expect(state()).toMatchObject({ status: 'failed', tries: 5 });
  });
  it('does not replay an old failure after success or a module restart', async () => {
    report(0);
    sweep();
    inbound.prepare("UPDATE messages_in SET status = 'completed'").run();
    vi.resetModules();
    const restarted = await import('./transient-retry.js');
    restarted.detectAndRetryTransient(inbound, outbound, outPath);
    expect(state()).toMatchObject({ status: 'completed', tries: 1 });
  });
  it('ignores errors while the message has not completed', () => {
    report(0);
    inbound.prepare("UPDATE messages_in SET status = 'pending'").run();
    sweep();
    expect(state().tries).toBe(0);
  });
});
