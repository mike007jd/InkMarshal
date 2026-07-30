import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireNovelOwner } from '@/lib/local-auth';
import { getDb } from '@/lib/db/connection';
import { fromJsonTextLenient, toJsonText } from '@/lib/db/json-columns';
import { recordActivityEvent } from '@/lib/db/queries-activity';
import { nowIso, safeParseJson, sanitizeError } from '@/lib/utils';
import type { NovelSettings, WorkStatus } from '@/lib/db-types';

const WORK_STATUSES: readonly WorkStatus[] = [
  'ideation',
  'drafting',
  'structural_revision',
  'line_revision',
  'proofreading',
  'delivery',
];

// Each field is optional (partial PATCH). `null` is an explicit "clear this
// goal" signal; an absent key leaves the existing value untouched. Word goals
// are capped to a sane ceiling to keep the gauge math bounded.
const projectGoalsSchema = z
  .object({
    deadline: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'deadline must be an ISO date (YYYY-MM-DD)')
      .nullable()
      .optional(),
    dailyWordGoal: z.number().int().min(1).max(1_000_000).nullable().optional(),
    weeklyWordGoal: z.number().int().min(1).max(7_000_000).nullable().optional(),
    workStatus: z.enum(WORK_STATUSES as [WorkStatus, ...WorkStatus[]]).nullable().optional(),
  })
  .strict();

/**
 * PATCH per-novel project goals (deadline / daily + weekly word goal / work
 * status) into `novels.settings`. Low-frequency config — merged into the JSON
 * bag, no DDL. When `workStatus` actually changes we append a `status_changed`
 * activity event (source='human') IN THE SAME TRANSACTION as the settings write,
 * so the north-star/timeline can never disagree with the stored status.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const ownerCheck = await requireNovelOwner(id);
  if (ownerCheck instanceof NextResponse) return ownerCheck;

  try {
    const parsed = await safeParseJson<unknown>(request);
    if (parsed.error) return parsed.error;
    const patch = projectGoalsSchema.parse(parsed.data);

    const db = getDb();
    const write = db.transaction(() => {
      const row = db.prepare('SELECT settings FROM novels WHERE id = ?').get(id) as
        | { settings: string | null }
        | undefined;
      if (!row) return null;
      const current = fromJsonTextLenient<NovelSettings>(row.settings) ?? {};
      const prevWorkStatus = current.workStatus ?? null;
      const next: NovelSettings = { ...current };
      applyGoalField(next, patch, 'deadline');
      applyGoalField(next, patch, 'dailyWordGoal');
      applyGoalField(next, patch, 'weeklyWordGoal');
      applyGoalField(next, patch, 'workStatus');

      const nextWorkStatus = next.workStatus ?? null;
      const workStatusChanged =
        Object.prototype.hasOwnProperty.call(patch, 'workStatus') &&
        nextWorkStatus !== prevWorkStatus;
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        db.prepare('UPDATE novels SET settings = ?, updated_at = ? WHERE id = ?').run(
          Object.keys(next).length === 0 ? null : toJsonText(next),
          nowIso(),
          id,
        );
      }
      if (workStatusChanged) {
        recordActivityEvent(db, {
          novelId: id,
          type: 'status_changed',
          source: 'human',
          meta: { from: prevWorkStatus, to: nextWorkStatus },
        });
      }
      return { next, workStatusChanged };
    });
    const result = write.immediate();
    if (!result) {
      return NextResponse.json({ error: 'Novel not found' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      settings: {
        deadline: result.next.deadline ?? null,
        dailyWordGoal: result.next.dailyWordGoal ?? null,
        weeklyWordGoal: result.next.weeklyWordGoal ?? null,
        workStatus: result.next.workStatus ?? null,
      },
      workStatusChanged: result.workStatusChanged,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: error.issues[0]?.message ?? 'Invalid project goals' },
        { status: 400 },
      );
    }
    console.error('project-goals PATCH failed:', error);
    return NextResponse.json(
      { error: sanitizeError(error, 'Failed to update project goals') },
      { status: 500 },
    );
  }
}

/**
 * Apply one optional goal field with explicit-null semantics: a present `null`
 * clears the key (so it's absent from the bag), a present value sets it, and an
 * absent key leaves the existing value untouched.
 */
type GoalKey = 'deadline' | 'dailyWordGoal' | 'weeklyWordGoal' | 'workStatus';

function applyGoalField<K extends GoalKey>(
  target: NovelSettings,
  patch: Partial<Record<GoalKey, NovelSettings[GoalKey] | null>>,
  key: K,
): void {
  if (!Object.prototype.hasOwnProperty.call(patch, key)) return;
  const value = patch[key];
  if (value === null || value === undefined) {
    delete target[key];
  } else {
    target[key] = value as NovelSettings[K];
  }
}
