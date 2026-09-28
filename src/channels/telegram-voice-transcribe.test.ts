/**
 * Voice transcription over a stubbed fetch: success rewrites the text, a
 * failing API falls back to the placeholder, oversize payloads never reach
 * the network, and named audio files (music) are left alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { MAX_AUDIO_BYTES, TRANSCRIBE_TIMEOUT_MS, maybeTranscribeVoice } from './telegram-voice-transcribe.js';

const fetchMock = vi.fn();

function voiceContent(bytes = 16, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: '',
    attachments: [{ type: 'audio', mimeType: 'audio/ogg', data: Buffer.alloc(bytes, 1).toString('base64'), ...extra }],
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('GROQ_API_KEY', 'gsk-test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('maybeTranscribeVoice', () => {
  it('success: rewrites content.text with the transcript and sends a 30s abort signal', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ text: ' hello there ' }), { status: 200 }));
    const content = voiceContent();
    await maybeTranscribeVoice(content);
    expect(content.text).toBe('[Voice message]: "hello there"');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(TRANSCRIBE_TIMEOUT_MS).toBe(30_000);
  });

  it('failure: retries once, then falls back to the placeholder', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
    const content = voiceContent();
    await maybeTranscribeVoice(content);
    expect(content.text).toBe('[Voice message — transcription failed]');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('oversize: skips the network entirely and marks the message', async () => {
    const content = voiceContent(MAX_AUDIO_BYTES + 1);
    await maybeTranscribeVoice(content);
    expect(content.text).toBe('[Voice message — too large to transcribe]');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('music: a named audio file is not a voice note and is left untouched', async () => {
    const content = voiceContent(16, { name: 'track.mp3', mimeType: 'audio/mpeg' });
    await maybeTranscribeVoice(content);
    expect(content.text).toBe('');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('no-op when the message already has text', async () => {
    const content = { ...voiceContent(), text: 'typed' };
    await maybeTranscribeVoice(content);
    expect(content.text).toBe('typed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
