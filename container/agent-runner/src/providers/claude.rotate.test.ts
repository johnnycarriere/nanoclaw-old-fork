import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ClaudeProvider, toSdkContent, transcriptImageBytes } from './claude.js';

// maybeRotateContinuation guards the cold-resume failure mode: a long-lived
// session whose on-disk transcript has grown so large (or old) that the SDK
// can't reload it before the host's idle ceiling kills the container.

let tmp: string;
let prevHome: string | undefined;
let prevConv: string | undefined;
let prevBytes: string | undefined;
let prevImageBytes: string | undefined;
let prevDays: string | undefined;

const PROJECT_DIR = '-workspace-agent';
const CWD = '/workspace/agent';

function writeTranscript(sessionId: string, bytes: number, firstTs?: string, imageBase64Bytes = 0): string {
  const dir = path.join(tmp, '.claude', 'projects', PROJECT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  const first =
    JSON.stringify({
      type: 'user',
      timestamp: firstTs ?? new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    }) + '\n';
  // An inlined image turn, as the SDK persists it: base64 payload in a
  // `data` field. `bytes` is the text budget; the image line rides on top.
  const image =
    imageBase64Bytes > 0
      ? JSON.stringify({
          type: 'user',
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [
              { type: 'text', text: '[image 1: pic.png]' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(imageBase64Bytes) } },
            ],
          },
        }) + '\n'
      : '';
  const filler = 'x'.repeat(Math.max(0, bytes - first.length));
  fs.writeFileSync(p, first + image + filler);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rotate-'));
  prevHome = process.env.HOME;
  prevConv = process.env.NANOCLAW_CONVERSATIONS_DIR;
  prevBytes = process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES;
  prevImageBytes = process.env.CLAUDE_TRANSCRIPT_ROTATE_IMAGE_BYTES;
  prevDays = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  process.env.HOME = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(tmp, 'conversations');
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('HOME', prevHome);
  restore('NANOCLAW_CONVERSATIONS_DIR', prevConv);
  restore('CLAUDE_TRANSCRIPT_ROTATE_BYTES', prevBytes);
  restore('CLAUDE_TRANSCRIPT_ROTATE_IMAGE_BYTES', prevImageBytes);
  restore('CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS', prevDays);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeProvider.maybeRotateContinuation', () => {
  it('keeps a small, recent transcript (returns null, leaves file in place)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    const p = writeTranscript('sess-small', 4096);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-small', CWD)).toBeNull();
    expect(fs.existsSync(p)).toBe(true);
  });

  it('rotates an oversized transcript (returns reason, moves the .jsonl aside)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
    const p = writeTranscript('sess-big', 200 * 1024);
    const provider = new ClaudeProvider();
    const reason = provider.maybeRotateContinuation('sess-big', CWD);
    expect(reason).toContain('MB');
    expect(fs.existsSync(p)).toBe(false); // original moved out of the resume path
    const dir = path.dirname(p);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('sess-big.jsonl.rotated-'))).toBe(true);
  });

  it('rotates an aged transcript even when small', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS = '7';
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    writeTranscript('sess-old', 2048, old);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-old', CWD)).toContain('d');
  });

  it('does not count inlined image payload against the text cap', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
    // 32KB of text + 200KB of base64 image → raw size is over the cap, text is not.
    const p = writeTranscript('sess-img', 32 * 1024, undefined, 200 * 1024);
    expect(transcriptImageBytes(p)).toBe(200 * 1024);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-img', CWD)).toBeNull();
    expect(fs.existsSync(p)).toBe(true);
  });

  it('rotates when images push the transcript past the image-inclusive ceiling', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
    process.env.CLAUDE_TRANSCRIPT_ROTATE_IMAGE_BYTES = String(128 * 1024);
    const p = writeTranscript('sess-img-big', 32 * 1024, undefined, 200 * 1024);
    const provider = new ClaudeProvider();
    const reason = provider.maybeRotateContinuation('sess-img-big', CWD);
    expect(reason).toContain('incl. images');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('returns null for an unknown session id', () => {
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('does-not-exist', CWD)).toBeNull();
  });
});

describe('toSdkContent', () => {
  it('passes a plain string through when there are no images', () => {
    expect(toSdkContent('hello')).toBe('hello');
    expect(toSdkContent('hello', [])).toBe('hello');
  });

  it('builds text-first content blocks from out-of-band images', () => {
    const content = toSdkContent('see [image 1: a.png]', [{ mediaType: 'image/png', data: 'AA==', bytes: 1 }]);
    expect(content).toEqual([
      { type: 'text', text: 'see [image 1: a.png]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
    ]);
  });
});
