'use client';

// Secret storage abstraction — DESKTOP-ONLY, fail-closed.
//
//   Desktop (Tauri): system keychain via the A.1 Rust commands, routed through
//     the `lib/desktop-runtime.ts` wrappers (single invoke implementation).
//
// There is NO web secret path. The product has no web Studio / web login /
// cloud writing (see proxy.ts + the project constitution), so off-desktop these
// operations FAIL CLOSED — they reject rather than silently persisting an API
// key in origin-scoped localStorage (which a runtime-port change could also
// strand). A secret value MUST NEVER touch localStorage.
//
// CONTRACT: the keychain is one shared service keyed by `account`; callers pass
// already-namespaced accounts (e.g. `connection:<id>` from
// `connectionSecretAccount`). This module does not re-namespace.

import {
  isTauriRuntime,
  keychainDelete,
  keychainGet,
  keychainSet,
  keychainStatus,
} from '@/lib/desktop-runtime';
import { CONTROL_CHARS } from '@/lib/vault/path-validation';
import {
  CONNECTION_SECRET_PREFIX,
  MAX_CONNECTION_SECRET_ACCOUNT_LENGTH,
  MAX_CONNECTION_SECRET_VALUE_LENGTH,
} from './types';

const DESKTOP_REQUIRED = 'Secret storage requires the desktop keychain runtime';

function validateSecretAccount(account: string): void {
  if (
    !account ||
    account.length > MAX_CONNECTION_SECRET_ACCOUNT_LENGTH ||
    !account.startsWith(CONNECTION_SECRET_PREFIX) ||
    account.length === CONNECTION_SECRET_PREFIX.length ||
    CONTROL_CHARS.test(account)
  ) {
    throw new Error('Secret account is invalid');
  }
}

function validateSecretValue(value: string): void {
  if (
    !value.trim() ||
    value.length > MAX_CONNECTION_SECRET_VALUE_LENGTH ||
    CONTROL_CHARS.test(value)
  ) {
    throw new Error('Secret value is invalid');
  }
}

export interface SecretStoreStatus {
  backend: 'keychain' | 'encrypted_file';
  available: boolean;
}

/**
 * Async desktop probe: queries Rust which backend is actually active — returns
 * `keychain` if the OS keychain is reachable, `encrypted_file` if Rust fell back
 * to the AES-256-GCM file under the app data dir. Rejects off-desktop: there is
 * no web secret backend. UI banners use this to warn when the OS keychain is
 * unavailable.
 */
export async function secretStoreActiveBackend(): Promise<SecretStoreStatus['backend']> {
  if (!isTauriRuntime()) throw new Error(DESKTOP_REQUIRED);
  try {
    return await keychainStatus();
  } catch {
    return 'encrypted_file';
  }
}

/**
 * Which backend is active and whether it is usable in this environment.
 * Off-desktop reports `available: false` — no web secret backend exists. On
 * desktop, `available: true` means only "the keychain backend is selected", NOT
 * health-verified: a real keychain op can still REJECT if the keyring is locked
 * or unavailable. A genuine health probe is deferred to B.4 (not built here) —
 * intentionally synchronous, no premature async OS round-trip.
 */
export function secretStoreStatus(): SecretStoreStatus {
  return { backend: 'keychain', available: isTauriRuntime() };
}

/** Store `value` under `account` in the desktop keychain. Errors propagate. */
export async function setSecret(account: string, value: string): Promise<void> {
  validateSecretAccount(account);
  validateSecretValue(value);
  if (!isTauriRuntime()) throw new Error(DESKTOP_REQUIRED);
  await keychainSet(account, value);
}

/**
 * Read the secret under `account`, or `null` if absent.
 *
 * Contract (callers in B.3 resolver / B.4 UI MUST honor this): a resolved `null`
 * means ONLY "no secret stored for this account". A real keychain failure
 * (keyring locked/unavailable) does NOT collapse to `null` — it REJECTS, as does
 * calling this off-desktop. Callers must distinguish "unbound" (null) from
 * "error" (catch) and surface an actionable message rather than treating a
 * rejection as "no key configured". (A.1 maps NoEntry→null; other errors→reject.)
 */
export async function getSecret(account: string): Promise<string | null> {
  validateSecretAccount(account);
  if (!isTauriRuntime()) throw new Error(DESKTOP_REQUIRED);
  return keychainGet(account);
}

/** Delete the secret under `account` (idempotent). Keychain errors propagate. */
export async function deleteSecret(account: string): Promise<void> {
  validateSecretAccount(account);
  if (!isTauriRuntime()) throw new Error(DESKTOP_REQUIRED);
  await keychainDelete(account);
}
