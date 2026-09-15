/** Retry explicit runner error reports, never text from ordinary agent replies. */
import type Database from 'better-sqlite3';

import { retryWithBackoff, markMessageFailed, openOutboundDbRw } from './mailbox/sqlite/session-db.js';
import { log } from './log.js';

const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 60_000;
const TRANSIENT_PATTERNS = [
  'ECONNRESET',
  'Unable to connect to API',
  'connection error',
  'serving MITM connection',
  'fetch failed',
  'ETIMEDOUT',
];

interface OutErrorRow {
  in_reply_to: string;
  content: string;
}

function retryAttempt(content: string): number | null {
  try {
    const report = JSON.parse(content);
    const attempt = report?.providerError?.attempt;
    if (
      report?.providerError?.source !== 'runner' ||
      !Number.isSafeInteger(attempt) ||
      attempt < 0 ||
      typeof report.text !== 'string' ||
      !TRANSIENT_PATTERNS.some((pattern) => report.text.includes(pattern))
    )
      return null;
    return attempt;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
}

export function detectAndRetryTransient(inDb: Database.Database, outDb: Database.Database, outDbPath: string): void {
  const errors = outDb
    .prepare(
      `SELECT in_reply_to, content FROM messages_out
     WHERE in_reply_to IS NOT NULL
       AND datetime(timestamp) >= datetime('now', '-30 minutes')
       AND kind = 'chat'`,
    )
    .all() as OutErrorRow[];

  for (const err of errors) {
    const attempt = retryAttempt(err.content);
    if (attempt === null) continue;
    const row = inDb.prepare('SELECT id, tries, status FROM messages_in WHERE id = ?').get(err.in_reply_to) as
      | { id: string; tries: number; status: string }
      | undefined;
    // tries is durable. Old error rows cannot replay after success or a host
    // restart, but a fresh error from the next attempt can retry again.
    if (!row || row.status !== 'completed' || row.tries !== attempt) continue;

    if (row.tries >= MAX_TRIES) {
      markMessageFailed(inDb, row.id);
      log.warn('Transient error reached MAX_TRIES — marking failed', { id: row.id, tries: row.tries });
      continue;
    }

    const backoffMs = BACKOFF_BASE_MS * Math.pow(2, row.tries);
    // The host owns inbound.db; update retry state in one transaction.
    inDb.transaction(() => {
      inDb.prepare("UPDATE messages_in SET status = 'pending' WHERE id = ?").run(row.id);
      retryWithBackoff(inDb, row.id, Math.floor(backoffMs / 1000));
    })();

    // Existing narrow exception to the outbound single-writer rule: release
    // the terminal ack so the container can claim this rescheduled message.
    const writable = openOutboundDbRw(outDbPath);
    try {
      writable.prepare('DELETE FROM processing_ack WHERE message_id = ?').run(row.id);
    } finally {
      writable.close();
    }
    log.info('Retrying message after transient error', { id: row.id, tries: row.tries, backoffMs });
  }
}
