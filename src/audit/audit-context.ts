import { AsyncLocalStorage } from 'node:async_hooks';

export type AuditDetails = {
  action?: string;
  entityType?: string;
  entityId?: string;
  groupId?: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
  /** Set when the request should not be logged (e.g. nothing changed). */
  skip?: boolean;
};

export const auditStorage = new AsyncLocalStorage<AuditDetails>();

/**
 * Add details to the audit row of the current request (service code may call this;
 * outside a request it is a no-op).
 */
export function auditNote(details: AuditDetails): void {
  const store = auditStorage.getStore();
  if (!store) return;
  const { meta, ...rest } = details;
  Object.assign(store, rest);
  if (meta) store.meta = { ...(store.meta ?? {}), ...meta };
}
