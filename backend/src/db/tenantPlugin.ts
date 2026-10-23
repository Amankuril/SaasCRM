import { Schema, type Aggregate, type MongooseQueryMiddleware, type Query } from 'mongoose';

/**
 * Multi-tenancy safety net (the "golden rule"): every tenant-owned collection gets a
 * required, indexed `workspaceId`, and any query on it that does not filter by
 * `workspaceId` throws instead of silently reading or writing other tenants' data.
 *
 * Deliberate cross-tenant reads (e.g. "all workspaces this user belongs to", platform
 * admin views) must opt out explicitly with `.setOptions({ skipTenantScope: true })`
 * so they are easy to find in code review.
 */
declare module 'mongoose' {
  interface MongooseQueryOptions {
    skipTenantScope?: boolean;
  }
  interface AggregateOptions {
    skipTenantScope?: boolean;
  }
}

const QUERY_OPS: MongooseQueryMiddleware[] = [
  'find',
  'findOne',
  'findOneAndUpdate',
  'findOneAndDelete',
  'findOneAndReplace',
  'countDocuments',
  'deleteOne',
  'deleteMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'distinct',
];

export class TenantScopeError extends Error {
  constructor(where: string) {
    super(`Tenant scope missing: ${where} must filter by workspaceId (or opt out with skipTenantScope).`);
    this.name = 'TenantScopeError';
  }
}

/** Spread into every tenant-owned schema (declared explicitly so Mongoose infers its type). */
export const workspaceIdField = {
  type: Schema.Types.ObjectId,
  ref: 'Workspace',
  required: true,
  immutable: true,
} as const;

export function tenantScoped(schema: Schema): void {
  if (!schema.path('workspaceId')) {
    throw new Error('tenantScoped schemas must declare `workspaceId: workspaceIdField`.');
  }
  // Each model declares its own compound indexes led by workspaceId.

  schema.pre(QUERY_OPS, async function (this: Query<unknown, unknown>) {
    if (this.getOptions().skipTenantScope) return;
    if (!this.getFilter().workspaceId) {
      throw new TenantScopeError(`${this.model.modelName}.${(this as unknown as { op: string }).op}`);
    }
  });

  schema.pre('aggregate', async function (this: Aggregate<unknown>) {
    if (this.options.skipTenantScope) return;
    const first = this.pipeline()[0] as { $match?: Record<string, unknown> } | undefined;
    if (!first?.$match?.workspaceId) {
      throw new TenantScopeError('aggregate (first stage must be $match on workspaceId)');
    }
  });
}
