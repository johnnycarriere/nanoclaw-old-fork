/**
 * FORK: this install's Telegram customizations, layered OVER the skill-managed
 * adapter in ./telegram.ts without editing it.
 *
 * Why a separate file: `/update-skills` (and the update controller's
 * validation refresh) re-copies src/channels/telegram.ts from the `channels`
 * branch on every refresh, so edits made there are silently lost at the next
 * update. This module re-registers the default 'telegram' instance with a
 * wrapper around upstream's `createTelegramBridge()` — the registry is a
 * Map.set, so the later registration wins — and keeps every fork behavior
 * here:
 *
 *   1. Voice notes are transcribed in place before routing
 *      (telegram-voice-transcribe.ts), so the agent sees text.
 *   2. 👀 reaction on every inbound so the user knows the bot received the
 *      message before a container even spawns. Pairs with the host-side
 *      👨‍💻 / 👍 lifecycle reactions in src/status-reactions.ts.
 *   3. `send_card` actions carrying a `webAppUrl` render as a Telegram
 *      reply-keyboard Mini App button (the Chat SDK has no web_app button
 *      type, and `Telegram.WebApp.sendData()` only round-trips from a
 *      reply-keyboard button in a private chat). Bible picker depends on it.
 *
 * Declared wiring defaults are upstream's own (read back from the registry):
 * the strict unknown-sender behavior this install wants comes from the
 * router-level hardcode in src/router.ts, not from the declaration —
 * overriding the declaration here would break upstream's named-instance
 * test, which expects every telegram registration to share one declaration.
 *
 * Named instances (TELEGRAM_INSTANCES) keep upstream's plain registration.
 * The barrel import line for this module carries a trailing comment on
 * purpose: skill detection only recognizes bare `import './x.js';` lines, so
 * the refresh never looks for a nonexistent `add-telegram-fork` skill.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { getChannelDefaults, registerChannelAdapter } from './channel-registry.js';
import { createTelegramBridge } from './telegram.js';
import { maybeTranscribeVoice } from './telegram-voice-transcribe.js';

/**
 * Send a Telegram reply-keyboard Mini App button via the Bot API. Returns the
 * platform message id, if any.
 */
async function sendWebAppButton(
  token: string,
  platformId: string,
  text: string,
  label: string,
  url: string,
): Promise<string | undefined> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) throw new Error('Telegram web_app button requires a chat id');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: {
        keyboard: [[{ text: label, web_app: { url } }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }),
  });
  const json = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
  if (!res.ok || !json.ok || json.result?.message_id == null) {
    // Throw so the host retains the outbound row and retries delivery.
    // Do not include the URL (it contains the bot token) in the error.
    throw new Error(`Telegram web_app button send failed (HTTP ${res.status})`);
  }
  return String(json.result.message_id);
}

/** A `send_card` payload whose actions carry a `webAppUrl`, or null. */
function webAppCard(message: OutboundMessage): { text: string; label: string; url: string } | null {
  const content = message.content as Record<string, unknown> | undefined;
  if (!content || content.type !== 'card' || !content.card || typeof content.card !== 'object') return null;
  const card = content.card as Record<string, unknown>;
  const actions = Array.isArray(card.actions) ? (card.actions as Array<Record<string, unknown>>) : [];
  const webApp = actions.find((a) => typeof a.webAppUrl === 'string' && a.webAppUrl);
  if (!webApp) return null;
  const label = typeof webApp.label === 'string' && webApp.label ? webApp.label : 'Open';
  const text =
    (typeof card.title === 'string' && card.title) ||
    (typeof card.description === 'string' && card.description) ||
    (typeof content.fallbackText === 'string' && content.fallbackText) ||
    'Open:';
  return { text, label, url: webApp.webAppUrl as string };
}

/** Wrap upstream's adapter with the fork behaviors. Exported for tests. */
export function wrapTelegramForFork(adapter: ChannelAdapter | null, token: string): ChannelAdapter | null {
  if (!adapter) return null;
  const wrapped: ChannelAdapter = {
    ...adapter,
    async deliver(platformId: string, threadId: string | null, message: OutboundMessage) {
      const webApp = webAppCard(message);
      if (webApp) return sendWebAppButton(token, platformId, webApp.text, webApp.label, webApp.url);
      return adapter.deliver(platformId, threadId, message);
    },
    async setup(hostConfig: ChannelSetup) {
      const inner = hostConfig.onInbound;
      const onInbound: ChannelSetup['onInbound'] = async (platformId, threadId, message) => {
        try {
          if (message.kind === 'chat-sdk' && message.content && typeof message.content === 'object') {
            await maybeTranscribeVoice(message.content as Record<string, unknown>);
          }
        } catch (err) {
          log.warn('Telegram voice transcribe wrapper error', { err });
        }
        if (message.id && adapter.postReaction) {
          adapter
            .postReaction(platformId, message.id, '👀')
            .catch((err) => log.debug('addReaction eyes failed', { err }));
        }
        await inner(platformId, threadId, message);
      };
      // Upstream's setup wraps whatever onInbound it receives with its own
      // pairing/connect-group interceptor, so the order is: upstream's
      // interceptor (consumes pairing codes / /connect_group) → ours (voice
      // transcription + 👀) → the host router.
      return adapter.setup({ ...hostConfig, onInbound });
    },
  };
  return wrapped;
}

registerChannelAdapter('telegram', {
  factory: () => {
    const token = readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN;
    if (!token) return null;
    return wrapTelegramForFork(createTelegramBridge(), token);
  },
  // Upstream's declaration, registered by the ./telegram.js import above.
  defaults: getChannelDefaults('telegram'),
});
