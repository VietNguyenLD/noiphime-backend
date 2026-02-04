import { createHash } from 'crypto';
import { stableStringify } from './stableStringify';

export function sha256FromJson(value: any): string {
  const str = stableStringify(value);
  return createHash('sha256').update(str).digest('hex');
}
