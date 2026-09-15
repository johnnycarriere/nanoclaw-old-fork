import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChannelAdapter, OutboundMessage } from './adapter.js';
vi.mock('./telegram.js', () => ({ createTelegramBridge: vi.fn() }));
vi.mock('./channel-registry.js', () => ({ getChannelDefaults: vi.fn(), registerChannelAdapter: vi.fn() }));
import { wrapTelegramForFork } from './telegram-fork.js';

afterEach(() => vi.unstubAllGlobals());
const card: OutboundMessage = {
  kind: 'chat',
  content: {
    type: 'card',
    card: {
      title: 'Choose',
      actions: [{ label: 'Open', webAppUrl: 'https://example.com' }],
    },
  },
};
function wrapped() {
  const deliver = vi.fn().mockResolvedValue('normal');
  return { deliver, adapter: wrapTelegramForFork({ deliver } as unknown as ChannelAdapter, 'test-token')! };
}
describe('Telegram Mini App delivery', () => {
  it.each([
    { status: 429, ok: false, body: { ok: false } },
    { status: 200, ok: true, body: { ok: false } },
    { status: 200, ok: true, body: { ok: true } },
  ])('rejects unsuccessful or incomplete responses: $status / $body', async ({ status, ok, body }) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status, ok, json: async () => body }));
    await expect(wrapped().adapter.deliver('telegram:123', null, card)).rejects.toThrow(
      'Telegram web_app button send failed',
    );
  });
  it('propagates network failures so host delivery can retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection reset')));
    await expect(wrapped().adapter.deliver('telegram:123', null, card)).rejects.toThrow('connection reset');
  });
  it('returns the confirmed message id', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue({ status: 200, ok: true, json: async () => ({ ok: true, result: { message_id: 42 } }) }),
    );
    expect(await wrapped().adapter.deliver('telegram:123', null, card)).toBe('42');
  });
  it('preserves normal adapter delivery', async () => {
    const { adapter, deliver } = wrapped();
    const message = { kind: 'chat', content: { text: 'hello' } };
    expect(await adapter.deliver('telegram:123', null, message)).toBe('normal');
    expect(deliver).toHaveBeenCalledWith('telegram:123', null, message);
  });
});
