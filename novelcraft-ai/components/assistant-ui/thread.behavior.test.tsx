// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, type FC } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AssistantRuntimeProvider,
  useAui,
  useLocalRuntime,
  type ChatModelAdapter,
} from '@assistant-ui/react';

import { NovelThread } from '@/components/assistant-ui/thread';

vi.mock('@/components/LanguageProvider', () => ({
  useLocale: () => ({
    t: {
      chatAttachFile: 'Attach',
      chatRemoveAttachment: 'Remove attachment',
      chatScrollToBottom: 'Scroll to bottom',
      chatCopy: 'Copy',
      conversationSendMessage: 'Send message',
      writingStop: 'Stop',
      thinking: 'Thinking…',
      toastRetry: 'Retry',
    },
  }),
}));

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock);

if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function scrollTo() {};
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function createHangingAdapter() {
  let releaseCurrent: (() => void) | null = null;
  const adapter: ChatModelAdapter = {
    async *run({ abortSignal }) {
      yield { content: [{ type: 'text', text: 'Partial reply' }] };
      await new Promise<void>((resolve) => {
        releaseCurrent = resolve;
        abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { content: [{ type: 'text', text: 'Partial reply finished' }] };
    },
  };
  return {
    adapter,
    completeNaturally: () => {
      releaseCurrent?.();
      releaseCurrent = null;
    },
  };
}

const StartRunning: FC = () => {
  const aui = useAui();
  useEffect(() => {
    aui.thread().composer().setText('Write a scene');
    aui.thread().composer().send();
  }, [aui]);
  return null;
};

const ThreadHarness: FC<{ adapter: ChatModelAdapter }> = ({ adapter }) => {
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <StartRunning />
      <NovelThread placeholder="Continue the story…" />
    </AssistantRuntimeProvider>
  );
};

describe('NovelThread composer focus after Stop', () => {
  afterEach(() => {
    cleanup();
  });

  it('restores composer focus after a user-initiated Stop unmounts the Stop control', async () => {
    const { adapter } = createHangingAdapter();
    render(<ThreadHarness adapter={adapter} />);

    const stop = await screen.findByRole('button', { name: 'Stop' });
    await act(async () => {
      stop.focus();
    });
    expect(document.activeElement).toBe(stop);

    fireEvent.click(stop);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    });

    const composer = screen.getByRole('textbox', { name: 'Continue the story…' });
    expect(document.activeElement).toBe(composer);
    expect(screen.getByRole('button', { name: 'Send message' })).toBeTruthy();
  });

  it('does not auto-focus the composer when a stream ends without a user Stop', async () => {
    const { adapter, completeNaturally } = createHangingAdapter();
    render(<ThreadHarness adapter={adapter} />);

    const stop = await screen.findByRole('button', { name: 'Stop' });
    await act(async () => {
      stop.focus();
    });
    expect(document.activeElement).toBe(stop);

    await act(async () => {
      completeNaturally();
      await flush();
      await flush();
    });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    });

    const composer = screen.getByRole('textbox', { name: 'Continue the story…' });
    expect(document.activeElement).not.toBe(composer);
    expect(
      document.activeElement === document.body
      || document.activeElement === document.documentElement,
    ).toBe(true);
  });
});
