// Single source of truth for the local user in a no-account desktop app.
//
// Pure constant with ZERO imports — safe to import from both server-side
// (lib/local-auth.ts, API routes) and client-side code without pulling any
// server-only module into the client bundle.
//
// There is no authentication in this product. Every request is made by the
// single fixed local user defined here.
//
// CROSS-TASK CONTRACT: `id` is the locked literal `'local-user'`. Local SQLite
// rows use it; B.* depends on it. Do NOT change the id or email.

export interface LocalUser {
  id: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export const LOCAL_USER_ID = 'local-user';
export const LOCAL_USER_EMAIL = 'local@inkmarshal';

export const LOCAL_USER: LocalUser = {
  id: LOCAL_USER_ID,
  email: LOCAL_USER_EMAIL,
  created_at: '1970-01-01T00:00:00.000Z',
  updated_at: '1970-01-01T00:00:00.000Z',
};
