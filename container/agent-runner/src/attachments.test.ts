import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  MAX_IMAGES_PER_PROMPT,
  MAX_IMAGE_BYTES_PER_PROMPT,
  MAX_RAW_IMAGE_BYTES,
  fitsImageBudget,
  loadImageAttachment,
  type ImageContent,
} from './attachments.js';

// 1x1 PNG (transparent) — minimal valid file
const PNG_1X1 = Buffer.from(
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D' +
    '49444154789C6300010000000500010D0A2DB40000000049454E44AE426082',
  'hex',
);

// JPEG SOI + APP0 + EOI (smallest "valid" JPEG header — enough for sniff)
const JPEG_HEADER = Buffer.from('FFD8FFE000104A464946000101', 'hex');

let tmpRoot: string;
const originalRoot = process.env.WORKSPACE_ROOT;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'inbox'), { recursive: true });
  process.env.WORKSPACE_ROOT = tmpRoot;
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (originalRoot === undefined) delete process.env.WORKSPACE_ROOT;
  else process.env.WORKSPACE_ROOT = originalRoot;
});

describe('loadImageAttachment', () => {
  it('loads a PNG and returns base64 + correct media type', () => {
    fs.writeFileSync(path.join(tmpRoot, 'inbox', 'pic.png'), PNG_1X1);
    const result = loadImageAttachment('inbox/pic.png');
    expect(result).not.toBeNull();
    expect(result!.mediaType).toBe('image/png');
    expect(result!.data).toBe(PNG_1X1.toString('base64'));
    expect(result!.bytes).toBe(PNG_1X1.length);
  });

  it('detects JPEG by magic bytes regardless of extension', () => {
    fs.writeFileSync(path.join(tmpRoot, 'inbox', 'attachment-no-ext'), Buffer.concat([JPEG_HEADER, Buffer.alloc(20)]));
    const result = loadImageAttachment('inbox/attachment-no-ext');
    expect(result?.mediaType).toBe('image/jpeg');
  });

  it('returns null for a missing file', () => {
    expect(loadImageAttachment('inbox/does-not-exist')).toBeNull();
  });

  it('returns null for an unrecognized format', () => {
    fs.writeFileSync(path.join(tmpRoot, 'inbox', 'doc.pdf'), Buffer.from('%PDF-1.7\n...padding...'));
    expect(loadImageAttachment('inbox/doc.pdf')).toBeNull();
  });

  it('returns null when the file exceeds the size cap', () => {
    // Synthesize a "PNG" just past the per-image raw cap (3.5MB)
    const oversized = Buffer.concat([PNG_1X1, Buffer.alloc(MAX_RAW_IMAGE_BYTES)]);
    fs.writeFileSync(path.join(tmpRoot, 'inbox', 'big.png'), oversized);
    expect(loadImageAttachment('inbox/big.png')).toBeNull();
  });

  it('rejects path traversal escaping the workspace root', () => {
    fs.writeFileSync(path.join(os.tmpdir(), 'outside.png'), PNG_1X1);
    try {
      expect(loadImageAttachment('../outside.png')).toBeNull();
    } finally {
      fs.unlinkSync(path.join(os.tmpdir(), 'outside.png'));
    }
  });
});

describe('fitsImageBudget', () => {
  const img = (bytes: number): ImageContent => ({ mediaType: 'image/png', data: 'AA==', bytes });

  it('accepts the first image and rejects past the count cap', () => {
    expect(fitsImageBudget([], 100)).toBe(true);
    const full = Array.from({ length: MAX_IMAGES_PER_PROMPT }, () => img(1));
    expect(fitsImageBudget(full, 1)).toBe(false);
  });

  it('rejects an image that would push raw bytes over the per-prompt cap', () => {
    const nearlyFull = [img(MAX_IMAGE_BYTES_PER_PROMPT - 10)];
    expect(fitsImageBudget(nearlyFull, 10)).toBe(true);
    expect(fitsImageBudget(nearlyFull, 11)).toBe(false);
  });
});
