/**
 * Fork wrapper over the skill-managed Telegram adapter (telegram-fork.ts).
 *
 *  - web_app cards: a failed Bot API send THROWS (so delivery.ts retries /
 *    marks failed instead of acknowledging a phantom send); group chats get
 *    a URL link-button card through the inner adapter instead, because the
 *    Bot API rejects web_app reply keyboards outside private chats.
 *  - 👀 acknowledgement only for inbound the router will act on: known
 *    senders (role, membership, public chat) or group @mentions — never an
 *    unknown sender's DM. Non-blocking.
 *  - outbound text splits at TELEGRAM_FORK_MAX_TEXT (3000), files on the
 *    first chunk only.
 *
 * Real central DB (migrations applied); the Bot API boundary (fetch) and the
 * inner adapter are stubs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../db/index.js';
import { createMessagingGroupAgent } from '../db/messaging-groups.js';
import { addMember } from '../modules/permissions/db/agent-group-members.js';
import { grantRole } from '../modules/permissions/db/user-roles.js';
import { upsertUser } from '../modules/permissions/db/users.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { TELEGRAM_FORK_MAX_TEXT, shouldAcknowledgeInbound, wrapTelegramForFork } from './telegram-fork.js';

const now = () => new Date().toISOString();

interface StubCalls {
  deliver: Array<{ platformId: string; threadId: string | null; message: OutboundMessage }>;
  reactions: Array<{ platformId: string; messageId: string; emoji: string }>;
}

function stubAdapter(calls: StubCalls): ChannelAdapter & { lastSetup?: ChannelSetup } {
  const adapter = {
    name: 'telegram',
    channelType: 'telegram',
    supportsThreads: false,
    async setup(hostConfig: ChannelSetup) {
      adapter.lastSetup = hostConfig;
    },
    async teardown() {},
    async deliver(platformId: string, threadId: string | null, message: OutboundMessage) {
      calls.deliver.push({ platformId, threadId, message });
      return `inner-${calls.deliver.length}`;
    },
    async postReaction(platformId: string, messageId: string, emoji: string) {
      calls.reactions.push({ platformId, messageId, emoji });
    },
    isConnected: () => true,
  } as unknown as ChannelAdapter & { lastSetup?: ChannelSetup };
  return adapter;
}

function webAppMessage(): OutboundMessage {
  return {
    kind: 'chat-sdk',
    content: {
      type: 'card',
      card: { title: 'Pick a verse', actions: [{ label: 'Open picker', webAppUrl: 'https://app.example/pick' }] },
    },
  };
}

function inbound(userId: string | null, isMention?: boolean): InboundMessage {
  return {
    id: 'm-1',
    kind: 'chat-sdk',
    content: { text: 'hi', author: userId ? { userId } : undefined },
    timestamp: now(),
    isMention,
  };
}

const fetchMock = vi.fn();
let calls: StubCalls;

beforeEach(async () => {
  calls = { deliver: [], reactions: [] };
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  const db = await initTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await closeDb();
  vi.unstubAllGlobals();
});

describe('wrapTelegramForFork — web_app cards', () => {
  it('private chat: posts a reply-keyboard web_app button and returns the message id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 }),
    );
    const wrapped = wrapTelegramForFork(stubAdapter(calls), 'tok')!;
    const id = await wrapped.deliver('telegram:123', null, webAppMessage());
    expect(id).toBe('42');
    expect(calls.deliver).toHaveLength(0);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.chat_id).toBe('123');
    expect(body.reply_markup.keyboard[0][0].web_app.url).toBe('https://app.example/pick');
  });

  it('throws on a non-OK Bot API response instead of returning undefined', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 }),
    );
    const wrapped = wrapTelegramForFork(stubAdapter(calls), 'tok')!;
    await expect(wrapped.deliver('telegram:123', null, webAppMessage())).rejects.toThrow(/chat not found/);
  });

  it('throws on a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    const wrapped = wrapTelegramForFork(stubAdapter(calls), 'tok')!;
    await expect(wrapped.deliver('telegram:123', null, webAppMessage())).rejects.toThrow(/ECONNRESET/);
  });

  it('group chat: never sends a web_app keyboard; falls back to a URL link button via the inner adapter', async () => {
    const wrapped = wrapTelegramForFork(stubAdapter(calls), 'tok')!;
    const id = await wrapped.deliver('telegram:-100555', null, webAppMessage());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(id).toBe('inner-1');
    const content = calls.deliver[0].message.content as { card: { actions: Array<Record<string, unknown>> } };
    expect(content.card.actions).toEqual([{ label: 'Open picker', url: 'https://app.example/pick' }]);
  });
});

describe('wrapTelegramForFork — outbound splitting', () => {
  it('splits text over TELEGRAM_FORK_MAX_TEXT into ≤3000-char chunks, files on the first only', async () => {
    const wrapped = wrapTelegramForFork(stubAdapter(calls), 'tok')!;
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
    expect(text.length).toBeGreaterThan(TELEGRAM_FORK_MAX_TEXT);
    const files = [{ filename: 'a.txt', data: Buffer.from('a') }];
    const id = await wrapped.deliver('telegram:123', null, { kind: 'chat-sdk', content: { text }, files });
    expect(id).toBe('inner-1');
    expect(calls.deliver.length).toBeGreaterThan(1);
    for (const c of calls.deliver) {
      expect(((c.message.content as { text: string }).text ?? '').length).toBeLessThanOrEqual(TELEGRAM_FORK_MAX_TEXT);
    }
    expect(calls.deliver[0].message.files).toBe(files);
    expect(calls.deliver[1].message.files).toBeUndefined();
    expect(calls.deliver.map((c) => (c.message.content as { text: string }).text).join('\n')).toBe(text);
  });

  it('short text and cards pass through untouched', async () => {
    const wrapped = wrapTelegramForFork(stubAdapter(calls), 'tok')!;
    await wrapped.deliver('telegram:123', null, { kind: 'chat-sdk', content: { markdown: 'hello' } });
    expect(calls.deliver).toHaveLength(1);
    expect(calls.deliver[0].message.content).toEqual({ markdown: 'hello' });
  });
});

describe('shouldAcknowledgeInbound', () => {
  async function seedWiredChat(policy: 'strict' | 'public'): Promise<void> {
    await createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:123',
      instance: 'telegram',
      name: null,
      is_group: 0,
      unknown_sender_policy: policy,
      created_at: now(),
    });
    await createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  }

  it('owner DM → true (the operator always gets the 👀)', async () => {
    await upsertUser({ id: 'telegram:7', kind: 'telegram', display_name: null, created_at: now() });
    await grantRole({
      user_id: 'telegram:7',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    expect(await shouldAcknowledgeInbound('telegram:123', inbound('7'))).toBe(true);
  });

  it('unknown sender DM → false, even on a wired strict chat', async () => {
    await seedWiredChat('strict');
    expect(await shouldAcknowledgeInbound('telegram:123', inbound('999'))).toBe(false);
  });

  it('member of the wired agent group → true', async () => {
    await seedWiredChat('strict');
    await upsertUser({ id: 'telegram:8', kind: 'telegram', display_name: null, created_at: now() });
    await addMember({ user_id: 'telegram:8', agent_group_id: 'ag-1', added_by: null, added_at: now() });
    expect(await shouldAcknowledgeInbound('telegram:123', inbound('8'))).toBe(true);
  });

  it('public chat → any sender', async () => {
    await seedWiredChat('public');
    expect(await shouldAcknowledgeInbound('telegram:123', inbound('999'))).toBe(true);
  });

  it('group @mention → true regardless of sender; plain group chatter from an unknown → false', async () => {
    expect(await shouldAcknowledgeInbound('telegram:-100555', inbound('999', true))).toBe(true);
    expect(await shouldAcknowledgeInbound('telegram:-100555', inbound('999', false))).toBe(false);
  });

  it('no sender id → false', async () => {
    expect(await shouldAcknowledgeInbound('telegram:123', inbound(null))).toBe(false);
  });
});

describe('wrapTelegramForFork — 👀 on inbound', () => {
  async function drive(platformId: string, message: InboundMessage): Promise<ReturnType<typeof vi.fn>> {
    const adapter = stubAdapter(calls);
    const wrapped = wrapTelegramForFork(adapter, 'tok')!;
    const inner = vi.fn();
    await wrapped.setup({ onInbound: inner, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} });
    await adapter.lastSetup!.onInbound(platformId, null, message);
    // The reaction is fire-and-forget; let its DB lookups settle.
    await new Promise((r) => setTimeout(r, 30));
    return inner;
  }

  it('reacts for the owner and still forwards to the router', async () => {
    await upsertUser({ id: 'telegram:7', kind: 'telegram', display_name: null, created_at: now() });
    await grantRole({
      user_id: 'telegram:7',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    const inner = await drive('telegram:123', inbound('7'));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(calls.reactions).toEqual([{ platformId: 'telegram:123', messageId: 'm-1', emoji: '👀' }]);
  });

  it("does not react to an unknown sender's DM, but still forwards to the router", async () => {
    const inner = await drive('telegram:123', inbound('999'));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(calls.reactions).toEqual([]);
  });
});
