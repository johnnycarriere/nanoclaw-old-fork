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
 *   2. 👀 reaction on inbound the router will act on — a known sender (role
 *      holder, member of a wired agent group, or any sender on a public
 *      chat) or a group @mention — so the user knows the bot received the
 *      message before a container even spawns. Unknown senders' DMs get no
 *      acknowledgement. Pairs with the host-side 👨‍💻 / 👍 lifecycle
 *      reactions in src/status-reactions.ts.
 *   3. `send_card` actions carrying a `webAppUrl` render as a Telegram
 *      reply-keyboard Mini App button (the Chat SDK has no web_app button
 *      type, and `Telegram.WebApp.sendData()` only round-trips from a
 *      reply-keyboard button in a private chat). Bible picker depends on it.
 *      In group chats — where the Bot API rejects web_app reply keyboards —
 *      the action degrades to an ordinary URL link button.
 *   4. Outbound text is split at TELEGRAM_FORK_MAX_TEXT (below upstream's
 *      4000) so MarkdownV2 escaping growth can't push a chunk past the
 *      4096-char Bot API limit.
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
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../db/messaging-groups.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import { getUserRoles } from '../modules/permissions/db/user-roles.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { getChannelDefaults, registerChannelAdapter } from './channel-registry.js';
import { splitForLimit } from './chat-sdk-bridge.js';
import { createTelegramBridge } from './telegram.js';
import { maybeTranscribeVoice } from './telegram-voice-transcribe.js';

/** Registry key of the instance this module wraps. */
const INSTANCE_KEY = 'telegram';

/**
 * Split threshold for outbound text. Upstream's bridge splits at 4000 raw
 * characters, but the adapter's MarkdownV2 renderer escapes on top of that,
 * so a 4000-char chunk can exceed Telegram's 4096 limit after escaping.
 */
export const TELEGRAM_FORK_MAX_TEXT = 3000;

/** platformId is "telegram:<chatId>". Negative chat IDs are groups/channels. */
function isGroupPlatformId(platformId: string): boolean {
  const id = platformId.split(':').pop() ?? '';
  return id.startsWith('-');
}

/**
 * Send a Telegram reply-keyboard Mini App button via the Bot API. Returns the
 * platform message id, if any. Throws on a non-OK response or network error
 * so delivery.ts retries and eventually marks the row failed, instead of
 * acknowledging a send that never happened.
 */
async function sendWebAppButton(
  token: string,
  platformId: string,
  text: string,
  label: string,
  url: string,
): Promise<string | undefined> {
  const chatId = platformId.split(':').slice(1).join(':');
  if (!chatId) throw new Error(`Telegram web_app button: no chat id in platformId ${platformId}`);
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
  const json = (await res.json()) as { ok: boolean; description?: string; result?: { message_id?: number } };
  if (!json.ok) {
    throw new Error(`Telegram web_app button send failed (${res.status}): ${json.description ?? 'non-OK'}`);
  }
  return json.result?.message_id != null ? String(json.result.message_id) : undefined;
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

/** Same card with every `webAppUrl` action rewritten as a plain `url` link button. */
function withLinkButtons(message: OutboundMessage): OutboundMessage {
  const content = message.content as Record<string, unknown>;
  const card = content.card as Record<string, unknown>;
  const actions = (card.actions as Array<Record<string, unknown>>).map((a) => {
    if (typeof a.webAppUrl !== 'string' || !a.webAppUrl) return a;
    const { webAppUrl, ...rest } = a;
    return { ...rest, url: webAppUrl };
  });
  return { ...message, content: { ...content, card: { ...card, actions } } };
}

/**
 * Chunks for a plain text/markdown outbound message longer than `limit`,
 * or null when the message is not splittable text (cards, edits, reactions,
 * files-only) or already fits.
 */
function splitOutbound(message: OutboundMessage, limit: number): { key: 'markdown' | 'text'; chunks: string[] } | null {
  const content = message.content as Record<string, unknown> | undefined;
  if (!content || typeof content !== 'object') return null;
  if (content.operation || content.type) return null;
  const key = typeof content.markdown === 'string' && content.markdown ? 'markdown' : 'text';
  const text = content[key];
  if (typeof text !== 'string' || text.length <= limit) return null;
  return { key, chunks: splitForLimit(text, limit) };
}

function readSenderId(message: InboundMessage): string | null {
  if (message.kind !== 'chat-sdk' || !message.content || typeof message.content !== 'object') return null;
  const content = message.content as Record<string, unknown>;
  const author = content.author as Record<string, unknown> | undefined;
  if (author && typeof author.userId === 'string' && author.userId) return author.userId;
  if (typeof content.senderId === 'string' && content.senderId) return content.senderId;
  return null;
}

/**
 * Whether the router will act on this inbound, i.e. whether the sender should
 * see an acknowledgement. Mirrors the router's admission decision without
 * routing: group @mentions always (registration / mention engage), otherwise
 * a sender who holds a role, is a member of an agent group wired to this
 * chat, or writes to a chat whose unknown-sender policy is `public`.
 * Exported for tests.
 */
export async function shouldAcknowledgeInbound(platformId: string, message: InboundMessage): Promise<boolean> {
  if (isGroupPlatformId(platformId) && message.isMention === true) return true;
  const senderId = readSenderId(message);
  if (!senderId) return false;
  const userId = senderId.includes(':') ? senderId : `telegram:${senderId}`;
  if ((await getUserRoles(userId)).length > 0) return true;
  const mg = await getMessagingGroupByPlatform('telegram', platformId, INSTANCE_KEY);
  if (!mg) return false;
  if (mg.unknown_sender_policy === 'public') return true;
  for (const mga of await getMessagingGroupAgents(mg.id)) {
    if (await isMember(userId, mga.agent_group_id)) return true;
  }
  return false;
}

/** Wrap upstream's adapter with the fork behaviors. Exported for tests. */
export function wrapTelegramForFork(adapter: ChannelAdapter | null, token: string): ChannelAdapter | null {
  if (!adapter) return null;
  const wrapped: ChannelAdapter = {
    ...adapter,
    async deliver(platformId: string, threadId: string | null, message: OutboundMessage) {
      const webApp = webAppCard(message);
      if (webApp) {
        // The Bot API rejects web_app reply keyboards outside private chats.
        if (isGroupPlatformId(platformId)) return adapter.deliver(platformId, threadId, withLinkButtons(message));
        return sendWebAppButton(token, platformId, webApp.text, webApp.label, webApp.url);
      }
      const split = splitOutbound(message, TELEGRAM_FORK_MAX_TEXT);
      if (!split) return adapter.deliver(platformId, threadId, message);
      // Files ride on the first chunk, as in the bridge's own splitter.
      let firstId: string | undefined;
      for (let i = 0; i < split.chunks.length; i++) {
        const content = { ...(message.content as Record<string, unknown>), [split.key]: split.chunks[i] };
        const id = await adapter.deliver(platformId, threadId, {
          ...message,
          content,
          files: i === 0 ? message.files : undefined,
        });
        if (i === 0) firstId = id;
      }
      return firstId;
    },
    async setup(hostConfig: ChannelSetup) {
      const inner = hostConfig.onInbound;
      const react = adapter.postReaction?.bind(adapter);
      const onInbound: ChannelSetup['onInbound'] = async (platformId, threadId, message) => {
        try {
          if (message.kind === 'chat-sdk' && message.content && typeof message.content === 'object') {
            await maybeTranscribeVoice(message.content as Record<string, unknown>);
          }
        } catch (err) {
          log.warn('Telegram voice transcribe wrapper error', { err });
        }
        if (message.id && react) {
          // Non-blocking: the acknowledgement must never delay routing.
          const messageId = message.id;
          void shouldAcknowledgeInbound(platformId, message)
            .then((ok) => (ok ? react(platformId, messageId, '👀') : undefined))
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

registerChannelAdapter(INSTANCE_KEY, {
  factory: () => {
    const token = readEnvFile(['TELEGRAM_BOT_TOKEN']).TELEGRAM_BOT_TOKEN;
    if (!token) return null;
    return wrapTelegramForFork(createTelegramBridge(), token);
  },
  // Upstream's declaration, registered by the ./telegram.js import above.
  defaults: getChannelDefaults(INSTANCE_KEY),
});
