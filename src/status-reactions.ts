/**
 * Host-side status-reaction emitter.
 *
 * Fires emoji reactions on inbound messages based on `processing_ack`
 * transitions: 👨‍💻 when the container claims a message, 👍 when the
 * container marks it completed/failed. Pairs with the 👀 reaction that
 * the telegram adapter fires on initial receive (see telegram.ts onInbound
 * wrapper). The result in the UI: eyes → typing-person → thumbs-up, in
 * sync with the real container lifecycle.
 *
 * State is persisted in the central DB (`host_reaction_state`, module
 * migration registered below) — *not* in-memory. This is load-bearing: `processing_ack` rows
 * accumulate forever (the container never deletes 'completed' rows; the
 * host's `clearStaleProcessingAcks` only clears 'processing'). With an
 * in-memory map any host restart, container compaction, or sweep tick
 * after the terminal-state delete would re-walk all the historic
 * 'completed' rows and re-fire 👍 on each. Most platforms silently dedupe
 * identical reactions so the regression hid for a while, but a context-
 * compaction reaction storm exposed it (26 simultaneous 👍 re-fires on
 * old messages). Persisting the last-emitted status per message kills
 * both restart-replay and sweep-loop replay.
 *
 * Session mailboxes (inbound/outbound) are read through raw SQLite handles
 * the caller opens briefly — this module is SQLite-mailbox-only by
 * construction. The central DB goes through the async `DbDriver`.
 */
import type Database from 'better-sqlite3';

import { getChannelAdapter, getChannelAdapterExact } from './channels/channel-registry.js';
import { getDb } from './db/connection.js';
import { registerMigration } from './db/migrations/index.js';
import { log } from './log.js';

// FORK: the durable "already emitted" record. Registered as a module
// migration (keeps src/db/migrations/index.ts un-diffed vs upstream).
// Idempotent DDL: installs that applied the pre-module 'host-reaction-state'
// entry re-run this harmlessly and pick up the module-qualified name.
registerMigration({
  version: 14,
  name: 'module:fork:host-reaction-state',
  async up(db) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS host_reaction_state (
        message_id   TEXT PRIMARY KEY,
        last_emitted TEXT NOT NULL CHECK (last_emitted IN ('processing', 'completed')),
        updated_at   TEXT NOT NULL
      );
    `);
  },
});

type EmittedStatus = 'processing' | 'completed';

interface AckRow {
  message_id: string;
  status: 'processing' | 'completed' | 'failed';
  status_changed: string;
}

export interface StatusReactionContext {
  /** Watermark key. Acks whose status_changed predates the last one seen for this key are skipped. */
  sessionId?: string;
  /** Composite inbound ids end in `:<agentGroupId>`; stripped to reach the platform id. */
  agentGroupId?: string;
  /** Messaging-group adapter instance; null/undefined falls back to channel type. */
  instance?: string | null;
}

// Per-session high-water mark of processing_ack.status_changed already
// examined (inclusive — the state table dedupes same-second neighbours).
// Seeded once per process from host_reaction_state so a restart does not
// re-walk the whole ack table; slack covers an ack that flipped between the
// read and the state write of the last pre-restart sweep.
const watermarks = new Map<string, string>();
const WATERMARK_SEED_SLACK_MS = 10 * 60 * 1000;
const PRUNE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

async function seedWatermark(key: string): Promise<string | undefined> {
  if (watermarks.has(key)) return watermarks.get(key);
  const row = await getDb().get<{ m: string | null }>('SELECT MAX(updated_at) AS m FROM host_reaction_state');
  const seed = row?.m ? new Date(new Date(row.m).getTime() - WATERMARK_SEED_SLACK_MS).toISOString() : undefined;
  if (seed) watermarks.set(key, seed);
  return seed;
}

async function pruneReactionState(): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  await getDb().run(
    'DELETE FROM host_reaction_state WHERE updated_at < ?',
    new Date(now - PRUNE_AFTER_MS).toISOString(),
  );
}

/** Test seam: forget per-session watermarks. */
export function resetStatusReactionWatermarks(): void {
  watermarks.clear();
  lastPruneAt = 0;
}

interface InMsgRow {
  id: string;
  channel_type: string;
  platform_id: string;
}

interface ReactionStateRow {
  message_id: string;
  last_emitted: EmittedStatus;
}

// processing_ack grows unboundedly (completed rows are never deleted), so an
// IN clause with one placeholder per row eventually exceeds SQLite's bind
// limit (SQLITE_MAX_VARIABLE_NUMBER, 32766 in better-sqlite3) and every query
// throws "too many SQL variables" — batch the lookups well under the limit.
const IN_CLAUSE_BATCH = 900;

function selectByIdsChunked<T>(
  db: Database.Database,
  sqlTemplate: (placeholders: string) => string,
  ids: string[],
): T[] {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CLAUSE_BATCH) {
    const chunk = ids.slice(i, i + IN_CLAUSE_BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    out.push(...(db.prepare(sqlTemplate(placeholders)).all(...chunk) as T[]));
  }
  return out;
}

async function selectCentralByIdsChunked<T>(
  sqlTemplate: (placeholders: string) => string,
  ids: string[],
): Promise<T[]> {
  const db = getDb();
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CLAUSE_BATCH) {
    const chunk = ids.slice(i, i + IN_CLAUSE_BATCH);
    const placeholders = chunk.map(() => '?').join(',');
    out.push(...(await db.all<T>(sqlTemplate(placeholders), ...chunk)));
  }
  return out;
}

const UPSERT_STATE_SQL = `INSERT INTO host_reaction_state (message_id, last_emitted, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       last_emitted = excluded.last_emitted,
       updated_at = excluded.updated_at`;

/**
 * Inspect processing_ack for newly-seen transitions and emit reactions.
 * Called after the sweep has applied processing acks so we're looking at
 * the current, canonical state.
 */
export async function emitStatusReactions(
  inDb: Database.Database,
  outDb: Database.Database,
  ctx: StatusReactionContext = {},
): Promise<void> {
  const key = ctx.sessionId ?? '';
  const since = await seedWatermark(key);
  const rows = (
    since
      ? outDb
          .prepare(
            'SELECT message_id, status, status_changed FROM processing_ack WHERE datetime(status_changed) >= datetime(?)',
          )
          .all(since)
      : outDb.prepare('SELECT message_id, status, status_changed FROM processing_ack').all()
  ) as AckRow[];
  await pruneReactionState();
  if (rows.length === 0) return;
  const maxSeen = rows.reduce((m, r) => (r.status_changed > m ? r.status_changed : m), rows[0].status_changed);
  watermarks.set(key, maxSeen);

  const ids = rows.map((r) => r.message_id);

  // Look up the matching inbound rows.
  const inRows = selectByIdsChunked<InMsgRow>(
    inDb,
    (ph) => `SELECT id, channel_type, platform_id FROM messages_in WHERE id IN (${ph})`,
    ids,
  );
  const inById = new Map(inRows.map((r) => [r.id, r]));

  // Pull the durable "already emitted" record for these same ids.
  const stateRows = await selectCentralByIdsChunked<ReactionStateRow>(
    (ph) => `SELECT message_id, last_emitted FROM host_reaction_state WHERE message_id IN (${ph})`,
    ids,
  );
  const stateById = new Map(stateRows.map((r) => [r.message_id, r.last_emitted]));

  const centralDb = getDb();
  for (const row of rows) {
    const last = stateById.get(row.message_id);
    const inMsg = inById.get(row.message_id);
    if (!inMsg) continue;

    if (row.status === 'processing' && last !== 'processing' && last !== 'completed') {
      await fireReaction(inMsg, '👨‍💻', ctx);
      await centralDb.run(UPSERT_STATE_SQL, row.message_id, 'processing', new Date().toISOString());
    } else if ((row.status === 'completed' || row.status === 'failed') && last !== 'completed') {
      await fireReaction(inMsg, '👍', ctx);
      await centralDb.run(UPSERT_STATE_SQL, row.message_id, 'completed', new Date().toISOString());
    }
  }
}

/**
 * Idempotent backfill: mark every currently-known completed processing_ack
 * row as already-emitted, without firing reactions. Run once at host
 * startup after migrations, so the first post-upgrade sweep doesn't try
 * to re-fire 👍 across the entire historic backlog (a long-lived agent
 * accumulates hundreds of completed acks; some platforms don't dedupe
 * silently and the user sees a reaction storm). Safe to run on every
 * startup — entries are insert-or-ignored.
 */
export async function backfillReactionStateFromOutDb(outDb: Database.Database): Promise<void> {
  const completed = outDb
    .prepare("SELECT message_id FROM processing_ack WHERE status IN ('completed', 'failed')")
    .all() as Array<{ message_id: string }>;
  if (completed.length === 0) return;

  const db = getDb();
  const now = new Date().toISOString();
  // Multi-row inserts, chunked under the bind limit (2 params per row).
  const ROWS_PER_STMT = Math.floor(IN_CLAUSE_BATCH / 2);
  await db.transaction(async () => {
    for (let i = 0; i < completed.length; i += ROWS_PER_STMT) {
      const chunk = completed.slice(i, i + ROWS_PER_STMT);
      const values = chunk.map(() => "(?, 'completed', ?)").join(',');
      const params: string[] = [];
      for (const r of chunk) params.push(r.message_id, now);
      await db.run(
        `INSERT OR IGNORE INTO host_reaction_state (message_id, last_emitted, updated_at) VALUES ${values}`,
        ...params,
      );
    }
  });
}

/**
 * Platform-native message id from the composite inbound id
 * `<platform message id>:<agentGroupId>` (router.ts). Telegram platform ids
 * are `<chat>:<msgId>`; an id with no `:` after the suffix strip is another
 * platform's opaque id and yields undefined (no reaction).
 */
export function nativeMessageId(compositeId: string, agentGroupId?: string): string | undefined {
  let platformPart: string;
  if (agentGroupId !== undefined) {
    const suffix = `:${agentGroupId}`;
    if (!compositeId.endsWith(suffix)) return undefined;
    platformPart = compositeId.slice(0, -suffix.length);
  } else {
    const at = compositeId.lastIndexOf(':');
    if (at === -1) return undefined;
    platformPart = compositeId.slice(0, at);
  }
  const at = platformPart.lastIndexOf(':');
  if (at === -1) return undefined;
  return platformPart.slice(at + 1) || undefined;
}

async function fireReaction(inMsg: InMsgRow, emoji: string, ctx: StatusReactionContext): Promise<void> {
  const adapter = ctx.instance ? getChannelAdapterExact(ctx.instance) : getChannelAdapter(inMsg.channel_type);
  if (!adapter?.postReaction) return;
  const nativeMsgId = nativeMessageId(inMsg.id, ctx.agentGroupId);
  if (!nativeMsgId) return;
  try {
    await adapter.postReaction(inMsg.platform_id, nativeMsgId, emoji);
  } catch (err) {
    log.debug('postReaction failed', { emoji, id: inMsg.id, err });
  }
}
