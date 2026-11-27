import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type AuditEntry = {
  action: string;
  actorId?: string | null;
  actorRole?: string | null;
  impersonatorId?: string | null;
  method?: string | null;
  path?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  groupId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown> | null;
  ip?: string | null;
  userAgent?: string | null;
  statusCode?: number | null;
};

export type AuditQuery = {
  actorId?: string;
  groupId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  search?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
};

const SECRET_KEY =
  /pass(word)?|otp|token|secret|api[-_]?key|subscription[-_]?key|hash|enc$|^code$|recoverycode/i;
const MAX_STRING = 500;

/** Deep copy safe for JSON storage: secrets removed, long strings cut, depth limited. */
export function scrub(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 4) return '[…]';
  if (typeof value === 'string')
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function')
    return scrub((value as { toJSON: () => unknown }).toJSON(), depth + 1);
  if (Array.isArray(value))
    return value.slice(0, 50).map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  // bigint / symbol / function
  return typeof value === 'bigint' ? value.toString() : null;
}

/** Only the fields that changed between two snapshots. */
export function diff(
  before: unknown,
  after: unknown,
): {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
} {
  const b = (scrub(before) ?? null) as Record<string, unknown> | null;
  const a = (scrub(after) ?? null) as Record<string, unknown> | null;
  if (!b || !a || typeof b !== 'object' || typeof a !== 'object')
    return { before: b, after: a };
  const ob: Record<string, unknown> = {};
  const oa: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(b), ...Object.keys(a)])) {
    if (k === 'updatedAt') continue;
    if (JSON.stringify(b[k]) !== JSON.stringify(a[k])) {
      ob[k] = b[k] ?? null;
      oa[k] = a[k] ?? null;
    }
  }
  return Object.keys(oa).length
    ? { before: ob, after: oa }
    : { before: null, after: null };
}

const json = (v: unknown) =>
  v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue);

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly names = new Map<string, { name: string; at: number }>();

  constructor(private readonly prisma: PrismaService) {}

  private async actorName(
    id: string | null | undefined,
  ): Promise<string | null> {
    if (!id) return null;
    const hit = this.names.get(id);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.name;
    const u = await this.prisma.user.findUnique({
      where: { id },
      select: { fullName: true },
    });
    if (!u) return null;
    if (this.names.size > 2000) this.names.clear();
    this.names.set(id, { name: u.fullName, at: Date.now() });
    return u.fullName;
  }

  /** Never throws: an audit failure must not break the request that caused it. */
  async record(e: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          action: e.action,
          actorId: e.actorId ?? null,
          actorName: await this.actorName(e.actorId),
          actorRole: e.actorRole ?? null,
          impersonatorId: e.impersonatorId ?? null,
          method: e.method ?? null,
          path: e.path?.slice(0, 300) ?? null,
          entityType: e.entityType ?? null,
          entityId: e.entityId ?? null,
          groupId: e.groupId ?? null,
          before: json(e.before),
          after: json(e.after),
          meta: json(e.meta ? scrub(e.meta) : null),
          ip: e.ip ?? null,
          userAgent: e.userAgent?.slice(0, 300) ?? null,
          statusCode: e.statusCode ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Could not write audit log (${e.action}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private where(q: AuditQuery): Prisma.AuditLogWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    if (q.from) createdAt.gte = new Date(q.from);
    if (q.to) {
      const t = new Date(q.to);
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.to)) t.setUTCHours(23, 59, 59, 999);
      createdAt.lte = t;
    }
    const s = q.search?.trim();
    return {
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.groupId ? { groupId: q.groupId } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.action ? { action: { startsWith: q.action } } : {}),
      ...(q.from || q.to ? { createdAt } : {}),
      ...(s
        ? {
            OR: [
              { action: { contains: s, mode: 'insensitive' } },
              { actorName: { contains: s, mode: 'insensitive' } },
              { path: { contains: s, mode: 'insensitive' } },
              { entityId: s },
              { actorId: s },
              { ip: s },
            ],
          }
        : {}),
    };
  }

  async list(q: AuditQuery) {
    const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
    const page = Math.max(1, q.page ?? 1);
    const where = this.where(q);
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    const groupIds = [
      ...new Set(rows.map((r) => r.groupId).filter(Boolean)),
    ] as string[];
    const groups = groupIds.length
      ? await this.prisma.group.findMany({
          where: { id: { in: groupIds } },
          select: { id: true, name: true },
        })
      : [];
    const gName = new Map(groups.map((g) => [g.id, g.name]));
    return {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      items: rows.map((r) => ({
        ...r,
        groupName: r.groupId ? (gName.get(r.groupId) ?? null) : null,
      })),
    };
  }

  /** Up to 10 000 rows for a CSV export. */
  async exportRows(q: AuditQuery) {
    return this.prisma.auditLog.findMany({
      where: this.where(q),
      orderBy: { createdAt: 'desc' },
      take: 10_000,
    });
  }

  /** Distinct action names (for filters). */
  async actions(groupId?: string) {
    const rows = await this.prisma.auditLog.groupBy({
      by: ['action'],
      where: groupId ? { groupId } : {},
      _count: { _all: true },
      orderBy: { action: 'asc' },
    });
    return rows.map((r) => ({ action: r.action, count: r._count._all }));
  }
}
