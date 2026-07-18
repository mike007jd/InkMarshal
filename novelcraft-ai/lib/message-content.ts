const MAX_CHAT_MESSAGE_CHARS = 50_000;

export function parseRequiredMessageContent(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_CHAT_MESSAGE_CHARS) {
    return null;
  }
  const content = value.trim();
  return content.length > 0 ? content : null;
}
