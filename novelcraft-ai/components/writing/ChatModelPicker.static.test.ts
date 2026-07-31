import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pickerSource = readFileSync(
  new URL('./ChatModelPicker.tsx', import.meta.url),
  'utf8',
);
const chatAreaSource = readFileSync(
  new URL('../ChatArea.tsx', import.meta.url),
  'utf8',
);
const threadSource = readFileSync(
  new URL('../assistant-ui/thread.tsx', import.meta.url),
  'utf8',
);

describe('chat composer model picker contract', () => {
  it('owns model selection inside the composer without a duplicate chat status strip', () => {
    expect(chatAreaSource).toContain('<ChatModelPicker onSavingChange={setModelSelectionPending} />');
    expect(chatAreaSource).not.toContain('<WritingModelStatusBar operation="chat" />');
    expect(threadSource).toContain('controls={composerControls}');
    expect(threadSource).toContain('{controls ? (');
    expect(threadSource).toContain('<ComposerPrimitive.Send asChild disabled={sendDisabled}>');
    expect(threadSource).toContain('disabled={sendDisabled}\n          aria-label={placeholder}');
    expect(pickerSource).not.toContain('border border-book-gold/40');
    expect(pickerSource).not.toContain('border border-book-border bg-book-bg-secondary/60');
  });

  it('persists the canonical draft binding and preserves a valid fallback', () => {
    expect(pickerSource).toContain("saveCapabilityBindingDurable(\n      'draft'");
    expect(pickerSource).toContain('fallbackForSelection(binding, option.connectionId)');
    expect(pickerSource).not.toContain('x-im-model');
  });

  it('only enables verified candidates and locks routing changes during a stream', () => {
    expect(pickerSource).toContain('selectable: verified.has(modelId)');
    expect(pickerSource).toContain('disabled={!option.selectable || isRunning || saving}');
    expect(pickerSource).toContain('disabled={isRunning || saving || loadingOptions}');
  });

  it('keeps setup, management, and durable-save failure affordances reachable', () => {
    expect(pickerSource).toContain('openModelsPanel()');
    expect(pickerSource).toContain('t.chatModelPickerManage');
    expect(pickerSource).toContain('setSaveError(t.capabilitySaveFailed)');
    expect(pickerSource).toContain('role="alert"');
  });
});
