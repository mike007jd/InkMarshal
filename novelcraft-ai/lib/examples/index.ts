import { SPARK_FROM_THE_FORGE } from './spark-from-the-forge';
import { CARTOGRAPHERS_DAUGHTER } from './cartographers-daughter';
import { SALT_AND_HOLLOW } from './salt-and-hollow';
import { LAST_LIGHT_OF_AVENMOOR } from './last-light-of-avenmoor';
import type { ExampleNovel } from './types';

export const EXAMPLE_NOVELS: ExampleNovel[] = [
  SPARK_FROM_THE_FORGE,
  CARTOGRAPHERS_DAUGHTER,
  SALT_AND_HOLLOW,
  LAST_LIGHT_OF_AVENMOOR,
];

const BY_ID = new Map<string, ExampleNovel>();
const BY_SLUG = new Map<string, ExampleNovel>();

for (const ex of EXAMPLE_NOVELS) {
  BY_ID.set(ex.novel.id, ex);
  BY_SLUG.set(ex.slug, ex);
}

export function getExampleBySlug(slug: string): ExampleNovel | undefined {
  return BY_SLUG.get(slug);
}

export function getExampleById(id: string): ExampleNovel | undefined {
  return BY_ID.get(id);
}
