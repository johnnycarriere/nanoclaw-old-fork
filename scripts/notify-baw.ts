/**
 * notify-baw.ts — inject a system notice into a live agent session so the agent
 * reads it and (typically) relays it to the operator.
 *
 * Replaces the per-event notify-baw-*.ts one-offs. The target session is resolved
 * from the central DB: the group's most recently active CHAT session (one bound
 * to a messaging group), so no ids are hardcoded here. Chat sessions are
 * preferred over task sessions because scheduled tasks fire every few minutes
 * and would otherwise always be "most recent" — on 2026-09-28 the first use of
 * this script landed a deploy report in the refinery-bot-watchdog task session,
 * whose container consumed it inside a task run instead of the operator's chat.
 *
 * Usage:
 *   pnpm exec tsx scripts/notify-baw.ts --text "message"
 *   pnpm exec tsx scripts/notify-baw.ts --file path/to/message.md
 *   echo "message" | pnpm exec tsx scripts/notify-baw.ts
 *   pnpm exec tsx scripts/notify-baw.ts --group <folder> --text "..."   # default: telegram_main
 *   pnpm exec tsx scripts/notify-baw.ts --session <session-id> --text "..."
 *
 * The write goes through the host's inbound helper (even seq, same record shape
 * as the router). The running container picks it up on its next poll (~1s);
 * otherwise the 60s host sweep wakes the session.
 */
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { insertMessage, openInboundDb } from '../src/mailbox/sqlite/session-db.js';

const ROOT = join(import.meta.dirname, '..');
const CENTRAL_DB = join(ROOT, 'data', 'v2.db');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

function getText(): string {
  const text = arg('text');
  if (text) return text;
  const file = arg('file');
  if (file) return readFileSync(file, 'utf-8');
  const stdin = readFileSync(0, 'utf-8');
  if (stdin.trim()) return stdin;
  console.error('Usage: notify-baw.ts [--group <folder> | --session <id>] (--text "msg" | --file msg.md | stdin)');
  process.exit(1);
}

interface Target {
  session_id: string;
  agent_group_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
}

function resolveTarget(): Target {
  if (!existsSync(CENTRAL_DB)) {
    console.error(`Central DB not found at ${CENTRAL_DB}`);
    process.exit(1);
  }
  const central = new Database(CENTRAL_DB, { readonly: true });
  try {
    const sessionId = arg('session');
    const folder = arg('group') ?? 'telegram_main';
    const base = `SELECT s.id AS session_id, s.agent_group_id, s.thread_id,
                         mg.platform_id, mg.channel_type
                  FROM sessions s
                  JOIN agent_groups ag ON ag.id = s.agent_group_id
                  LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id`;
    const row = sessionId
      ? (central.prepare(`${base} WHERE s.id = ?`).get(sessionId) as Target | undefined)
      : (central
          .prepare(
            `${base} WHERE ag.folder = ? AND s.status = 'active'
             ORDER BY (s.messaging_group_id IS NOT NULL) DESC, s.last_active DESC, s.created_at DESC LIMIT 1`,
          )
          .get(folder) as Target | undefined);
    if (!row) {
      console.error(sessionId ? `No session ${sessionId}` : `No active session for agent group folder "${folder}"`);
      process.exit(1);
    }
    return row;
  } finally {
    central.close();
  }
}

const text = getText().trim();
const target = resolveTarget();
const dbPath = join(ROOT, 'data', 'v2-sessions', target.agent_group_id, target.session_id, 'inbound.db');
if (!existsSync(dbPath)) {
  console.error(`Session inbound DB not found: ${dbPath}`);
  process.exit(1);
}

const id = `notify-${Date.now()}:${target.agent_group_id}`;
const db = openInboundDb(dbPath);
try {
  insertMessage(db, {
    id,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: target.platform_id,
    channelType: target.channel_type,
    threadId: target.thread_id,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
    processAfter: null,
    recurrence: null,
    trigger: true,
  });
} finally {
  db.close();
}

console.log(`Injected ${id} → session ${target.session_id} (${target.channel_type ?? 'agent'} ${target.platform_id ?? ''})`);
