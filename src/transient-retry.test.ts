import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './mailbox/sqlite/schema.js';
import { insertMessage } from './mailbox/sqlite/session-db.js';
import { detectAndRetryTransient, MAX_RETRIES } from './transient-retry.js';

let inDb: Database.Database;
let outDb: Database.Database;

interface InRow {
  id: string;
  seq: number;
  status: string;
  process_after: string | null;
  content: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  kind: string;
}

function seedInbound(id: string, status = 'completed'): void {
  insertMessage(inDb, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: 'telegram:123',
    channelType: 'telegram',
    threadId: 't1',
    content: JSON.stringify({ text: `hello from ${id}` }),
    processAfter: null,
    recurrence: null,
  });
  inDb.prepare('UPDATE messages_in SET status = ? WHERE id = ?').run(status, id);
}

function seedOutbound(id: string, inReplyTo: string | null, content: Record<string, unknown>, seq = 1): void {
  outDb
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, ?, ?, 'chat', 'telegram:123', 'telegram', 't1', ?)`,
    )
    .run(id, seq, inReplyTo, new Date().toISOString(), JSON.stringify(content));
}

function inRows(): InRow[] {
  return inDb.prepare('SELECT * FROM messages_in ORDER BY seq').all() as InRow[];
}

beforeEach(() => {
  inDb = new Database(':memory:');
  outDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  outDb.exec(OUTBOUND_SCHEMA);
});

afterEach(() => {
  inDb.close();
  outDb.close();
});

describe('detectAndRetryTransient', () => {
  it('re-queues a marked error as a new even-seq inbound row with backoff', () => {
    seedInbound('m1');
    seedOutbound('o1', 'm1', { text: 'Error: fetch failed', transient: true, batch_ids: ['m1'] });

    detectAndRetryTransient(inDb, outDb);

    const rows = inRows();
    expect(rows).toHaveLength(2);
    const [orig, retry] = rows;
    expect(orig.status).toBe('completed');
    expect(retry.id).toBe('m1:retry:o1');
    expect(retry.status).toBe('pending');
    expect(retry.seq % 2).toBe(0);
    expect(retry.content).toBe(orig.content);
    expect(retry.platform_id).toBe('telegram:123');
    expect(retry.thread_id).toBe('t1');
    expect(retry.process_after).not.toBeNull();
    expect(new Date(retry.process_after!).getTime()).toBeGreaterThan(Date.now() + 30_000);

    // Same error row on the next sweep: nothing new.
    detectAndRetryTransient(inDb, outDb);
    expect(inRows()).toHaveLength(2);
  });

  it('ignores chat rows that merely contain an error-looking substring', () => {
    seedInbound('m1');
    seedOutbound('o1', 'm1', { text: 'I saw ETIMEDOUT in your logs, here is what it means' });

    detectAndRetryTransient(inDb, outDb);
    expect(inRows()).toHaveLength(1);
  });

  it('never writes status failed and stops after MAX_RETRIES', () => {
    seedInbound('m1');
    for (let i = 0; i < MAX_RETRIES + 2; i++) {
      seedOutbound(`o${i}`, 'm1', { text: 'Error: ECONNRESET', transient: true, batch_ids: ['m1'] }, i + 1);
      detectAndRetryTransient(inDb, outDb);
    }
    const rows = inRows();
    expect(rows).toHaveLength(1 + MAX_RETRIES);
    expect(rows.some((r) => r.status === 'failed')).toBe(false);
  });

  it('counts retries of retries against the original id', () => {
    seedInbound('m1');
    seedOutbound('o1', 'm1', { text: 'Error: ECONNRESET', transient: true, batch_ids: ['m1'] }, 1);
    detectAndRetryTransient(inDb, outDb);
    // The retry itself completes with a transient error.
    inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'm1:retry:o1'").run();
    seedOutbound('o2', 'm1:retry:o1', { text: 'Error: ECONNRESET', transient: true, batch_ids: ['m1:retry:o1'] }, 3);
    detectAndRetryTransient(inDb, outDb);
    const ids = inRows().map((r) => r.id);
    expect(ids).toEqual(['m1', 'm1:retry:o1', 'm1:retry:o2']);
    const second = inRows()[2];
    // Second retry backs off twice as long.
    expect(new Date(second.process_after!).getTime()).toBeGreaterThan(Date.now() + 90_000);
  });

  it('retries the whole batch, not just in_reply_to', () => {
    seedInbound('m1');
    seedInbound('m2');
    seedInbound('m3');
    seedOutbound('o1', 'm1', {
      text: 'Error: Unable to connect to API',
      transient: true,
      batch_ids: ['m1', 'm2', 'm3'],
    });

    detectAndRetryTransient(inDb, outDb);
    const ids = inRows().map((r) => r.id);
    expect(ids).toEqual(['m1', 'm2', 'm3', 'm1:retry:o1', 'm2:retry:o1', 'm3:retry:o1']);
  });

  it('skips originals that are not completed', () => {
    seedInbound('m1', 'processing');
    seedOutbound('o1', 'm1', { text: 'Error: fetch failed', transient: true, batch_ids: ['m1'] });
    detectAndRetryTransient(inDb, outDb);
    expect(inRows()).toHaveLength(1);
  });
});
