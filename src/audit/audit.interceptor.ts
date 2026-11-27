import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../prisma/prisma.service';
import { AUDIT_ACTIONS, AUDIT_SKIP } from './audit-actions';
import { auditStorage, type AuditDetails } from './audit-context';
import { AuditService, diff, scrub } from './audit.service';
import { currentRequestId, requestContext } from '../common/observability';

type Req = {
  method: string;
  originalUrl?: string;
  url: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  params?: Record<string, string>;
  body?: unknown;
  user?: AuthenticatedUser;
  route?: { path?: string };
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const kebab = (s: string) =>
  s
    .replace(/Controller$/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();

/**
 * Writes one audit row for every successful change made through the API (and for
 * changes refused with 403). Routes listed in AUDIT_ACTIONS get a readable action name
 * and a before/after snapshot of the record they touch.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Req>();
    const rc = requestContext.getStore();
    if (rc && req.user?.id) rc.userId = req.user.id;
    const method = req.method.toUpperCase();
    const key = `${context.getClass().name}.${context.getHandler().name}`;
    if (!MUTATING.has(method) || AUDIT_SKIP.has(key)) return next.handle();

    const def = AUDIT_ACTIONS[key];
    const params = { ...(req.params ?? {}) };
    const body =
      req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const store: AuditDetails = {};
    const loader = def?.load;

    return new Observable((subscriber) => {
      void (async () => {
        const before = loader
          ? await loader(this.prisma, params, body).catch(() => null)
          : undefined;
        auditStorage.run(store, () => {
          next
            .handle()
            .pipe(
              tap({
                next: (res: unknown) => {
                  void this.write(
                    req,
                    key,
                    def,
                    params,
                    body,
                    store,
                    200,
                    res,
                    loader,
                    before,
                  );
                },
                error: (err: unknown) => {
                  const status =
                    err instanceof HttpException ? err.getStatus() : 500;
                  if (status === 403) {
                    void this.write(
                      req,
                      key,
                      def,
                      params,
                      body,
                      store,
                      status,
                      null,
                      undefined,
                      undefined,
                    );
                  }
                },
              }),
            )
            .subscribe(subscriber);
        });
      })();
    });
  }

  private async write(
    req: Req,
    key: string,
    def: (typeof AUDIT_ACTIONS)[string] | undefined,
    params: Record<string, string>,
    body: Record<string, unknown>,
    store: AuditDetails,
    status: number,
    res: unknown,
    loader: (typeof AUDIT_ACTIONS)[string]['load'],
    before: unknown,
  ) {
    if (store.skip) return;
    const [cls, handler] = key.split('.');
    let action = store.action ?? def?.action ?? `${kebab(cls)}.${handler}`;
    if (status === 403) action = `${action}.denied`;

    let snap: {
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    } = {
      before: null,
      after: null,
    };
    if (store.before !== undefined || store.after !== undefined) {
      snap = diff(store.before ?? null, store.after ?? null);
    } else if (loader && status < 400) {
      const after = await loader(this.prisma, params, body).catch(() => null);
      snap = diff(before ?? null, after);
    }

    const resObj =
      res && typeof res === 'object' ? (res as Record<string, unknown>) : null;
    const resUser =
      resObj?.user && typeof resObj.user === 'object'
        ? (resObj.user as { id?: string; platformRole?: string })
        : null;
    const groupId =
      store.groupId ??
      params.groupId ??
      (cls === 'GroupsController' &&
      handler === 'create' &&
      typeof resObj?.id === 'string'
        ? resObj.id
        : undefined);
    const idParam =
      def?.idParam ??
      Object.keys(params)
        .filter((k) => k !== 'groupId')
        .pop();
    const entityId =
      store.entityId ??
      (idParam ? params[idParam] : undefined) ??
      (typeof resObj?.id === 'string' ? resObj.id : undefined) ??
      (def?.entityType === 'Group' ? groupId : undefined) ??
      resUser?.id;

    const ua = req.headers['user-agent'];
    await this.audit.record({
      action,
      actorId: req.user?.id ?? resUser?.id ?? null,
      actorRole: req.user?.platformRole ?? resUser?.platformRole ?? null,
      impersonatorId: req.user?.impersonatorId ?? null,
      method: req.method,
      path: req.originalUrl ?? req.url,
      entityType: store.entityType ?? def?.entityType ?? null,
      entityId: entityId ?? null,
      groupId: groupId ?? null,
      before: snap.before,
      after: snap.after,
      meta: {
        ...(Object.keys(params).length ? { params } : {}),
        ...(Object.keys(body).length ? { body: scrub(body) } : {}),
        ...(store.meta ?? {}),
        ...(currentRequestId() ? { requestId: currentRequestId() } : {}),
      },
      ip: req.ip ?? null,
      userAgent: Array.isArray(ua) ? ua[0] : (ua ?? null),
      statusCode: status,
    });
  }
}
