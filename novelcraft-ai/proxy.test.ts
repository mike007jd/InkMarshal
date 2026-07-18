import { describe, expect, it } from 'vitest';
import {
  config,
  isDesktopRequestAuthorized,
  productionWebBlockKind,
} from './proxy';

const productionWeb = { NODE_ENV: 'production' };
const productionDesktop = {
  NODE_ENV: 'production',
  INKMARSHAL_RUNTIME: 'desktop',
};

describe('proxy production web boundary', () => {
  it('blocks desktop-only APIs and workspace pages on production web', () => {
    expect(productionWebBlockKind('/api/novels', productionWeb)).toBe('api');
    expect(productionWebBlockKind('/api/knowledge/style-extract', productionWeb)).toBe('api');
    expect(productionWebBlockKind('/novel/abc', productionWeb)).toBe('page');
    expect(productionWebBlockKind('/desktop-studio', productionWeb)).toBe('page');
  });

  it('keeps the root handoff, health probe, and desktop runtime open', () => {
    expect(productionWebBlockKind('/', productionWeb)).toBeNull();
    expect(productionWebBlockKind('/api/health', productionWeb)).toBeNull();
    expect(productionWebBlockKind('/api/health/deep', productionWeb)).toBe('api');
    expect(productionWebBlockKind('/api/novels', productionDesktop)).toBeNull();
    expect(productionWebBlockKind('/novel/abc', productionDesktop)).toBeNull();
  });

  it('does not let synthetic prefetch headers bypass API proxy controls', () => {
    const apiMatcher = config.matcher.find(entry => entry.source === '/api/:path*');

    expect(apiMatcher).toBeDefined();
    expect(apiMatcher).not.toHaveProperty('missing');
  });

  it('does not let synthetic prefetch headers bypass desktop-only page redirects', () => {
    const novelMatcher = config.matcher.find(entry => entry.source === '/novel/:path*');
    const desktopMatcher = config.matcher.find(entry => entry.source === '/desktop-studio/:path*');

    expect(novelMatcher).toBeDefined();
    expect(novelMatcher).not.toHaveProperty('missing');
    expect(desktopMatcher).toBeDefined();
    expect(desktopMatcher).not.toHaveProperty('missing');
  });

  it('requires the desktop session cookie or header before local API access', () => {
    const env = {
      NODE_ENV: 'production',
      INKMARSHAL_RUNTIME: 'desktop',
      INKMARSHAL_DESKTOP_SESSION: 'a'.repeat(64),
    };
    const nextUrl = { pathname: '/api/novels' };

    expect(isDesktopRequestAuthorized({
      nextUrl,
      headers: new Headers(),
    }, env)).toBe(false);

    expect(isDesktopRequestAuthorized({
      nextUrl,
      headers: new Headers({ 'x-inkmarshal-desktop-session': 'a'.repeat(64) }),
    }, env)).toBe(true);

    expect(isDesktopRequestAuthorized({
      nextUrl,
      headers: new Headers(),
      cookies: { get: name => (name === 'inkmarshal_desktop_session' ? { value: 'a'.repeat(64) } : undefined) },
    }, env)).toBe(true);

    expect(isDesktopRequestAuthorized({
      nextUrl,
      headers: new Headers(),
      cookies: { get: name => (name === 'inkmarshal_desktop_session' ? { value: 'b'.repeat(64) } : undefined) },
    }, env)).toBe(false);

    expect(isDesktopRequestAuthorized({
      nextUrl: { pathname: '/api/health' },
      headers: new Headers(),
    }, env)).toBe(true);
  });

});

describe('desktop session gates pages and Server Actions (AN-SEC-002)', () => {
  const TOKEN = 'c'.repeat(64);
  const env = {
    NODE_ENV: 'production',
    INKMARSHAL_RUNTIME: 'desktop',
    INKMARSHAL_DESKTOP_SESSION: TOKEN,
  };
  const sessionCookie = {
    get: (name: string) => (name === 'inkmarshal_desktop_session' ? { value: TOKEN } : undefined),
  };

  it('rejects a Server Action POST to a novel page without a session cookie', () => {
    // Server Actions POST to the page route they live on (Next-Action header),
    // NOT /api/* — this is the hole AN-SEC-002 closes.
    expect(isDesktopRequestAuthorized({
      nextUrl: { pathname: '/novel/abc' },
      headers: new Headers({ 'next-action': '7f9c0deadbeef' }),
    }, env)).toBe(false);
  });

  it('rejects a Server Action POST to desktop-studio with a wrong session cookie', () => {
    expect(isDesktopRequestAuthorized({
      nextUrl: { pathname: '/desktop-studio/settings' },
      headers: new Headers({ 'next-action': '7f9c0deadbeef' }),
      cookies: { get: () => ({ value: 'd'.repeat(64) }) },
    }, env)).toBe(false);
  });

  it('rejects a desktop page GET with neither handshake token nor cookie', () => {
    expect(isDesktopRequestAuthorized({
      nextUrl: { pathname: '/novel/abc' },
      headers: new Headers(),
    }, env)).toBe(false);
  });

  it('allows a desktop page GET once the handshake cookie is present', () => {
    expect(isDesktopRequestAuthorized({
      nextUrl: { pathname: '/novel/abc' },
      headers: new Headers(),
      cookies: sessionCookie,
    }, env)).toBe(true);
  });

  it('allows a subsequent Server Action POST carrying the session cookie', () => {
    expect(isDesktopRequestAuthorized({
      nextUrl: { pathname: '/novel/abc' },
      headers: new Headers({ 'next-action': '7f9c0deadbeef' }),
      cookies: sessionCookie,
    }, env)).toBe(true);
  });

  it('also accepts the session header on a desktop page (RSC/programmatic)', () => {
    expect(isDesktopRequestAuthorized({
      nextUrl: { pathname: '/desktop-studio' },
      headers: new Headers({ 'x-inkmarshal-desktop-session': TOKEN }),
    }, env)).toBe(true);
  });

  it('leaves non-sensitive root/assets routes open in desktop runtime', () => {
    expect(isDesktopRequestAuthorized({
      nextUrl: { pathname: '/' },
      headers: new Headers(),
    }, env)).toBe(true);
  });

  it('does not gate anything in the web/dev runtime', () => {
    expect(isDesktopRequestAuthorized({
      nextUrl: { pathname: '/novel/abc' },
      headers: new Headers(),
    }, { NODE_ENV: 'production' })).toBe(true);
  });
});
