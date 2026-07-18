import { NextResponse, type NextRequest } from 'next/server'

const DESKTOP_SESSION_ENV = 'INKMARSHAL_DESKTOP_SESSION'
const DESKTOP_SESSION_COOKIE = 'inkmarshal_desktop_session'

const DESKTOP_ONLY_PAGE_RE = /^\/(?:desktop-studio|novel)(?:\/|$)/
const PUBLIC_WEB_API_RE = /^\/api\/health\/?$/

function isProductionWebRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'production' && env.INKMARSHAL_RUNTIME !== 'desktop'
}

function desktopSessionToken(env: Record<string, string | undefined> = process.env): string | null {
  if (env.INKMARSHAL_RUNTIME !== 'desktop') return null
  const token = env[DESKTOP_SESSION_ENV]?.trim()
  return token && token.length >= 32 ? token : null
}

function timingSafeEqualString(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < b.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

function hasValidDesktopSession(
  request: {
    headers: Pick<Headers, 'get'>
    cookies?: { get(name: string): { value: string } | undefined }
  },
  expected: string,
): boolean {
  const header = request.headers.get('x-inkmarshal-desktop-session')?.trim()
  const cookie = request.cookies?.get(DESKTOP_SESSION_COOKIE)?.value?.trim()
  return timingSafeEqualString(header, expected) || timingSafeEqualString(cookie, expected)
}

/**
 * Desktop-runtime authorization for *every* sensitive local request — not just
 * `/api/*` (AN-SEC-002). The bundled Node server listens on a fixed loopback
 * port any local process can reach, so the session token must gate the
 * desktop-only pages (`/novel/*`, `/desktop-studio/*`) too: their GET shells,
 * RSC payloads, and — crucially — Server Action POSTs, which target the page
 * route (with a `Next-Action` header), NOT `/api/*`. Previously this returned
 * `true` for anything outside `/api/`, so a local client could drive the
 * mutating Server Actions (create/update/delete conversation, knowledge, vault)
 * without ever presenting the token. Tauri installs the httpOnly cookie in the
 * native WebView cookie store before navigation, so the token never appears in
 * the URL and the cookie rides every page/RSC/Action request from the first GET.
 *
 * Returns false → the proxy responds 404 (matching the existing local-API
 * rejection: never reveal that the route exists).
 */
export function isDesktopRequestAuthorized(
  request: {
    nextUrl: { pathname: string }
    headers: Pick<Headers, 'get'>
    cookies?: { get(name: string): { value: string } | undefined }
  },
  env: Record<string, string | undefined> = process.env,
): boolean {
  // Web/dev runtimes aren't gated here (the web wall lives in
  // productionWebBlockKind; dev has no token).
  if (env.INKMARSHAL_RUNTIME !== 'desktop') return true

  const { pathname } = request.nextUrl
  // Liveness + Rust readiness probe must stay reachable (the probe authenticates
  // separately by echoing the token; see app/api/health/route.ts).
  if (pathname === '/api/health') return true

  const isApi = pathname.startsWith('/api/')
  const isDesktopPage = DESKTOP_ONLY_PAGE_RE.test(pathname)
  // Anything that is neither a local API nor a desktop-only page (root/assets)
  // carries no local data — leave it open.
  if (!isApi && !isDesktopPage) return true

  const expected = desktopSessionToken(env)
  if (!expected) return false
  return hasValidDesktopSession(request, expected)
}

export function productionWebBlockKind(
  pathname: string,
  env: Record<string, string | undefined> = process.env,
): 'api' | 'page' | null {
  if (!isProductionWebRuntime(env)) return null
  if (DESKTOP_ONLY_PAGE_RE.test(pathname)) return 'page'
  if (pathname.startsWith('/api/') && !PUBLIC_WEB_API_RE.test(pathname)) return 'api'
  return null
}

export async function proxy(request: NextRequest) {
  const blockKind = productionWebBlockKind(request.nextUrl.pathname)
  if (blockKind === 'api') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }
  if (blockKind === 'page') {
    return NextResponse.redirect('https://www.inkmarshal.com/download')
  }

  if (!isDesktopRequestAuthorized(request)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    {
      source: '/api/:path*',
    },
    {
      source: '/novel/:path*',
    },
    {
      source: '/desktop-studio/:path*',
    },
  ],
}
