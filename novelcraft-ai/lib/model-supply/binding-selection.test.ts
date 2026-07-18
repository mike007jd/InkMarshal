import { describe, expect, it } from 'vitest';

import { bindingForConnectionSelection } from './binding-selection';

describe('bindingForConnectionSelection', () => {
  it('commits the first available model when a role connection is selected', () => {
    expect(
      bindingForConnectionSelection('provider-a', ['model-a', 'model-b'], null),
    ).toEqual({
      connectionId: 'provider-a',
      modelId: 'model-a',
    });
  });

  it('keeps an existing fallback when switching the primary to a different connection', () => {
    expect(
      bindingForConnectionSelection(
        'provider-b',
        ['model-b'],
        {
          connectionId: 'provider-a',
          modelId: 'model-a',
          fallback: { connectionId: 'provider-c', modelId: 'model-c' },
        },
      ),
    ).toEqual({
      connectionId: 'provider-b',
      modelId: 'model-b',
      fallback: { connectionId: 'provider-c', modelId: 'model-c' },
    });
  });

  it('does not persist a half-binding when no model is available yet', () => {
    expect(
      bindingForConnectionSelection(
        'manual-runtime',
        [],
        { connectionId: 'old-runtime', modelId: 'old-model' },
      ),
    ).toBeNull();
  });

  it('drops a fallback that would point at the newly selected primary connection', () => {
    expect(
      bindingForConnectionSelection(
        'fallback-runtime',
        ['primary-model'],
        {
          connectionId: 'old-runtime',
          modelId: 'old-model',
          fallback: { connectionId: 'fallback-runtime', modelId: 'fallback-model' },
        },
      ),
    ).toEqual({
      connectionId: 'fallback-runtime',
      modelId: 'primary-model',
    });
  });
});
