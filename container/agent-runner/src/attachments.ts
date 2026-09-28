import fs from 'fs';
import path from 'path';

// Read each call so tests can override via env without re-importing.
function workspaceRoot(): string {
  return process.env.WORKSPACE_ROOT || '/workspace';
}

// Anthropic Messages API documents 5MB / image (base64-encoded). The base64
// payload is ~33% larger than the raw bytes, so we cap raw size well below
// the limit (3.5MB raw ≈ 4.7MB base64) to leave headroom. No sharp/resize
// step exists in the agent-runner image, so this is the only per-image bound.
export const MAX_RAW_IMAGE_BYTES = 3_500_000;

/**
 * Per-prompt image budget. Every inlined image lands verbatim in the SDK's
 * on-disk transcript, so a batch of many large photos would both blow the
 * API request size and bloat the resume path. Past either cap the formatter
 * falls back to the `[image: name — saved to /workspace/…]` path marker and
 * the agent can still Read the file.
 */
export const MAX_IMAGES_PER_PROMPT = 20;
export const MAX_IMAGE_BYTES_PER_PROMPT = 15_000_000;

export interface ImageContent {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
  /** Raw (pre-base64) size in bytes — what the per-prompt budget counts. */
  bytes: number;
}

/** Raw bytes already inlined onto a sink, for the per-prompt budget. */
export function imageBudgetUsed(images: ImageContent[]): number {
  return images.reduce((sum, img) => sum + img.bytes, 0);
}

/**
 * True when one more image of `bytes` raw size still fits the per-prompt
 * budget alongside what is already on the sink.
 */
export function fitsImageBudget(images: ImageContent[], bytes: number): boolean {
  return images.length < MAX_IMAGES_PER_PROMPT && imageBudgetUsed(images) + bytes <= MAX_IMAGE_BYTES_PER_PROMPT;
}

/**
 * Sniff the image mime type from the first few bytes. Returns null for
 * formats Anthropic doesn't accept (or anything we can't identify).
 */
function sniffImageMime(buf: Buffer): ImageContent['mediaType'] | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return 'image/png';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  )
    return 'image/webp';
  return null;
}

/**
 * Try to load an image attachment as a base64 content block. Returns null
 * (and the caller falls back to the path-marker text) when the file is
 * missing, oversized, or not a recognized image format.
 *
 * `localPath` is relative to /workspace/ (matches formatter.ts's mounting
 * convention for chat-sdk attachments).
 */
export function loadImageAttachment(localPath: string): ImageContent | null {
  const root = workspaceRoot();
  // Defense against a hostile localPath escaping the workspace root.
  const abs = path.resolve(root, localPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_RAW_IMAGE_BYTES) return null;

  let buf: Buffer;
  try {
    buf = fs.readFileSync(abs);
  } catch {
    return null;
  }
  const mediaType = sniffImageMime(buf);
  if (!mediaType) return null;

  return { mediaType, data: buf.toString('base64'), bytes: buf.length };
}
