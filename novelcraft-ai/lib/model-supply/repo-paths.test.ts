import { describe, expect, it } from 'vitest';

import { legacyRepoToDir, repoDirCandidates, safeRepoToDir } from './repo-paths';

describe('HF repo directory names', () => {
  it('encodes slash-separated repo ids without underscore collisions', () => {
    expect(safeRepoToDir('org/model_name')).toBe('org%2Fmodel_name');
    expect(safeRepoToDir('org_model/name')).toBe('org_model%2Fname');
    expect(safeRepoToDir('org/model_name')).not.toBe(safeRepoToDir('org_model/name'));
  });

  it('keeps the old underscore directory as an install-detection fallback', () => {
    expect(legacyRepoToDir('org/model_name')).toBe('org_model_name');
    expect(repoDirCandidates('org/model_name')).toEqual([
      'org%2Fmodel_name',
      'org_model_name',
    ]);
  });
});
