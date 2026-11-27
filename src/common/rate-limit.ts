import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';

/**
 * In-memory rate limiting (msfts §8; no @nestjs/throttler available offline).
 * Fixed windows per key. One API instance: for several instances put a shared store
 * (Redis) behind `RateLimitStore`.
 */
export type RateLimitRule = {
  name: string;
  limit: number;
  windowSeconds: number;
  /** ip | user | ip+body (IP plus a body field such as the email or phone). */
  by: 'ip' | 'user' | 'ip+body';
  bodyKey?: string | string[];
  /** Only failed requests count (sign-in, code checks): normal use is never blocked. */
  failuresOnly?: boolean;
};

export const RATE_LIMIT_KEY = 'rateLimit';
export const RateLimit = (rule: RateLimitRule) =>
  SetMetadata(RATE_LIMIT_KEY, rule);

type Bucket = { count: number; resetAt: number };

@Injectable()
export class RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private sweepAt = 0;

  private sweep(now: number) {
    if (now < this.sweepAt) return;
    this.sweepAt = now + 60_000;
    for (const [k, b] of this.buckets)
      if (b.resetAt <= now) this.buckets.delete(k);
  }

  /** Current bucket (created on demand). */
  get(key: string, windowMs: number): Bucket {
    const now = Date.now();
    this.sweep(now);
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    return b;
  }

  release(key: string) {
    const b = this.buckets.get(key);
    if (b && b.count > 0) b.count--;
  }

  reset() {
    this.buckets.clear();
  }
}

type Req = {
  ip?: string;
  method: string;
  body?: Record<string, unknown>;
  user?: { id: string };
  route?: { path?: string };
  originalUrl?: string;
  url: string;
};
type Res = { setHeader: (k: string, v: string) => void };

const envInt = (k: string, d: number) => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? n : d;
};

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly store: RateLimitStore,
  ) {}

  private hit(res: Res, key: string, limit: number, windowSeconds: number) {
    const b = this.store.get(key, windowSeconds * 1000);
    if (b.count >= limit) {
      const retry = Math.max(1, Math.ceil((b.resetAt - Date.now()) / 1000));
      res.setHeader('Retry-After', String(retry));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: `Too many attempts. Try again in ${retry >= 60 ? `${Math.ceil(retry / 60)} minutes` : `${retry} seconds`}.`,
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    b.count++;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (
      context.getType() !== 'http' ||
      process.env.RATE_LIMIT_DISABLED === 'true'
    ) {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<Req>();
    const res = context.switchToHttp().getResponse<Res>();
    const ip = req.ip ?? 'unknown';

    // Global ceiling per IP.
    this.hit(res, `global:${ip}`, envInt('RATE_LIMIT_PER_MINUTE', 600), 60);

    const rule = this.reflector.get<RateLimitRule | undefined>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!rule) return next.handle();
    let subject = ip;
    if (rule.by === 'user') subject = req.user?.id ?? ip;
    if (rule.by === 'ip+body') {
      const keys = Array.isArray(rule.bodyKey)
        ? rule.bodyKey
        : [rule.bodyKey ?? 'email'];
      const v = keys
        .map((k) => req.body?.[k])
        .find((x) => typeof x === 'string' && x.trim());
      subject = `${ip}|${(typeof v === 'string' ? v : '')
        .trim()
        .toLowerCase()
        .replace(/\s/g, '')}`;
    }
    const key = `${rule.name}:${subject}`;
    this.hit(res, key, rule.limit, rule.windowSeconds);
    if (!rule.failuresOnly) return next.handle();
    return next.handle().pipe(tap({ next: () => this.store.release(key) }));
  }
}

/** Security headers (helmet-like) for every API response. */
export function securityHeaders(
  req: { originalUrl?: string; url: string },
  res: {
    setHeader: (k: string, v: string) => void;
    removeHeader: (k: string) => void;
  },
  next: () => void,
) {
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=()',
  );
  res.setHeader('Origin-Agent-Cluster', '?1');
  if (process.env.NODE_ENV === 'production' || process.env.HSTS === 'true') {
    res.setHeader(
      'Strict-Transport-Security',
      'max-age=31536000; includeSubDomains',
    );
  }
  // JSON API: nothing to render. Swagger UI needs its own scripts and styles.
  const url = req.originalUrl ?? req.url;
  if (!/\/docs(\/|$|-json)/.test(url)) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  }
  next();
}
