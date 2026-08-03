import { readFileSync } from 'node:fs';
import type { ImageInput } from '../kernel/types.js';

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/** Read an image file into a base64 ImageInput (mime guessed from extension). */
export function loadImage(path: string): ImageInput {
  const data = readFileSync(path).toString('base64');
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return { mime: MIME_BY_EXT[ext] ?? 'application/octet-stream', data };
}

/** Read several image files; throws on the first missing/unreadable one. */
export function loadImages(paths: string[]): ImageInput[] {
  return paths.map((p) => loadImage(p));
}
