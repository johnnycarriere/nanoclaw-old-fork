/**
 * Status-reaction emission idempotency.
 *
 * The pre-fix bug: in-memory map of "already emitted" statuses meant any
 * sweep tick after the terminal-state delete (or any host restart) would
 * re-walk the perpetually-growing `processing_ack` table and re-fire 👍
 * on every historic completed row. Telegram dedup hid it most of the
 * time, but a context-compaction storm exposed 26 simultaneous re-fires.
 *
 * Fix: persist last-emitted status per message in `host_reaction_state`
 * (module migration `module:fork:host-reaction-state`). These tests lock in the no-replay behavior across
 * sweep ticks AND across simulated host restarts.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./channels/channel-registry.js', () => ({
  getChannelAdapter: vi.fn(),
  getChannelAdapterExact: vi.fn(),
}));

import { getChannelAdapter, getChannelAdapterExact } from './channels/channel-registry.js';
import { initTestDb, closeDb, runMigrations, getDb } from './db/index.js';
import {
  backfillReactionStateFromOutDb,
  emitStatusReactions,
  nativeMessageId,
  resetStatusReactionWatermarks,
} from './status-reactions.js';

interface MockAdapter {
  postReaction: ReturnType<typeof vi.fn>;
}

const mockAdapter: MockAdapter = {
  postReaction: vi.fn().mockResolvedValue(undefined),
};

const INBOUND_SCHEMA = `
  CREATE TABLE messages_in (
    id           TEXT PRIMARY KEY,
    seq          INTEGER,
    kind         TEXT NOT NULL,
    timestamp    TEXT NOT NULL,
    status       TEXT DEFAULT 'pending',
    platform_id  TEXT,
    channel_type TEXT,
    thread_id    TEXT,
    content      TEXT NOT NULL
  );
`;

const OUTBOUND_SCHEMA = `
  CREATE TABLE processing_ack (
    message_id     TEXT PRIMARY KEY,
    status         TEXT NOT NULL,
    status_changed TEXT NOT NULL
  );
`;

let inDb: Database.Database;
let outDb: Database.Database;

function seedInbound(messageIds: string[]): void {
  const stmt = inDb.prepare(
    `INSERT INTO messages_in (id, kind, timestamp, status, channel_type, platform_id, content)
     VALUES (?, 'chat-sdk', datetime('now'), 'completed', 'telegram', 'telegram:123', '{}')`,
  );
  for (const id of messageIds) stmt.run(id);
}

function seedAck(messageId: string, status: 'processing' | 'completed' | 'failed'): void {
  outDb
    .prepare(
      "INSERT OR REPLACE INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, datetime('now'))",
    )
    .run(messageId, status);
}

beforeEach(async () => {
  const db = await initTestDb();
  await runMigrations(db);
  inDb = new Database(':memory:');
  outDb = new Database(':memory:');
  inDb.exec(INBOUND_SCHEMA);
  outDb.exec(OUTBOUND_SCHEMA);
  mockAdapter.postReaction.mockClear();
  vi.mocked(getChannelAdapter)
    .mockReset()
    .mockReturnValue(mockAdapter as never);
  vi.mocked(getChannelAdapterExact)
    .mockReset()
    .mockReturnValue(mockAdapter as never);
  resetStatusReactionWatermarks();
});

afterEach(async () => {
  inDb.close();
  outDb.close();
  await closeDb();
});

describe('emitStatusReactions — idempotency', () => {
  it('fires 👨‍💻 once per processing transition, not on subsequent sweeps', async () => {
    seedInbound(['1644976441:100:ag-1']);
    seedAck('1644976441:100:ag-1', 'processing');

    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(1);
    expect(mockAdapter.postReaction).toHaveBeenCalledWith('telegram:123', '100', '👨‍💻');

    // Subsequent sweep tick — same processing_ack row, no transition.
    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(1);
  });

  it('fires 👍 once per completion, not on subsequent sweeps', async () => {
    seedInbound(['1644976441:200:ag-1']);
    seedAck('1644976441:200:ag-1', 'completed');

    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(1);
    expect(mockAdapter.postReaction).toHaveBeenCalledWith('telegram:123', '200', '👍');

    // Repeat sweeps — completed row stays in processing_ack forever; we
    // must not re-fire each time.
    for (let i = 0; i < 5; i++) await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(1);
  });

  it('does not replay 👍 on historic completed rows across many sweep ticks (the original bug)', async () => {
    // Simulates the regression that exposed the bug: a long-running
    // session has accumulated many completed processing_ack rows. The
    // first sweep emits 👍 for each (the legitimate fires). Every
    // subsequent sweep must be a no-op — the pre-fix code would re-fire
    // all 25 every tick because the in-memory map was deleted on
    // terminal emission.
    const ids = Array.from({ length: 25 }, (_, i) => `1644976441:${300 + i}:ag-1`);
    seedInbound(ids);
    for (const id of ids) seedAck(id, 'completed');

    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(25);
    mockAdapter.postReaction.mockClear();

    // 10 more sweep ticks — same processing_ack contents, no transitions.
    // Pre-fix: 250 re-fires. Post-fix: 0.
    for (let i = 0; i < 10; i++) await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(0);
  });

  it('still fires for the next *new* completion after historic rows are persisted', async () => {
    seedInbound(['1644976441:400:ag-1', '1644976441:401:ag-1']);
    seedAck('1644976441:400:ag-1', 'completed');

    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(1);
    mockAdapter.postReaction.mockClear();

    // A fresh message hits completed — only this one should fire, not the
    // historic 400 row.
    seedAck('1644976441:401:ag-1', 'completed');
    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(1);
    expect(mockAdapter.postReaction).toHaveBeenCalledWith('telegram:123', '401', '👍');
  });

  it('backfill suppresses replay across upgrade — populated state, no fires on first sweep', async () => {
    // Simulate the upgrade path: existing install has 50 historic
    // completed acks, none recorded in host_reaction_state yet (the
    // table was empty when the migration ran).
    const ids = Array.from({ length: 50 }, (_, i) => `1644976441:${600 + i}:ag-1`);
    seedInbound(ids);
    for (const id of ids) seedAck(id, 'completed');

    await backfillReactionStateFromOutDb(outDb);

    // host_reaction_state must now have one 'completed' entry per ack.
    const stateCount = (await getDb().get<{ n: number }>('SELECT COUNT(*) AS n FROM host_reaction_state'))!.n;
    expect(stateCount).toBe(50);

    // First sweep tick after upgrade — nothing should fire.
    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(0);
  });

  it('backfill is safe to run twice — does not overwrite an existing processing state', async () => {
    seedInbound(['1644976441:700:ag-1']);
    seedAck('1644976441:700:ag-1', 'processing');

    // The agent is mid-flight: state recorded as 'processing'.
    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(1);

    // Backfill should NOT clobber the in-flight 'processing' entry to
    // 'completed' just because the row also matches the backfill query.
    // (It only matches if the ack itself is 'completed', so this case
    // shouldn't even be reachable, but guard against future regression.)
    await backfillReactionStateFromOutDb(outDb);
    const state = await getDb().get<{ last_emitted: string }>(
      'SELECT last_emitted FROM host_reaction_state WHERE message_id = ?',
      '1644976441:700:ag-1',
    );
    expect(state?.last_emitted).toBe('processing');
  });

  it('survives processing_ack tables larger than the SQLite bind-variable limit', async () => {
    // Regression: a long-lived session accumulated 33k+ completed acks and
    // the single IN (...) query with one placeholder per row blew past
    // SQLITE_MAX_VARIABLE_NUMBER (32766), throwing "too many SQL variables"
    // on every sweep tick — which killed the whole sweep loop, including
    // stuck-container detection. Seed past the limit and assert the emitter
    // both runs and still fires correctly for a fresh completion.
    const ids = Array.from({ length: 33000 }, (_, i) => `1644976441:${i}:ag-1`);
    inDb.exec('BEGIN');
    seedInbound(ids);
    inDb.exec('COMMIT');
    outDb.exec('BEGIN');
    for (const id of ids) seedAck(id, 'completed');
    outDb.exec('COMMIT');
    await backfillReactionStateFromOutDb(outDb);

    await expect(emitStatusReactions(inDb, outDb)).resolves.toBeUndefined();
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(0);

    // A brand-new completion among the huge backlog still fires exactly once.
    seedInbound(['1644976441:99999:ag-1']);
    seedAck('1644976441:99999:ag-1', 'completed');
    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(1);
    expect(mockAdapter.postReaction).toHaveBeenCalledWith('telegram:123', '99999', '👍');
  });

  it('upgrades processing → completed without re-firing 👨‍💻', async () => {
    seedInbound(['1644976441:500:ag-1']);
    seedAck('1644976441:500:ag-1', 'processing');

    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(1);
    expect(mockAdapter.postReaction).toHaveBeenLastCalledWith('telegram:123', '500', '👨‍💻');

    // Container marks it completed — should fire 👍 exactly once, no more
    // 👨‍💻 fires.
    seedAck('1644976441:500:ag-1', 'completed');
    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(2);
    expect(mockAdapter.postReaction).toHaveBeenLastCalledWith('telegram:123', '500', '👍');

    // And no further fires on subsequent ticks.
    await emitStatusReactions(inDb, outDb);
    await emitStatusReactions(inDb, outDb);
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(2);
  });
});

describe('nativeMessageId', () => {
  it('strips the known agent-group suffix and takes the telegram message id', () => {
    expect(nativeMessageId('1644976441:100:ag-1', 'ag-1')).toBe('100');
    // Agent group ids may themselves contain ':' — only the exact suffix is stripped.
    expect(nativeMessageId('1644976441:100:ag:x', 'ag:x')).toBe('100');
  });

  it('yields nothing for non-telegram ids (no ":" left after the strip)', () => {
    expect(nativeMessageId('discord-msg-1:ag-1', 'ag-1')).toBeUndefined();
    expect(nativeMessageId('1644976441:100:ag-1', 'other')).toBeUndefined();
  });

  it('falls back to last-segment strip when the agent group is unknown', () => {
    expect(nativeMessageId('1644976441:100:ag-1')).toBe('100');
    expect(nativeMessageId('opaque:ag-1')).toBeUndefined();
  });
});

describe('emitStatusReactions — adapter and id resolution', () => {
  it('skips non-telegram composite ids instead of posting a bogus reaction', async () => {
    seedInbound(['discord-msg-1:ag-1']);
    seedAck('discord-msg-1:ag-1', 'completed');
    await emitStatusReactions(inDb, outDb, { agentGroupId: 'ag-1' });
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(0);
  });

  it('resolves the adapter by the messaging-group instance when one is recorded', async () => {
    const exact: MockAdapter = { postReaction: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(getChannelAdapterExact).mockReturnValue(exact as never);
    seedInbound(['1644976441:900:ag-1']);
    seedAck('1644976441:900:ag-1', 'completed');
    await emitStatusReactions(inDb, outDb, { agentGroupId: 'ag-1', instance: 'telegram-2' });
    expect(getChannelAdapterExact).toHaveBeenCalledWith('telegram-2');
    expect(exact.postReaction).toHaveBeenCalledWith('telegram:123', '900', '👍');
    expect(mockAdapter.postReaction).toHaveBeenCalledTimes(0);
  });
});
