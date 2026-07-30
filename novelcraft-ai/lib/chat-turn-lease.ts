import {
  CHAT_TURN_STALE_LEASE_MS,
  renewChatTurnClaim,
} from '@/lib/db/queries-chat-turns';

/**
 * Route `maxDuration` for chat provider streams (seconds → ms).
 * The application deadline must stay strictly inside this envelope.
 */
export const CHAT_TURN_ROUTE_MAX_DURATION_MS = 300_000;

/**
 * Application-owned execution deadline for a claimed provider stream.
 * Strictly below both {@link CHAT_TURN_STALE_LEASE_MS} and the route maxDuration
 * so a live worker either finishes, cancels, or loses its claim before stale
 * reclaim is allowed.
 */
export const CHAT_TURN_CLAIM_DEADLINE_MS = 280_000;

/**
 * Conservative heartbeat: renew well below the stale reclaim threshold so a
 * still-live stream cannot be mistaken for an abandoned row.
 */
export const CHAT_TURN_CLAIM_HEARTBEAT_MS = Math.floor(CHAT_TURN_STALE_LEASE_MS / 5);

if (
  !(
    CHAT_TURN_CLAIM_DEADLINE_MS < CHAT_TURN_STALE_LEASE_MS
    && CHAT_TURN_CLAIM_DEADLINE_MS < CHAT_TURN_ROUTE_MAX_DURATION_MS
  )
) {
  throw new Error(
    'CHAT_TURN_CLAIM_DEADLINE_MS must be strictly below the stale lease and route maxDuration',
  );
}

export interface ChatTurnActiveClaim {
  novelId: string;
  userMessageId: string;
  claimToken: string;
}

export interface ChatTurnActiveClaimLeaseOptions extends ChatTurnActiveClaim {
  requestSignal: AbortSignal;
  deadlineMs?: number;
  heartbeatMs?: number;
  renewClaim?: (args: ChatTurnActiveClaim) => boolean;
}

export interface ChatTurnActiveClaimLease {
  /** Combined request + deadline + claim-loss abort signal. */
  signal: AbortSignal;
  hasLostClaim(): boolean;
  start(): void;
  dispose(): void;
}

const testHeartbeatTicks = new Set<() => void>();

/** Deterministic test hook: run one renew tick for every active lease. */
export function __tickChatTurnClaimLeasesForTest(): void {
  for (const tick of [...testHeartbeatTicks]) tick();
}

/**
 * Shared active-claim lease for ordinary, brainstorm, and conversation streams.
 * Renews the durable running claim on a timer and aborts when the claim is lost
 * or the application deadline elapses.
 */
export function createChatTurnActiveClaimLease(
  args: ChatTurnActiveClaimLeaseOptions,
): ChatTurnActiveClaimLease {
  const deadlineMs = args.deadlineMs ?? CHAT_TURN_CLAIM_DEADLINE_MS;
  const heartbeatMs = args.heartbeatMs ?? CHAT_TURN_CLAIM_HEARTBEAT_MS;
  const renew = args.renewClaim ?? renewChatTurnClaim;
  const controller = new AbortController();
  let lostClaim = false;
  let disposed = false;
  let started = false;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const runHeartbeat = () => {
    if (disposed || lostClaim || controller.signal.aborted) return;
    let ok = false;
    try {
      ok = renew({
        novelId: args.novelId,
        userMessageId: args.userMessageId,
        claimToken: args.claimToken,
      });
    } catch {
      ok = false;
    }
    if (!ok) {
      lostClaim = true;
      if (!controller.signal.aborted) controller.abort();
    }
  };

  const clearTimers = () => {
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    testHeartbeatTicks.delete(runHeartbeat);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearTimers();
    args.requestSignal.removeEventListener('abort', abortFromRequest);
  };

  const abortFromRequest = () => {
    if (!controller.signal.aborted) controller.abort();
  };

  controller.signal.addEventListener('abort', dispose, { once: true });

  if (args.requestSignal.aborted) {
    abortFromRequest();
  } else {
    args.requestSignal.addEventListener('abort', abortFromRequest, { once: true });
  }

  return {
    signal: controller.signal,
    hasLostClaim: () => lostClaim,
    start() {
      if (started || disposed) return;
      started = true;
      if (controller.signal.aborted) {
        dispose();
        return;
      }
      deadlineTimer = setTimeout(() => {
        if (!controller.signal.aborted) controller.abort();
      }, deadlineMs);
      heartbeatTimer = setInterval(runHeartbeat, heartbeatMs);
      testHeartbeatTicks.add(runHeartbeat);
    },
    dispose,
  };
}
