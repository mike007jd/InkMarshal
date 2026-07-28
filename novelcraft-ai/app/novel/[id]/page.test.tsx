// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const routeProbe = vi.hoisted(() => ({
  novelId: 'novel-a',
  lifecycle: [] as string[],
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: routeProbe.novelId }),
}));

vi.mock('@/components/NovelWorkspace', async () => {
  const ReactModule = await import('react');
  class WorkspaceProbe extends ReactModule.Component<{ novelId: string }> {
    componentDidMount() {
      routeProbe.lifecycle.push(`mount:${this.props.novelId}`);
    }

    componentWillUnmount() {
      routeProbe.lifecycle.push(`unmount:${this.props.novelId}`);
    }

    render() {
      return ReactModule.createElement(
        'div',
        { 'data-testid': `workspace:${this.props.novelId}` },
      );
    }
  }
  return {
    NovelWorkspace: WorkspaceProbe,
  };
});

import NovelPage from '@/app/novel/[id]/page';

afterEach(() => {
  cleanup();
  routeProbe.novelId = 'novel-a';
  routeProbe.lifecycle = [];
});

it('remounts the complete novel workspace when the route novel id changes', () => {
  const rendered = render(<NovelPage />);
  expect(routeProbe.lifecycle).toEqual(['mount:novel-a']);

  routeProbe.novelId = 'novel-b';
  rendered.rerender(<NovelPage />);

  expect(routeProbe.lifecycle).toEqual([
    'mount:novel-a',
    'unmount:novel-a',
    'mount:novel-b',
  ]);
});
