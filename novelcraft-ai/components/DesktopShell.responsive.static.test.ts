import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('DesktopShell responsive shell boundary', () => {
  const shell = readFileSync(
    join(process.cwd(), 'components/DesktopShellLayout.tsx'),
    'utf8',
  );

  it('switches the drawer/scrim boundary to lg (1024px), never xl (1280px)', () => {
    expect(shell).not.toContain('xl:');
    expect(shell).not.toContain('1279px');
  });

  it('keeps the dimming scrim narrow-only', () => {
    expect(shell).toContain('bg-book-ink-primary/30 lg:hidden');
  });

  it('makes the sidebar persistent and collapsible in-flow at lg and above', () => {
    expect(shell).toContain('lg:static lg:translate-x-0 lg:transition-none');
    expect(shell).toContain('lg:shadow-none');
    expect(shell).toContain('lg:visible');
    expect(shell).toContain("sidebarOpen ? 'lg:flex' : 'lg:hidden'");
  });

  it('keeps the narrow header with the drawer toggle hidden at lg and above', () => {
    expect(shell).toContain('px-3 lg:hidden');
  });

  it('toggles the drawer (not the desktop sidebar collapse) below 1024px', () => {
    expect(shell).toContain("window.matchMedia('(max-width: 1023px)').matches");
  });

  it('gives the controlled drawer a stable id for aria-controls', () => {
    expect(shell).toContain("const NARROW_DRAWER_ID = 'inkmarshal-narrow-drawer';");
    expect(shell).toContain('id={NARROW_DRAWER_ID}');
  });

  it('exposes the narrow-header open control only while the drawer is closed', () => {
    // The open drawer is a fixed z-40 overlay that covers this header, so an
    // always-rendered toggle here can never be clicked a second time.
    expect(shell).toContain('{!mobileNavOpen && (');
    expect(shell).toContain('onClick={() => setMobileNavOpen(true)}');
    expect(shell).toContain('aria-expanded={false}');
    expect(shell).toContain('aria-controls={NARROW_DRAWER_ID}');
    expect(shell).not.toContain('onClick={() => setMobileNavOpen(prev => !prev)}');
  });

  it('renders a visible close control inside the open drawer layer', () => {
    expect(shell).toContain('{mobileNavOpen && (');
    expect(shell).toContain('ref={mobileNavCloseButtonRef}');
    expect(shell).toContain('restoreMobileNavFocusRef.current = true;');
    expect(shell).toContain('aria-expanded={true}');
    expect(shell).toContain('aria-label={t.toggleSidebar}');
  });

  it('hands focus between the mutually exclusive controls and supports Escape', () => {
    expect(shell).toContain('ref={mobileNavOpenButtonRef}');
    expect(shell).toContain('mobileNavCloseButtonRef.current?.focus()');
    expect(shell).toContain('mobileNavOpenButtonRef.current?.focus()');
    expect(shell).toContain("if (event.defaultPrevented || event.key !== 'Escape') return");
  });

  it('restores focus for every non-navigation close path', () => {
    expect(shell).toContain('const closeMobileNavigation = useCallback(() => {');
    expect(shell).toContain('const toggleMobileNavigation = useCallback(() => {');
    expect(shell).toContain('onClick={closeMobileNavigation}');
    expect(shell).toContain('toggleMobileNavigation();');
    expect(shell).toContain('closeMobileNavigation();');
  });

  it('gives the controlled Settings sheet an explicit return-focus target', () => {
    const settings = readFileSync(
      join(process.cwd(), 'components/SettingsPanel.tsx'),
      'utf8',
    );
    const focusUtils = readFileSync(
      join(process.cwd(), 'components/ui/focus-utils.ts'),
      'utf8',
    );
    expect(shell).toContain('settingsReturnFocusRef.current = event.currentTarget;');
    expect(shell).toContain('if (showSettings) return;');
    expect(shell).toContain('fallbackFocusRef={mobileNavOpenButtonRef}');
    expect(shell).toContain('returnFocusRef={settingsReturnFocusRef}');
    expect(settings).toContain('onCloseAutoFocus={event => {');
    expect(settings).toContain("import { isUsableReturnFocusTarget } from '@/components/ui/focus-utils'");
    expect(focusUtils).toContain('target === document.body');
    expect(focusUtils).toContain("target.closest('[data-slot=\"sheet-content\"]')");
    expect(settings).toContain('returnFocusRef.current = null;');
    expect(settings).toContain('focusTarget.focus({ preventScroll: true });');
  });
});
