// Maps a failed ConnectionHealth probe to a product-level category so UI can
// render localized, actionable copy instead of the raw backend/network message
// (which may be Rust-side English and may embed URLs users should not see).

import type { Translations } from '@/lib/i18n';
import type { ConnectionHealth } from './types';

export type HealthFailureCategory =
  | 'desktop-required'
  | 'unreachable'
  | 'verification-failed'
  | 'probe-failed';

/**
 * Classify a failed health result. Callers must only use this when the probe
 * did not fully succeed (`reachable && transportOk` is false); a healthy
 * result has no category.
 */
export function categorizeHealthFailure(
  health: Pick<ConnectionHealth, 'reachable' | 'transportOk' | 'failureKind'>,
): HealthFailureCategory {
  if (health.failureKind === 'desktop-required') return 'desktop-required';
  if (health.failureKind === 'probe-failed') return 'probe-failed';
  // The Rust contract intentionally exposes only reachability and transport
  // validity here. A reachable-but-invalid result may be a bad API key, a
  // wrong base URL/mode, or an upstream HTTP failure, so do not overclaim a
  // protocol mismatch.
  if (health.reachable && !health.transportOk) return 'verification-failed';
  return 'unreachable';
}

/** Localized, actionable product copy for a failed probe category. */
export function healthFailureMessage(
  category: HealthFailureCategory,
  t: Translations,
): string {
  switch (category) {
    case 'desktop-required':
      return t.modelManagerTestRequiresDesktop;
    case 'verification-failed':
      return t.runtimeHealthVerificationFailed;
    case 'probe-failed':
      return t.runtimeHealthProbeFailed;
    default:
      return t.runtimeHealthUnreachable;
  }
}
