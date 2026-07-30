'use server';

// Manuscript import server actions — opaque session pipeline.
//
//   openImportSessionAction    — token+basename → parse staged file, store
//                                full prose server-side, return previews.
//   confirmImportSessionAction — compact chapter refs + dedupe decisions →
//                                reconstruct prose and atomic SQLite write.
//
// File bytes and full chapter prose never travel through these actions (Next
// Server Actions default body limit is 1 MiB). Staging is native-side via
// `stage_manuscript_import`.

import { getUser } from '@/lib/local-auth';
import { openImportSession } from '@/lib/import/session-open';
import {
  confirmImportSession,
  type ConfirmImportSessionInput,
  type ConfirmImportSessionResult,
} from '@/lib/import/session-confirm';
import type { OpenImportSessionInput, OpenImportSessionResult } from '@/lib/import/session-open';

export async function openImportSessionAction(
  input: OpenImportSessionInput,
): Promise<OpenImportSessionResult> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  return openImportSession(input);
}

export async function confirmImportSessionAction(
  input: ConfirmImportSessionInput,
): Promise<ConfirmImportSessionResult> {
  const user = await getUser();
  if (!user?.id) throw new Error('Local user context missing');
  return confirmImportSession(input);
}
