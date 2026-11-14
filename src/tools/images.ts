/**
 * Image downscaling for tool results. claude.ai inlines results only up to
 * ~150k characters and base64 counts toward that, so camera frames and
 * satellite images are resized/re-encoded with sharp. If sharp is not
 * available, oversized images are dropped (with a note) instead.
 */
import type { ToolImage } from './types.js';

type SharpFn = (input: Buffer) => {
  rotate(): ReturnType<SharpFn>;
  resize(o: {
    width: number;
    height: number;
    fit: 'inside';
    withoutEnlargement: boolean;
  }): ReturnType<SharpFn>;
  jpeg(o: { quality: number; mozjpeg?: boolean }): ReturnType<SharpFn>;
  toBuffer(): Promise<Buffer>;
};

let sharpPromise: Promise<SharpFn | null> | undefined;
export function loadSharp(): Promise<SharpFn | null> {
  sharpPromise ??= import('sharp')
    .then((m) => (m.default ?? m) as unknown as SharpFn)
    .catch(() => null);
  return sharpPromise;
}

export interface ShrinkOptions {
  maxDim: number;
  maxBase64Chars: number;
  loader?: () => Promise<SharpFn | null>;
}

export type ShrinkResult = { image: ToolImage; resized: boolean } | { dropped: string };

export async function shrinkImage(img: ToolImage, opts: ShrinkOptions): Promise<ShrinkResult> {
  const sharp = await (opts.loader ?? loadSharp)();
  if (!sharp) {
    if (img.data.length <= opts.maxBase64Chars) return { image: img, resized: false };
    return {
      dropped: `image omitted: ${Math.round(img.data.length / 1024)} KB base64 exceeds the limit and no image library is available`,
    };
  }
  let input: Buffer;
  try {
    input = Buffer.from(img.data, 'base64');
  } catch {
    return { dropped: 'image omitted: invalid base64' };
  }
  let dim = opts.maxDim;
  let quality = 72;
  for (let attempt = 0; attempt < 10; attempt++) {
    let out: Buffer;
    try {
      out = await sharp(input)
        .rotate()
        .resize({ width: dim, height: dim, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
    } catch {
      return { dropped: 'image omitted: could not decode image' };
    }
    const b64 = out.toString('base64');
    if (b64.length <= opts.maxBase64Chars) {
      return { image: { mimeType: 'image/jpeg', data: b64 }, resized: true };
    }
    if (quality > 40) quality -= 16;
    else dim = Math.floor(dim * 0.75);
    if (dim < 96) break;
  }
  return { dropped: 'image omitted: could not shrink it under the size limit' };
}
