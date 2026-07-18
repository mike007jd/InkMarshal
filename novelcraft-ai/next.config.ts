import type { NextConfig } from 'next';
import path from 'node:path';

const repoRoot = path.resolve(process.cwd(), '..');

const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const privateNoStoreHeaders = [
  { key: 'Cache-Control', value: 'private, no-store, max-age=0, must-revalidate' },
];

const devScriptSrc = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
const desktopCsp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${devScriptSrc}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' ipc: http://ipc.localhost http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:* https://huggingface.co https://*.hf.co",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const desktopCspHeaders = [{ key: 'Content-Security-Policy', value: desktopCsp }];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['better-sqlite3'],
  typescript: { ignoreBuildErrors: false },
  devIndicators: { position: 'bottom-right' },
  transpilePackages: ['motion'],
  outputFileTracingRoot: repoRoot,
  turbopack: { root: repoRoot },
  async headers() {
    return [
      { source: '/(.*)', headers: securityHeaders },
      { source: '/', headers: privateNoStoreHeaders },
      { source: '/api/:path*', headers: privateNoStoreHeaders },
      { source: '/novel/:path*', headers: [...privateNoStoreHeaders, ...desktopCspHeaders] },
      { source: '/desktop-studio', headers: [...privateNoStoreHeaders, ...desktopCspHeaders] },
      { source: '/desktop-studio/:path*', headers: [...privateNoStoreHeaders, ...desktopCspHeaders] },
    ];
  },
};

const useDesktopStandalone = process.env.TAURI_DESKTOP_BUILD === '1';

const exportedConfig = {
  ...nextConfig,
  ...(useDesktopStandalone ? { output: 'standalone' as const } : {}),
};

export default exportedConfig;
