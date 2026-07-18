// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  engineStatus: vi.fn(async () => [] as Array<{ engineId: string }>),
  hasLiveWritingConnection: vi.fn(() => false),
}));

vi.mock('@/lib/desktop-runtime', () => ({
  engineStatus: mocks.engineStatus,
}));

vi.mock('@/lib/model-supply/readiness', () => ({
  hasLiveWritingConnection: mocks.hasLiveWritingConnection,
}));

import {
  AI_ACTION_GATE_EVENT,
  AIActionGateCancelledError,
  awaitAIActionReady,
  rolesForAIAction,
  type AIActionGateRequest,
} from '@/lib/ai-action-gate';

afterEach(() => {
  vi.clearAllMocks();
  mocks.hasLiveWritingConnection.mockReturnValue(false);
});

describe('AI action gate', () => {
  it('maps operations to the exact unique capability roles', () => {
    expect(rolesForAIAction(['chapter', 'chat', 'outline', 'polish']))
      .toEqual(['draft', 'planning', 'rewrite']);
  });

  it('continues immediately when every required role is live', async () => {
    mocks.hasLiveWritingConnection.mockReturnValue(true);
    const listener = vi.fn();
    window.addEventListener(AI_ACTION_GATE_EVENT, listener);
    try {
      await expect(awaitAIActionReady(['chapter', 'outline'])).resolves.toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
      expect(mocks.hasLiveWritingConnection).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener(AI_ACTION_GATE_EVENT, listener);
    }
  });

  it('holds the original request and resumes it exactly once after setup', async () => {
    let captured: AIActionGateRequest | null = null;
    const listener = (event: Event) => {
      captured = (event as CustomEvent<AIActionGateRequest>).detail;
      captured.handled = true;
    };
    window.addEventListener(AI_ACTION_GATE_EVENT, listener);
    try {
      const waiting = awaitAIActionReady('polish');
      await vi.waitFor(() => expect(captured).not.toBeNull());
      captured!.resolve();
      captured!.resolve();
      await expect(waiting).resolves.toBeUndefined();
    } finally {
      window.removeEventListener(AI_ACTION_GATE_EVENT, listener);
    }
  });

  it('invalidates a pending request when its editing scope aborts', async () => {
    const controller = new AbortController();
    const listener = (event: Event) => {
      (event as CustomEvent<AIActionGateRequest>).detail.handled = true;
    };
    window.addEventListener(AI_ACTION_GATE_EVENT, listener);
    try {
      const waiting = awaitAIActionReady('chapter', controller.signal);
      await vi.waitFor(() => expect(mocks.engineStatus).toHaveBeenCalled());
      controller.abort();
      await expect(waiting).rejects.toEqual(
        expect.objectContaining<Partial<AIActionGateCancelledError>>({
          name: 'AIActionGateCancelledError',
          reason: 'scope-changed',
        }),
      );
    } finally {
      window.removeEventListener(AI_ACTION_GATE_EVENT, listener);
    }
  });
});
