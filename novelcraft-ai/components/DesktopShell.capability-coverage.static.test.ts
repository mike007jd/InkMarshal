import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DesktopShell non-local capability coverage health probes', () => {
  const shell = readFileSync(
    join(process.cwd(), 'components/DesktopShellLayout.tsx'),
    'utf8',
  );

  it('probes bound non-local connections via checkConnectionHealth', () => {
    expect(shell).toContain("import { checkConnectionHealth } from '@/lib/model-supply/runtime-health'");
    expect(shell).toContain('checkConnectionHealth(connection)');
    expect(shell).toContain('health.reachable && health.transportOk');
  });

  it('guards async readiness with a sequence token so stale probes cannot win', () => {
    expect(shell).toContain('const seq = ++readinessSeqRef.current');
    expect(shell).toContain('readinessSeqRef.current !== seq');
    expect(shell).toContain('if (invalidateNonLocal) setHealthyConnectionModels(new Map())');
    expect(shell).toContain('setHealthyConnectionModels(nextHealthy)');
  });

  it('invalidates on config mutation but preserves confirmed health during refresh probes', () => {
    expect(shell).toContain('healthyConnectionModels');
    expect(shell).toContain('if (readinessEnabled) refreshReadiness(true)');
    expect(shell).toContain("window.addEventListener('focus', retry)");
    expect(shell).toContain("window.addEventListener('online', retry)");
    expect(shell).toContain('window.setInterval(retry, CAPABILITY_HEALTH_REFRESH_MS)');
    expect(shell).toContain('window.clearInterval(healthInterval)');
  });

  it('never probes non-authoritative connection mirrors before SQLite hydration', () => {
    expect(shell).toContain('const result = await hydrateAppSettings()');
    expect(shell).toContain('if (!result.ok)');
    expect(shell).toContain('setSettingsLoadFailed(true)');
    expect(shell).toContain('setSettingsLoadFailed(false)');
    expect(shell).toContain('if (!readinessEnabled) return');
    expect(shell.indexOf('await hydrateAppSettings()')).toBeLessThan(
      shell.indexOf('readinessEnabled = true'),
    );
  });

  it('does not disguise settings hydration failure as zero ready models', () => {
    expect(shell).toContain('modelSettingsLoadFailedShort');
    expect(shell).toContain('visibleModelCoverageLabel');
    expect(shell).toContain('visibleModelCoverageTooltip');
  });
});
