import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8');
}

describe('open-source feature settings surfaces', () => {
  it('renders the configurable model source in General settings', () => {
    const settings = source('components/SettingsPanel.tsx');
    const modelSource = source('components/ModelDownloadSourceSettings.tsx');

    expect(settings).toContain('<ModelDownloadSourceSettings />');
    expect(modelSource).toContain("const MIRROR_ENDPOINT = 'https://hf-mirror.com'");
    expect(modelSource).toContain('<SelectItem value="official">');
    expect(modelSource).toContain('<SelectItem value="mirror">');
    expect(modelSource).toContain('<SelectItem value="custom">');
    expect(modelSource).toContain('hfSetEndpoint(endpoint)');
  });

  it('uses the localized provider directory when adding a connection', () => {
    const providers = source('components/ProviderConnectionsPanel.tsx');

    expect(providers).toContain('{t.providerDirectoryLabel}');
    expect(providers).toContain('providerDisplayName(preset, t)');
    expect(providers).toContain('PROVIDER_PRESETS.map');
  });
});
