'use server';

import { getUser } from '@/lib/local-auth';
import { verifyNovelOwnership } from '@/lib/db';
import { getDb } from '@/lib/db/connection';
import { recordActivityEvent } from '@/lib/db/queries-activity';

/** Export formats the command center counts as an effective-advance signal. */
export type ExportFormat = 'txt' | 'docx' | 'pdf' | 'epub' | 'bundle';

const EXPORT_FORMATS: readonly ExportFormat[] = ['txt', 'docx', 'pdf', 'epub', 'bundle'];

/**
 * Record a successful manuscript export as an `export_completed` activity event
 * (source='human'). Called by the UI AFTER a real export succeeds — this action
 * only writes telemetry, it never performs the export itself.
 *
 * Counts toward the Weekly Progressed Projects north-star metric (export is one
 * of the effective-advance event types). `words_delta` stays 0: an export does
 * not add manuscript words, so it must never inflate the word-trend bars.
 */
export async function recordExportActivity(
  novelId: string,
  format: ExportFormat,
): Promise<void> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  if (typeof novelId !== 'string' || novelId.length === 0 || novelId.length > 128) {
    throw new Error('Invalid novel id');
  }
  if (!EXPORT_FORMATS.includes(format)) {
    throw new Error('Invalid export format');
  }

  // Ownership gate (throws on a foreign/missing novel) before we write.
  await verifyNovelOwnership(novelId, user.id);

  // Best-effort telemetry: a failed event write must never surface as a failed
  // export to the user (the export already succeeded by the time we're called).
  try {
    const db = getDb();
    recordActivityEvent(db, {
      novelId,
      type: 'export_completed',
      source: 'human',
      wordsDelta: 0,
      meta: { format },
    });
  } catch (error) {
    console.error('recordExportActivity failed:', error);
  }
}
