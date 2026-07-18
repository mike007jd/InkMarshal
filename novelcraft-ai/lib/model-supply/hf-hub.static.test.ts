import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(): string {
  return readFileSync(join(process.cwd(), 'lib/model-supply/hf-hub.ts'), 'utf8');
}

describe('HF search client bounds', () => {
  it('bounds query and limit before desktop or web HF search', () => {
    const hub = source();

    expect(hub).toContain('HF_SEARCH_MAX_LIMIT = 50');
    expect(hub).toContain('HF_SEARCH_MAX_QUERY_LENGTH = 120');
    expect(hub).toContain('clampHfSearchLimit(limit)');
    expect(hub).toContain('hfSearchModels(trimmed, format, boundedLimit)');
    expect(hub).toContain('String(boundedLimit)');
    expect(hub).toContain('.slice(0, boundedLimit)');
  });
});

describe('HF web search query shape (MS-08)', () => {
  it('uses the `filter=` tag facet (gguf|mlx), not `library=`', () => {
    const hub = source();
    // `filter=${format}` is the verified-correct HF model-tag facet for both
    // gguf and mlx; `library=` does not filter and must not be used.
    expect(hub).toContain('&filter=${format}&limit=');
    expect(hub).not.toContain('&library=');
    // Stable ordering knobs that web + desktop both rely on.
    expect(hub).toContain('&sort=downloads&direction=-1');
  });
});

describe('HF MLX file allowlist (MS-04)', () => {
  it('keeps current MLX snapshot sidecars and chat templates', () => {
    const hub = source();
    // Current Qwen/MLX repos carry auxiliary JSON sidecars and a separate chat
    // template file; web fallback must match the desktop Rust snapshot policy.
    expect(hub).not.toContain("lower.endsWith('.json')");
    expect(hub).not.toContain("lower.startsWith('tokenizer')");
    expect(hub).toContain('MLX_SNAPSHOT_ROOT_SIDECARS');
    expect(hub).toContain("lower.endsWith('.safetensors')");
    expect(hub).toContain("lower.endsWith('.safetensors.index.json')");
    expect(hub).toContain("'chat_template.jinja'");
    expect(hub).toContain("'tokenizer_config.json'");
    expect(hub).toContain('isMlxSnapshotFile(entry.path)');
    expect(hub).toContain('kv_config.json');
    expect(hub).toContain('optiq_metadata.json');
    expect(hub).toContain("if (lower.includes('/')) return false");
  });
});
