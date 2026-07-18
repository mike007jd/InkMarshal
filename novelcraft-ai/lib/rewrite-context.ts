const CONTEXT_SIDE_MAX_CHARS = 100_000;

export interface RewriteContext {
  before: string;
  after: string;
}

function normalizeContextSide(value: unknown, field: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string`);
  }
  if (value.length > CONTEXT_SIDE_MAX_CHARS) {
    throw new Error(`${field} too large`);
  }
  return value;
}

export function normalizeRewriteContext(context: unknown): RewriteContext {
  if (context === undefined || context === null) {
    return { before: '', after: '' };
  }
  if (typeof context !== 'object') {
    throw new Error('context must be an object');
  }
  const raw = context as Record<string, unknown>;
  return {
    before: normalizeContextSide(raw.before, 'context.before'),
    after: normalizeContextSide(raw.after, 'context.after'),
  };
}
