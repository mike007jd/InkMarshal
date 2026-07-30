import { NextResponse, type NextRequest } from 'next/server'
import {
  DESKTOP_SESSION_COOKIE,
  hasValidDesktopSessionCredential,
} from '@/lib/desktop-session-auth'

const DESKTOP_ONLY_PAGE_RE = /^\/(?:desktop-studio|novel)(?:\/|$)/
const PUBLIC_WEB_API_RE = /^\/api\/health\/?$/

function isProductionWebRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.NODE_ENV === 'production' && env.INKMARSHAL_RUNTIME !== 'desktop'
}

function desktopSessionCredentials(
  request: {
    headers: Pick<Headers, 'get'>
    cookies?: { get(name: string): { value: string } | undefined }
  },
): { header?: string; cookie?: string } {
  return {
    header: request.headers.get('x-inkmarshal-desktop-session') ?? undefined,
    cookie: request.cookies?.get(DESKTOP_SESSION_COOKIE)?.value,
  }
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
  const isServerAction = request.headers.get('next-action') !== null
  // Anything that is neither a local API nor a desktop-only page (root/assets)
  // carries no local data — leave it open.
  if (!isApi && !isDesktopPage && !isServerAction) return true

  return hasValidDesktopSessionCredential(desktopSessionCredentials(request), env)
}

export function productionWebBlockKind(
  pathname: string,
  env: Record<string, string | undefined> = process.env,
  headers?: Pick<Headers, 'get'>,
): 'api' | 'page' | null {
  if (!isProductionWebRuntime(env)) return null
  // Server Actions POST to whatever page route they were imported from
  // (including the otherwise-public root). Fail closed with the same
  // non-revealing 404 as blocked local APIs, regardless of pathname.
  if (headers?.get('next-action') != null) return 'api'
  if (DESKTOP_ONLY_PAGE_RE.test(pathname)) return 'page'
  if (pathname.startsWith('/api/') && !PUBLIC_WEB_API_RE.test(pathname)) return 'api'
  return null
}

export async function proxy(request: NextRequest) {
  const blockKind = productionWebBlockKind(
    request.nextUrl.pathname,
    process.env,
    request.headers,
  )
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
      source: '/:path*',
      has: [{ type: 'header', key: 'next-action' }],
    },
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
