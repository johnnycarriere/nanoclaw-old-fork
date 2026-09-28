/**
 * Transient-error auto-retry.
 *
 * The agent-runner acks a batch `completed` even when the provider turn
 * failed with a transient API/proxy error (connection reset, gateway MITM
 * handshake, ...). It stamps `{ transient: true, batch_ids: [...] }` on the
 * error row it writes to messages_out (see poll-loop.ts). This host-side
 * sweep hook re-queues the whole batch by inserting NEW host-owned inbound
 * rows with a backoff `process_after`; host-sweep's due-message loop then
 * re-wakes the container. Retries are bounded durably by counting the retry
 * rows already present for the same original message. Nothing here writes to
 * outbound.db (container-owned) or flips an original row's status.
 */
import type Database from 'better-sqlite3';

import { log } from './log.js';
import { insertMessage } from './mailbox/sqlite/session-db.js';
import type { InboundWrite } from './mailbox/model.js';

export const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 60_000; // 60s, 2m, 4m, 8m, 16m
const RETRY_SEP = ':retry:';
const SCAN_WINDOW_SECONDS = 30 * 60;

interface OutErrorRow {
  id: string;
  in_reply_to: string | null;
  content: string;
}

interface InRow {
  id: string;
  kind: InboundWrite['kind'];
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  status: string;
  trigger: number;
  source_session_id: string | null;
}

/** The original (non-retry) inbound id a retry row descends from. */
export function retryRootId(id: string): string {
  const at = id.indexOf(RETRY_SEP);
  return at === -1 ? id : id.slice(0, at);
}

/** Outbound rows in the recent window that carry the runner's transient marker. */
function findTransientErrors(outDb: Database.Database): Array<OutErrorRow & { batchIds: string[] }> {
  const rows = outDb
    .prepare(
      `SELECT id, in_reply_to, content FROM messages_out
       WHERE kind = 'chat'
         AND datetime(timestamp) >= datetime('now', '-${SCAN_WINDOW_SECONDS} seconds')`,
    )
    .all() as OutErrorRow[];
  const out: Array<OutErrorRow & { batchIds: string[] }> = [];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || (parsed as { transient?: unknown }).transient !== true) continue;
    const rawIds = (parsed as { batch_ids?: unknown }).batch_ids;
    const batchIds = Array.isArray(rawIds) ? rawIds.filter((x): x is string => typeof x === 'string') : [];
    if (batchIds.length === 0 && row.in_reply_to) batchIds.push(row.in_reply_to);
    if (batchIds.length > 0) out.push({ ...row, batchIds });
  }
  return out;
}

function countRetries(inDb: Database.Database, rootId: string): number {
  const prefix = `${rootId}${RETRY_SEP}`;
  return (
    inDb.prepare('SELECT COUNT(*) AS n FROM messages_in WHERE substr(id, 1, ?) = ?').get(prefix.length, prefix) as {
      n: number;
    }
  ).n;
}

export function detectAndRetryTransient(inDb: Database.Database, outDb: Database.Database): void {
  const errors = findTransientErrors(outDb);
  if (errors.length === 0) return;

  const getIn = inDb.prepare(
    `SELECT id, kind, platform_id, channel_type, thread_id, content, status, trigger, source_session_id
       FROM messages_in WHERE id = ?`,
  );

  for (const err of errors) {
    for (const batchId of err.batchIds) {
      const rootId = retryRootId(batchId);
      // One retry row per (original message, error row): the error row's id
      // makes the retry id unique, so re-seeing the same error row on later
      // sweeps is a no-op via the primary key.
      const retryId = `${rootId}${RETRY_SEP}${err.id}`;
      if (getIn.get(retryId)) continue;

      const original = getIn.get(batchId) as InRow | undefined;
      if (!original || original.status !== 'completed') continue;

      const tries = countRetries(inDb, rootId);
      if (tries >= MAX_RETRIES) {
        log.warn('Transient error retry limit reached — not re-queuing', { id: rootId, tries });
        continue;
      }

      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, tries);
      insertMessage(inDb, {
        id: retryId,
        kind: original.kind,
        timestamp: new Date().toISOString(),
        platformId: original.platform_id,
        channelType: original.channel_type,
        threadId: original.thread_id,
        content: original.content,
        processAfter: new Date(Date.now() + backoffMs).toISOString(),
        recurrence: null,
        trigger: original.trigger === 1,
        sourceSessionId: original.source_session_id,
      });
      log.info('Re-queued message after transient error', { id: batchId, retryId, tries, backoffMs });
    }
  }
}
