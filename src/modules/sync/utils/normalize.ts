import { createHash } from 'crypto';

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

export function normalizeTitle(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
