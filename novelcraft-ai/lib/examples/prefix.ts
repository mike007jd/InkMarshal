// Synthetic novel id prefix for read-only example novels surfaced in visitor
// mode. Lives in its own tiny module so fixture files can use it without
// circling back through the index.
export const EXAMPLE_NOVEL_ID_PREFIX = 'example-';

export function isExampleNovelId(id: string | undefined | null): boolean {
  return typeof id === 'string' && id.startsWith(EXAMPLE_NOVEL_ID_PREFIX);
}
