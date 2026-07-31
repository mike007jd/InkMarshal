import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSibling(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function expectContains(source: string, fragments: readonly string[]): void {
  for (const fragment of fragments) {
    expect(source, `missing fragment:\n${fragment}`).toContain(fragment);
  }
}

function expectOmits(source: string, fragments: readonly string[]): void {
  for (const fragment of fragments) {
    expect(source, `unexpected fragment:\n${fragment}`).not.toContain(fragment);
  }
}

const pickerSource = readSibling('./ChatModelPicker.tsx');
const chatAreaSource = readSibling('../ChatArea.tsx');
const threadSource = readSibling('../assistant-ui/thread.tsx');

describe('chat composer model picker contract', () => {
  it('owns model selection inside the composer without a duplicate chat status strip', () => {
    expectContains(chatAreaSource, [
      '<ChatModelPicker onSavingChange={setModelSelectionPending} />',
    ]);
    expectOmits(chatAreaSource, [
      '<WritingModelStatusBar operation="chat" />',
    ]);
    expectContains(threadSource, [
      'controls={composerControls}',
      '{controls ? (',
      '<ComposerPrimitive.Send asChild disabled={sendDisabled}>',
      'disabled={sendDisabled}\n          aria-label={placeholder}',
    ]);
    expectOmits(pickerSource, [
      'border border-book-gold/40',
      'border border-book-border bg-book-bg-secondary/60',
    ]);
  });

  it('persists the canonical draft binding and preserves a valid fallback', () => {
    expectContains(pickerSource, [
      "saveCapabilityBindingDurable(\n      'draft'",
      'fallbackForSelection(binding, option.connectionId)',
    ]);
    expectOmits(pickerSource, ['x-im-model']);
  });

  it('only enables verified candidates and locks routing changes during a stream', () => {
    expectContains(pickerSource, [
      'selectable: verified.has(modelId)',
      'disabled={!option.selectable || isRunning || saving}',
      'disabled={isRunning || saving || loadingOptions}',
    ]);
  });

  it('keeps setup, management, and durable-save failure affordances reachable', () => {
    expectContains(pickerSource, [
      'openModelsPanel()',
      't.chatModelPickerManage',
      'setSaveError(t.capabilitySaveFailed)',
      'role="alert"',
    ]);
  });
});
