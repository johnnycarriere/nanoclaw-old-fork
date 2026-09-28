/**
 * Telegram voice-message transcription via Groq Whisper.
 *
 * Ported from v1's src/transcription.ts. v2's @chat-adapter/telegram already
 * downloads audio attachments as base64 in content.attachments, so we don't
 * need to hit Telegram's getFile API — we just take the bytes we already have
 * and POST them to Groq.
 *
 * When a Telegram message arrives with content.text === '' and an audio
 * attachment, we replace content.text with `[Voice message]: "<transcript>"`.
 * If GROQ_API_KEY is missing or the call fails we fall back to a placeholder
 * so the agent still knows something was said.
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_MODEL = 'whisper-large-v3-turbo';
/** Per-request cap so a stalled Groq call can't hold inbound routing hostage. */
export const TRANSCRIBE_TIMEOUT_MS = 30_000;
/** Largest audio payload we send for transcription (Telegram voice notes are far smaller). */
export const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

function groqKey(): string {
  return process.env.GROQ_API_KEY || readEnvFile(['GROQ_API_KEY']).GROQ_API_KEY || '';
}

async function transcribe(audioBuffer: Buffer, mimeType: string): Promise<string | null> {
  const apiKey = groqKey();
  if (!apiKey) {
    log.warn('Telegram voice: GROQ_API_KEY not set, cannot transcribe');
    return null;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: mimeType || 'audio/ogg' }), 'voice.ogg');
      form.append('model', GROQ_MODEL);
      form.append('language', 'en');

      const res = await fetch(GROQ_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as { text?: string };
      const text = data.text?.trim();
      if (text) {
        log.info('Telegram voice transcribed', { length: text.length, attempt });
        return text;
      }
      return null;
    } catch (err) {
      log.warn('Groq transcription attempt failed', { attempt, err });
      if (attempt === 0) continue;
    }
  }
  return null;
}

interface Attachment {
  type?: string;
  mimeType?: string;
  /** Set for `raw.audio` (music/audio files, from file_name); never set for `raw.voice` notes. */
  name?: string;
  data?: string;
}

/**
 * If the inbound message is a pure voice note (no text + audio attachment),
 * transcribe it in place and rewrite content.text. No-ops for everything else.
 * Music/audio files (the adapter maps both `raw.voice` and `raw.audio` to
 * type 'audio', but only the latter carries a file name) are left untouched.
 */
export async function maybeTranscribeVoice(content: Record<string, unknown>): Promise<void> {
  if (typeof content.text === 'string' && content.text.trim().length > 0) return;
  const attachments = content.attachments as Attachment[] | undefined;
  if (!attachments || attachments.length === 0) return;
  const audio = attachments.find((a) => a.type === 'audio' && a.data && !a.name);
  if (!audio || !audio.data) return;

  try {
    const buffer = Buffer.from(audio.data, 'base64');
    if (buffer.length > MAX_AUDIO_BYTES) {
      log.warn('Telegram voice: attachment over size cap, skipping transcription', { bytes: buffer.length });
      content.text = '[Voice message — too large to transcribe]';
      return;
    }
    const transcript = await transcribe(buffer, audio.mimeType ?? 'audio/ogg');
    if (transcript) {
      content.text = `[Voice message]: "${transcript}"`;
    } else {
      content.text = '[Voice message — transcription failed]';
    }
  } catch (err) {
    log.error('Voice transcription error', { err });
    content.text = '[Voice message — transcription failed]';
  }
}
