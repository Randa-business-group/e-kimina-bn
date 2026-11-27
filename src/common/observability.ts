import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { ConsoleLogger, LogLevel } from '@nestjs/common';

/**
 * Observability (msfts §10): request ids carried through async code, structured JSON logs,
 * access logs and error reporting (Sentry wire protocol, no SDK needed).
 */

export type RequestContext = {
  requestId: string;
  userId?: string;
  method?: string;
  path?: string;
};
export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentRequestId = () => requestContext.getStore()?.requestId;

type Req = {
  method: string;
  originalUrl?: string;
  url: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  user?: { id: string };
};
type Res = {
  statusCode: number;
  setHeader: (k: string, v: string) => void;
  on: (e: 'finish', cb: () => void) => void;
};

const header = (req: Req, k: string) => {
  const v = req.headers[k];
  return Array.isArray(v) ? v[0] : v;
};

/** Express middleware: request id (incoming `X-Request-Id` or new), context, access log. */
export function requestContextMiddleware(logger: AppLogger) {
  return (req: Req, res: Res, next: () => void) => {
    const incoming = header(req, 'x-request-id');
    const requestId =
      incoming && /^[\w.-]{6,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    const started = process.hrtime.bigint();
    const path = (req.originalUrl ?? req.url).split('?')[0];
    const ctx: RequestContext = { requestId, method: req.method, path };
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (path.endsWith('/health/live')) return;
      logger.access({
        requestId,
        method: req.method,
        path,
        status: res.statusCode,
        ms: Math.round(ms * 10) / 10,
        userId: req.user?.id ?? ctx.userId,
        ip: req.ip,
      });
    });
    requestContext.run(ctx, next);
  };
}

/**
 * Nest logger. LOG_FORMAT=json (default in production) prints one JSON object per line with
 * the request id; otherwise Nest's coloured console format with `[req:…]`.
 */
export class AppLogger extends ConsoleLogger {
  private readonly json =
    (process.env.LOG_FORMAT ??
      (process.env.NODE_ENV === 'production' ? 'json' : 'pretty')) === 'json';

  constructor() {
    super();
    const level = (process.env.LOG_LEVEL ?? 'log') as LogLevel;
    const order: LogLevel[] = [
      'verbose',
      'debug',
      'log',
      'warn',
      'error',
      'fatal',
    ];
    const i = Math.max(0, order.indexOf(level));
    this.setLogLevels(order.slice(i));
  }

  private emit(
    level: string,
    message: unknown,
    context?: string,
    extra?: Record<string, unknown>,
  ) {
    const line = {
      time: new Date().toISOString(),
      level,
      context: context ?? this.context,
      msg: typeof message === 'string' ? message : JSON.stringify(message),
      requestId: currentRequestId(),
      ...extra,
    };
    (level === 'error' || level === 'fatal'
      ? process.stderr
      : process.stdout
    ).write(`${JSON.stringify(line)}\n`);
  }

  private split(params: unknown[]): { context?: string; stack?: string } {
    const last = params[params.length - 1];
    const context =
      typeof last === 'string' && params.length > 0 ? last : undefined;
    const stack =
      params.length > 1 && typeof params[0] === 'string'
        ? params[0]
        : undefined;
    return { context, stack };
  }

  log(message: unknown, ...params: unknown[]) {
    if (!this.isLevelEnabled('log')) return;
    if (!this.json)
      return super.log(this.tag(message), ...(params as [string]));
    this.emit('info', message, this.split(params).context);
  }

  warn(message: unknown, ...params: unknown[]) {
    if (!this.isLevelEnabled('warn')) return;
    if (!this.json)
      return super.warn(this.tag(message), ...(params as [string]));
    this.emit('warn', message, this.split(params).context);
  }

  debug(message: unknown, ...params: unknown[]) {
    if (!this.isLevelEnabled('debug')) return;
    if (!this.json)
      return super.debug(this.tag(message), ...(params as [string]));
    this.emit('debug', message, this.split(params).context);
  }

  verbose(message: unknown, ...params: unknown[]) {
    if (!this.isLevelEnabled('verbose')) return;
    if (!this.json)
      return super.verbose(this.tag(message), ...(params as [string]));
    this.emit('verbose', message, this.split(params).context);
  }

  error(message: unknown, ...params: unknown[]) {
    if (!this.isLevelEnabled('error')) return;
    if (!this.json)
      return super.error(this.tag(message), ...(params as [string]));
    const { context, stack } = this.split(params);
    this.emit('error', message, context, stack ? { stack } : undefined);
  }

  /** One line per HTTP request. */
  access(fields: Record<string, unknown>) {
    if (process.env.ACCESS_LOG === 'false') return;
    if (this.json) {
      this.emit('info', 'request', 'HTTP', fields);
      return;
    }
    super.log(
      `${String(fields.method)} ${String(fields.path)} ${String(fields.status)} ${String(fields.ms)}ms [req:${String(fields.requestId).slice(0, 8)}]`,
      'HTTP',
    );
  }

  private tag(message: unknown) {
    const id = currentRequestId();
    return id && typeof message === 'string'
      ? `${message} [req:${id.slice(0, 8)}]`
      : message;
  }
}

// ── error reporting ───────────────────────────────────────────────────────

type Frame = {
  function?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
};

function frames(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const out: Frame[] = [];
  for (const line of stack.split('\n').slice(1)) {
    const m = /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line.trim());
    if (!m) continue;
    out.push({
      function: m[1] ?? '<anonymous>',
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !m[2].includes('node_modules') && !m[2].startsWith('node:'),
    });
  }
  return out.reverse(); // Sentry wants the oldest call first
}

/**
 * Sends errors to Sentry (or any Sentry-compatible service such as GlitchTip) when SENTRY_DSN
 * is set, using the envelope HTTP API. Never throws.
 */
export class ErrorReporter {
  private static parsed: { url: string; key: string } | null | undefined;

  private static target() {
    if (this.parsed !== undefined) return this.parsed;
    const dsn = process.env.SENTRY_DSN?.trim();
    if (!dsn) return (this.parsed = null);
    try {
      const u = new URL(dsn);
      const project = u.pathname.replace(/^\/+/, '');
      this.parsed = {
        url: `${u.protocol}//${u.host}/api/${project}/envelope/`,
        key: u.username,
      };
    } catch {
      this.parsed = null;
    }
    return this.parsed;
  }

  static get enabled() {
    return this.target() != null;
  }

  static buildEvent(
    error: unknown,
    extra: {
      requestId?: string;
      userId?: string;
      method?: string;
      path?: string;
    } = {},
  ) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      event_id: randomUUID().replace(/-/g, ''),
      timestamp: Date.now() / 1000,
      platform: 'node',
      level: 'error',
      environment: process.env.NODE_ENV ?? 'development',
      release: process.env.APP_VERSION ?? process.env.npm_package_version,
      server_name: process.env.HOSTNAME,
      exception: {
        values: [
          {
            type: err.name,
            value: err.message,
            stacktrace: { frames: frames(err.stack) },
          },
        ],
      },
      tags: { requestId: extra.requestId },
      request: extra.method
        ? { method: extra.method, url: extra.path }
        : undefined,
      user: extra.userId ? { id: extra.userId } : undefined,
    };
  }

  static capture(
    error: unknown,
    extra: {
      requestId?: string;
      userId?: string;
      method?: string;
      path?: string;
    } = {},
  ) {
    const t = this.target();
    if (!t) return;
    const event = this.buildEvent(error, extra);
    const body = [
      JSON.stringify({
        event_id: event.event_id,
        sent_at: new Date().toISOString(),
      }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify(event),
    ].join('\n');
    void fetch(t.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_key=${t.key}, sentry_client=ekimina-api/1.0`,
      },
      body,
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  }
}
