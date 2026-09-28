import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, AdapterPostableMessage, RawMessage } from 'chat';

import { createChatSdkBridge, splitForLimit } from './chat-sdk-bridge.js';

vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

function stubAdapter(partial: Partial<Adapter>): Adapter {
  return { name: 'stub', ...partial } as unknown as Adapter;
}

interface PostCall {
  threadId: string;
  message: AdapterPostableMessage;
}

function makePostCapture() {
  const calls: PostCall[] = [];
  const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
    calls.push({ threadId, message });
    return { id: 'msg-stub', threadId, raw: {} };
  };
  return { calls, postMessage };
}

describe('splitForLimit', () => {
  it('returns a single chunk when text fits', () => {
    expect(splitForLimit('short text', 100)).toEqual(['short text']);
  });

  it('splits on paragraph boundaries when available', () => {
    const text = 'para one line one\npara one line two\n\npara two line one\npara two line two';
    const chunks = splitForLimit(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
  });

  it('falls back to line boundaries when no paragraph fits', () => {
    const text = 'alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot';
    const chunks = splitForLimit(text, 15);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(15);
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'a'.repeat(100);
    const chunks = splitForLimit(text, 30);
    expect(chunks.length).toBe(Math.ceil(100 / 30));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(30);
    expect(chunks.join('')).toBe(text);
  });
});

describe('createChatSdkBridge', () => {
  // The bridge is now transport-only: forward inbound events, relay outbound
  // ops. All per-wiring engage / accumulate / drop / subscribe decisions live
  // in the router (src/router.ts routeInbound / evaluateEngage) and are
  // exercised by host-core.test.ts end-to-end. These tests only cover the
  // bridge's narrow, platform-adjacent surface.

  it('omits openDM when the underlying Chat SDK adapter has none', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeUndefined();
  });

  it('exposes openDM when the underlying adapter has one, and delegates directly', async () => {
    const openDMCalls: string[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        openDM: async (userId: string) => {
          openDMCalls.push(userId);
          return `thread::${userId}`;
        },
        channelIdFromThreadId: (threadId: string) => `stub:${threadId.replace(/^thread::/, '')}`,
      }),
      supportsThreads: false,
    });
    expect(bridge.openDM).toBeDefined();
    const platformId = await bridge.openDM!('user-42');
    // Delegation: adapter.openDM → adapter.channelIdFromThreadId, no chat.openDM in between.
    expect(openDMCalls).toEqual(['user-42']);
    expect(platformId).toBe('stub:user-42');
  });

  it('exposes subscribe (lets the router initiate thread subscription on mention-sticky engage)', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({}),
      supportsThreads: true,
    });
    expect(typeof bridge.subscribe).toBe('function');
  });
});

describe('createChatSdkBridge — instance identity', () => {
  it('default: name === channelType === adapter.name, instance undefined', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBeUndefined();
  });

  it('named instance: name follows the instance, channelType stays the platform', () => {
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ name: 'slack' }),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    expect(bridge.name).toBe('slack-tester');
    expect(bridge.channelType).toBe('slack');
    expect(bridge.instance).toBe('slack-tester');
  });

  it('rejects instance names that would break the webhook route or state delimiter', () => {
    for (const bad of ['a/b', 'a:b', 'a?b', 'a b']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });

  it('rejects empty and whitespace-only instance names (config bug — fail loud)', () => {
    // '' is falsy: a truthiness guard would skip it, dead-ending the
    // webhook route ('/webhook/' + '') and collapsing the state namespace
    // into the default instance's unprefixed keyspace — the exact
    // cross-bot dedupe/lock collisions the namespace exists to prevent.
    for (const bad of ['', ' ', '   ', '\t']) {
      expect(() =>
        createChatSdkBridge({ adapter: stubAdapter({ name: 'slack' }), instance: bad, supportsThreads: true }),
      ).toThrow(/URL-safe/);
    }
  });
});

describe('createChatSdkBridge.setup — webhook route and state namespace', () => {
  // Real setup() over a stub adapter: Chat.initialize() needs a working
  // StateAdapter (chat_sdk_* tables) and an adapter.initialize — nothing
  // platform-side. registerWebhookAdapter is mocked at module level so we
  // can assert the (chat, adapterName, routingPath) triple.
  // runtimeMode is assigned inside initialize(), as the Telegram adapter does
  // when mode 'auto' resolves: a guard that reads it earlier sees undefined.
  function setupStubAdapter(runtimeMode?: 'webhook' | 'polling'): Adapter {
    const adapter = stubAdapter({ name: 'slack' }) as Adapter & { runtimeMode?: string };
    adapter.initialize = async () => {
      adapter.runtimeMode = runtimeMode;
    };
    return adapter;
  }

  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    vi.mocked(registerWebhookAdapter).mockClear();
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  const hostConfig = {
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };

  it('named instance registers the webhook with adapterName as handler key and instance as route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath).toBe('slack-tester');
    await bridge.teardown();
  });

  it('default instance registers the historical route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    const [, adapterName, routingPath] = vi.mocked(registerWebhookAdapter).mock.calls[0];
    expect(adapterName).toBe('slack');
    expect(routingPath ?? adapterName).toBe('slack');
    await bridge.teardown();
  });

  // Polling adapters (Telegram) pull updates themselves; a registered route
  // would lazily bind the shared webhook port, and a busy port then crashes a
  // Telegram-only host. Kill condition: delete the `runtimeMode === 'polling'`
  // branch in setup() and the polling case goes red.
  it('polling adapter (mode resolved inside initialize) registers no webhook route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('polling'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).not.toHaveBeenCalled();
    await bridge.teardown();
  });

  it('webhook adapter registers the route', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter('webhook'), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('adapter without runtimeMode registers the route (non-Telegram adapters declare none)', async () => {
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const bridge = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await bridge.setup(hostConfig);
    expect(registerWebhookAdapter).toHaveBeenCalledTimes(1);
    await bridge.teardown();
  });

  it('named instance namespaces Chat SDK state; default stays unprefixed (live-install constraint)', async () => {
    const { getDb } = await import('../db/connection.js');

    const named = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack-tester',
      supportsThreads: true,
    });
    await named.setup(hostConfig);
    await named.subscribe!('slack:C1', 'slack:T1');

    const def = createChatSdkBridge({ adapter: setupStubAdapter(), supportsThreads: true });
    await def.setup(hostConfig);
    await def.subscribe!('slack:C1', 'slack:T1');

    const rows = await getDb().all<{ thread_id: string }>(
      'SELECT thread_id FROM chat_sdk_subscriptions ORDER BY thread_id',
    );
    expect(rows.map((r) => r.thread_id)).toEqual(['slack-tester:slack:T1', 'slack:T1']);

    await named.teardown();
    await def.teardown();
  });

  it('explicitly naming the primary instance after the platform stays on the unprefixed keyspace', async () => {
    const { getDb } = await import('../db/connection.js');
    const bridge = createChatSdkBridge({
      adapter: setupStubAdapter(),
      instance: 'slack', // explicit, but equal to adapter.name ⇒ default keyspace
      supportsThreads: true,
    });
    await bridge.setup(hostConfig);
    await bridge.subscribe!('slack:C1', 'slack:T9');
    const rows = await getDb().all<{ thread_id: string }>('SELECT thread_id FROM chat_sdk_subscriptions');
    expect(rows.map((r) => r.thread_id)).toEqual(['slack:T9']);
    await bridge.teardown();
  });
});

describe('createChatSdkBridge.deliver — ask_question cards (button styles)', () => {
  // Approval cards color their buttons (Slack: primary→green, danger→red).
  // The bridge must forward the normalized option style into Button() and
  // omit it when unset — an invalid style surviving to Block Kit would fail
  // the whole card with invalid_blocks (effective auto-deny).

  interface CapturedButton {
    type?: string;
    id?: string;
    label?: string;
    value?: string;
    style?: string;
  }

  function buttonsFrom(calls: PostCall[]): CapturedButton[] {
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: CapturedButton[] }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    return actionsRow?.children ?? [];
  }

  it('passes each option style through to the Button, and omits it when unset', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-1',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [
          { label: 'Approve', style: 'primary' },
          { label: 'Deny', style: 'danger' },
          'Skip', // string shorthand — never styled
        ],
      },
    });
    expect(calls).toHaveLength(1);
    const buttons = buttonsFrom(calls);
    expect(buttons.map((b) => b.label)).toEqual(['Approve', 'Deny', 'Skip']);
    expect(buttons.map((b) => b.style)).toEqual(['primary', 'danger', undefined]);
  });

  it('drops invalid styles before they reach the Button (delivery goes through normalizeOptions)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-2',
        title: 'Approval needed',
        question: 'Allow the tool call?',
        options: [{ label: 'Approve', style: 'chartreuse' }],
      },
    });
    const buttons = buttonsFrom(calls);
    expect(buttons).toHaveLength(1);
    expect(buttons[0].style).toBeUndefined();
  });

  it('retains the approval body and replaces buttons with a muted timeout resolution', async () => {
    const edits: PostCall[] = [];
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({
        editMessage: async (threadId, _messageId, message) => {
          edits.push({ threadId, message });
          return { id: 'msg-1', threadId, raw: {} };
        },
      }),
      supportsThreads: false,
    });

    await bridge.deliver('slack:C1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'msg-1',
        text: 'Credentials Request\n\n*Agent:* Andy\n*Action:* Send email\n\n⏱️ Timed out — no response',
        terminalCard: {
          title: 'Credentials Request',
          question: '*Agent:* Andy\n*Action:* Send email',
          resolution: '⏱️ Timed out — no response',
        },
      },
    });

    expect(edits).toHaveLength(1);
    const edited = edits[0].message as {
      card: { title: string; children: Array<{ type: string; content?: string; style?: string }> };
    };
    expect(edited.card.title).toBe('Credentials Request');
    expect(edited.card.children).toEqual([
      { type: 'text', content: '*Agent:* Andy\n*Action:* Send email' },
      { type: 'text', content: '⏱️ Timed out — no response', style: 'muted' },
    ]);
    expect(edited.card.children.some((child) => child.type === 'actions')).toBe(false);
  });
});

describe('createChatSdkBridge.deliver — display cards (send_card)', () => {
  // The send_card MCP tool writes outbound rows with `{ type: 'card', card, fallbackText }`.
  // Before this branch existed the bridge silently dropped them: cards have no
  // `text` / `markdown`, so the trailing fallback `if (text)` was false and the
  // function returned without calling the adapter. These tests pin the contract
  // for the dedicated card branch.

  it('renders title, description, and string children, then posts via the adapter', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Daily',
          description: 'Your plate today',
          children: ['• item one', '• item two'],
        },
        fallbackText: 'Daily: your plate',
      },
    });
    expect(id).toBe('msg-stub');
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { card?: unknown; fallbackText?: string };
    expect(msg.fallbackText).toBe('Daily: your plate');
    expect(msg.card).toBeDefined();
  });

  it('renders non-URL actions as callback buttons (ncs re-injection round-trip)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Card',
          description: 'has only label-only actions',
          actions: [{ label: 'Add' }, { label: 'Skip' }],
        },
      },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons.every((b) => b.type === 'button')).toBe(true);
  });

  it('renders url actions as link buttons and non-URL actions as callback buttons', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('discord:guild:chan', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: {
          title: 'Docs',
          actions: [{ label: 'Open', url: 'https://example.com' }, { label: 'No-link' }],
        },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ type?: string; url?: string }> }> };
    };
    const actionsRow = msg.card?.children?.find((c) => c.type === 'actions');
    expect(actionsRow).toBeDefined();
    const buttons = actionsRow?.children ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].type).toBe('link-button');
    expect(buttons[0].url).toBe('https://example.com');
    expect(buttons[1].type).toBe('button');
  });

  it('skips delivery when the card has neither title nor body content', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    const id = await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { type: 'card', card: {} },
    });
    expect(id).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('falls through to the text branch for non-card chat-sdk payloads (no regression)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({
      adapter: stubAdapter({ postMessage }),
      supportsThreads: false,
    });
    await bridge.deliver('telegram:42', null, {
      kind: 'chat-sdk',
      content: { text: 'plain hello' },
    });
    expect(calls).toHaveLength(1);
    const msg = calls[0].message as { markdown?: string };
    expect(msg.markdown).toBe('plain hello');
  });
});

describe('createChatSdkBridge — send_card callback buttons (index registry, click re-injection)', () => {
  // Telegram caps callback_data at 64 bytes and the adapter throws
  // ValidationError for the whole card when a value overflows it. Buttons
  // therefore carry `ncs:<cardId>` + an index, resolved on click exactly like
  // ask_question's ncq buttons. The click test drives the bridge's real
  // onAction handler through the real Chat SDK dispatch (chat.processAction),
  // capturing the Chat instance from the (mocked) webhook registration.
  beforeEach(async () => {
    const { initTestDb } = await import('../db/connection.js');
    const { runMigrations } = await import('../db/migrations/index.js');
    await runMigrations(await initTestDb());
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    vi.mocked(registerWebhookAdapter).mockClear();
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/connection.js');
    await closeDb();
  });

  it('encodes long action values as a short card id + index (fits the 64-byte callback cap)', async () => {
    const { calls, postMessage } = makePostCapture();
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ postMessage }), supportsThreads: false });
    const longValue = `+perspective ${'x'.repeat(200)}`;
    await bridge.deliver('telegram:123', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: { title: 'Card', actions: [{ label: 'Add', value: longValue }, { label: 'Skip' }] },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ id?: string; value?: string }> }> };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].id).toMatch(/^ncs:[0-9a-f]{8}$/);
    expect(buttons[0].id).toBe(buttons[1].id);
    expect(buttons.map((b) => b.value)).toEqual(['0', '1']);
    const payload = `chat:${JSON.stringify({ a: buttons[0].id, v: buttons[0].value })}`;
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThanOrEqual(64);
  });

  it('a click resolves the index back to the value and re-injects it as a mention with a stable id; double-clicks dedupe', async () => {
    const { calls, postMessage } = makePostCapture();
    const adapter = stubAdapter({
      name: 'telegram',
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => threadId,
      postMessage,
    });
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    const inbound = vi.fn();
    await bridge.setup({ onInbound: inbound, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} });
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const chat = vi.mocked(registerWebhookAdapter).mock.calls[0][0] as import('chat').Chat;

    const longValue = `+perspective ${'y'.repeat(200)}`;
    await bridge.deliver('telegram:-100555', null, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        card: { title: 'Card', actions: [{ label: 'Skip' }, { label: 'Add', value: longValue }] },
      },
    });
    const msg = calls[0].message as {
      card?: { children?: Array<{ type?: string; children?: Array<{ id?: string; value?: string }> }> };
    };
    const buttons = msg.card?.children?.find((c) => c.type === 'actions')?.children ?? [];
    const click = {
      actionId: buttons[1].id!,
      adapter,
      messageId: 'card-msg-9',
      raw: { message: { chat: { type: 'supergroup' } } },
      threadId: 'telegram:-100555',
      user: { userId: '7' } as never,
      value: buttons[1].value,
    };
    await chat.processAction(click, undefined);
    await chat.processAction(click, undefined);

    expect(inbound).toHaveBeenCalledTimes(1);
    const [channelId, threadId, message] = inbound.mock.calls[0];
    expect(channelId).toBe('telegram:-100555');
    expect(threadId).toBe('telegram:-100555');
    expect(message.content).toEqual({ text: longValue, author: { userId: '7' } });
    expect(message.isMention).toBe(true);
    expect(message.isGroup).toBe(true);
    expect(message.id).toMatch(/^card-msg-9:[0-9a-f]{12}$/);
    await bridge.teardown();
  });

  it('legacy bare `ncs` clicks (cards sent before the registry) still re-inject the literal value', async () => {
    const adapter = stubAdapter({
      name: 'slack',
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => threadId,
    });
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    const inbound = vi.fn();
    await bridge.setup({ onInbound: inbound, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} });
    const { registerWebhookAdapter } = await import('../webhook-server.js');
    const chat = vi.mocked(registerWebhookAdapter).mock.calls[0][0] as import('chat').Chat;
    await chat.processAction(
      {
        actionId: 'ncs',
        adapter,
        messageId: 'old-1',
        raw: {},
        threadId: 'D1',
        user: { userId: '7' } as never,
        value: 'Add',
      },
      undefined,
    );
    expect(inbound).toHaveBeenCalledTimes(1);
    expect(inbound.mock.calls[0][2].content).toEqual({ text: 'Add', author: { userId: '7' } });
    expect(inbound.mock.calls[0][2].isGroup).toBeUndefined();
    await bridge.teardown();
  });

  it('teardown stops a polling adapter before shutting the Chat instance down', async () => {
    const order: string[] = [];
    const adapter = stubAdapter({
      name: 'telegram',
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => threadId,
    }) as Adapter & { stopPolling?: () => Promise<void>; runtimeMode?: string };
    adapter.runtimeMode = 'polling';
    adapter.stopPolling = async () => {
      order.push('stopPolling');
    };
    const bridge = createChatSdkBridge({ adapter, supportsThreads: false });
    await bridge.setup({ onInbound: () => {}, onInboundEvent: () => {}, onMetadata: () => {}, onAction: () => {} });
    await bridge.teardown();
    expect(order).toEqual(['stopPolling']);
  });
});

describe('createChatSdkBridge.deliver — markdown parse-error fallback', () => {
  function parseError(): Error {
    const err = new Error("Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 12");
    err.name = 'ValidationError';
    return err;
  }

  it("retries a chunk as raw text when the platform rejects it with can't parse entities", async () => {
    const posted: AdapterPostableMessage[] = [];
    let first = true;
    const postMessage = async (threadId: string, message: AdapterPostableMessage): Promise<RawMessage<unknown>> => {
      posted.push(message);
      if (first) {
        first = false;
        throw parseError();
      }
      return { id: 'plain-1', threadId, raw: {} };
    };
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ postMessage }), supportsThreads: false });
    const id = await bridge.deliver('telegram:123', null, { kind: 'chat-sdk', content: { markdown: 'a_b *c' } });
    expect(id).toBe('plain-1');
    expect(posted).toEqual([{ markdown: 'a_b *c' }, { raw: 'a_b *c' }]);
  });

  it('other errors still propagate (delivery retry path), and a second parse failure is not retried again', async () => {
    const postMessage = async (): Promise<RawMessage<unknown>> => {
      throw new Error('network down');
    };
    const bridge = createChatSdkBridge({ adapter: stubAdapter({ postMessage }), supportsThreads: false });
    await expect(bridge.deliver('telegram:123', null, { kind: 'chat-sdk', content: { text: 'x' } })).rejects.toThrow(
      /network down/,
    );

    let calls = 0;
    const alwaysParseError = async (): Promise<RawMessage<unknown>> => {
      calls++;
      throw parseError();
    };
    const bridge2 = createChatSdkBridge({
      adapter: stubAdapter({ postMessage: alwaysParseError }),
      supportsThreads: false,
    });
    await expect(bridge2.deliver('telegram:123', null, { kind: 'chat-sdk', content: { text: 'x' } })).rejects.toThrow(
      /parse entities/,
    );
    expect(calls).toBe(2);
  });
});
