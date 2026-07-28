# Deferred Decision: Encrypted Sync and Collaboration

Status: not approved for implementation.

## Decision boundary

Personal multi-device sync and multi-user collaboration are separate product decisions. Neither may introduce a required cloud account or silently weaken the local-first data model.

Evaluate personal sync first. Collaboration requires an explicit product decision about whether permissions are advisory or server-enforced.

## Invariants

- Manuscripts and model/provider credentials remain user-owned.
- Credentials are never synchronized.
- Sync is opt-in, scoped to one novel, encrypted, integrity-checked, and recoverable.
- Applying remote state preserves novel isolation and the same transaction/version rules as local writes.
- Conflicts preserve losing content; no merge may silently discard manuscript data.

## Unresolved trade-off

Without a trusted service, a recipient who possesses an encrypted collaboration
package can modify their local database outside the UI. Read-only, comment-only,
and suggestion roles are therefore packaging conventions, not
cryptographically enforced permissions.

True invitation, revocation, and enforceable roles require a trusted coordination service, which would change the current product boundary.

## Approval gate

Before implementation:

1. Decide personal sync versus collaboration scope.
2. Decide advisory versus server-enforced permissions.
3. Define threat model, key recovery, conflict handling, and credential exclusions.
4. Prove forward/backward data migration and failure recovery.
5. Write a current product requirement and architecture decision; do not implement from this note.
