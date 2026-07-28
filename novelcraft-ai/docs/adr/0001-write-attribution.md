# ADR 0001: Transport Does Not Own Domain Writes

- Status: Amended
- Original decision: 2026-06-05
- Amended: 2026-07-28

## Context

The original rule made server actions the default mutation transport to stop
knowledge writes from diverging across UI paths. The application now
legitimately uses both server actions and route handlers for CRUD, streaming,
abortable work, binary exports, backup/restore, and non-React callers.

The durable problem is not transport choice. It is duplicated validation, transaction, index, Vault, and recovery ordering.

## Decision

- Choose server actions for React-local mutations when action semantics fit.
- Choose route handlers for fetch clients, streaming, abort, binary responses, probes, backup/restore, or external callers.
- Put the actual domain write in a shared server-side primitive.
- That primitive owns validation, scope/ownership checks, transaction boundaries, durable projection intent, and side-effect ordering.
- Transport adapters stay thin and must not implement competing write sequences.

For knowledge entry writes, `lib/knowledge/apply-write.ts` and `lib/knowledge/refresh-index.ts` remain the shared implementation.

## Consequences

- The original “all mutations use server actions” rule is superseded.
- New route handlers are acceptable when their transport is justified and they reuse domain primitives.
- Review focuses on transaction/rollback symmetry, stale-run suppression, and durable outbox behavior across every caller.
