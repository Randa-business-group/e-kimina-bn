/** Request / response helpers shared by auth endpoints (msfts §8). */

export type ClientCtx = { ip: string | null; userAgent: string | null };

export type HttpReq = {
  ip?: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
};

export type HttpRes = {
  setHeader: (name: string, value: string | string[]) => void;
  getHeader?: (name: string) => unknown;
};

export const REFRESH_COOKIE = 'ek_rt';

const header = (req: HttpReq, name: string) => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

export function clientCtx(req: HttpReq): ClientCtx {
  return {
    ip: req.ip ?? null,
    userAgent: header(req, 'user-agent')?.slice(0, 300) ?? null,
  };
}

export function readCookie(req: HttpReq, name: string): string | null {
  const raw = header(req, 'cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function cookieAttrs(maxAgeSeconds: number): string {
  const secure =
    process.env.COOKIE_SECURE === 'true' ||
    (process.env.COOKIE_SECURE !== 'false' &&
      process.env.NODE_ENV === 'production');
  const sameSite = process.env.COOKIE_SAMESITE?.trim() || 'Lax';
  const prefix = (process.env.API_PREFIX?.trim() || 'api').replace(
    /^\/+|\/+$/g,
    '',
  );
  return [
    `Path=/${prefix}/auth`,
    'HttpOnly',
    `SameSite=${sameSite}`,
    ...(secure || sameSite.toLowerCase() === 'none' ? ['Secure'] : []),
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ].join('; ');
}

function appendSetCookie(res: HttpRes, value: string) {
  const prev = res.getHeader?.('Set-Cookie');
  const list = Array.isArray(prev)
    ? (prev as string[])
    : typeof prev === 'string'
      ? [prev]
      : [];
  res.setHeader('Set-Cookie', [...list, value]);
}

export function setRefreshCookie(
  res: HttpRes,
  token: string,
  maxAgeSeconds: number,
) {
  appendSetCookie(
    res,
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}; ${cookieAttrs(maxAgeSeconds)}`,
  );
}

export function clearRefreshCookie(res: HttpRes) {
  appendSetCookie(res, `${REFRESH_COOKIE}=; ${cookieAttrs(0)}`);
}

/** Non-browser clients (mobile, scripts) ask for the refresh token in the body. */
export function wantsTokenInBody(req: HttpReq): boolean {
  return (header(req, 'x-token-transport') ?? '').toLowerCase() === 'body';
}

/**
 * Cookie-authenticated endpoints refuse cross-site browser requests: a present Origin must be
 * one of CORS_ORIGINS (CSRF guard for refresh / logout).
 */
export function originAllowed(req: HttpReq): boolean {
  const origin = header(req, 'origin');
  if (!origin) return true;
  const allowed = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',')
        .map((o) => o.trim())
        .filter(Boolean)
    : ['http://localhost:3033', 'http://127.0.0.1:3033'];
  return allowed.includes(origin);
}
