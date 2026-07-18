import { isUuid } from '@/lib/utils';

export function normalizeStyleId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return isUuid(trimmed) ? trimmed : null;
}
