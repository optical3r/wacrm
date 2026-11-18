// Browser-safe: imported by the login page and the middleware.

/**
 * Where /login may send someone after they sign in: only back to the
 * consent screen. Anything else is dropped, so the login page can't be
 * used as an open redirect.
 */
export function safeOAuthNext(next: string | null | undefined): string | null {
  if (!next) return null;
  if (next === '/oauth/authorize' || next.startsWith('/oauth/authorize?')) return next;
  return null;
}
