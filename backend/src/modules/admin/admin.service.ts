import type { Request } from 'express';
import mongoose, { type Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../audit/audit.service.js';
import { AdminAction, PlatformSettings, type PlatformSettingsDoc } from './admin.model.js';

export interface AdminEntry {
  action: string;
  targetType?: string;
  targetId?: string;
  workspace?: { _id: Types.ObjectId; name: string } | null;
  metadata?: Record<string, unknown>;
}

/**
 * Records a Super Admin action in the platform activity log and, when it concerns one
 * workspace, in that workspace's audit log too. Never breaks the request.
 */
export async function adminLog(req: Request, entry: AdminEntry): Promise<void> {
  const { workspace, ...rest } = entry;
  try {
    await AdminAction.create({
      ...rest,
      actorUserId: req.user!._id,
      workspaceId: workspace?._id ?? null,
      workspaceName: workspace?.name ?? null,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'Failed to write admin activity');
  }
  if (workspace) await audit(req, { workspaceId: workspace._id, action: rest.action, targetType: rest.targetType, targetId: rest.targetId, metadata: rest.metadata });
}

// ---------------------------------------------------------------------------
// Platform settings (cached briefly: requireAuth reads them on every request)
// ---------------------------------------------------------------------------

let cached: { at: number; doc: PlatformSettingsDoc } | null = null;
const CACHE_MS = 10_000;

export async function platformSettings(): Promise<PlatformSettingsDoc> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.doc;
  const doc = await PlatformSettings.findOneAndUpdate({ key: 'platform' }, { $setOnInsert: { key: 'platform' } }, { upsert: true, new: true });
  cached = { at: Date.now(), doc };
  return doc;
}

/** Maintenance mode locks businesses out (login and every API call); platform admins keep working. */
export async function assertNotInMaintenance(isPlatformAdmin: boolean): Promise<void> {
  if (isPlatformAdmin) return;
  const s = await platformSettings();
  if (s.maintenanceMode) throw new AppError(503, 'MAINTENANCE', s.maintenanceMessage || 'Zeta Connect is down for maintenance. Please try again shortly.');
}

export function clearPlatformSettingsCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Whole-workspace data (export, delete)
// ---------------------------------------------------------------------------

/** Every model that stores tenant data (has a `workspaceId` path), except the workspace itself. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tenantModels(): mongoose.Model<any>[] {
  return mongoose
    .modelNames()
    .map((name) => mongoose.model(name))
    .filter((m) => m.schema.path('workspaceId') && m.modelName !== 'AdminAction');
}

/** Per-collection document counts for one workspace. */
export async function workspaceDataCounts(workspaceId: Types.ObjectId): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    tenantModels().map(async (m) => {
      out[m.modelName] = await m.countDocuments({ workspaceId }).setOptions({ skipTenantScope: true });
    }),
  );
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

const SECRET_KEY = /(token|secret|hash|password|encrypted)/i;

/** Drops credential-like fields (tokens, key hashes) from an exported document. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId)) {
    return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET_KEY.test(k)).map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

export const EXPORT_LIMIT = 20_000;

/** Everything a workspace owns, collection by collection (secrets removed, capped per collection). */
export async function exportWorkspace(workspaceId: Types.ObjectId): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const m of tenantModels()) {
    const rows = await m.find({ workspaceId }).setOptions({ skipTenantScope: true }).sort({ _id: 1 }).limit(EXPORT_LIMIT).lean();
    if (rows.length) out[m.modelName] = rows.map(redact);
  }
  return out;
}

/** Hard-deletes every document a workspace owns. Returns how many were removed per collection. */
export async function deleteWorkspaceData(workspaceId: Types.ObjectId): Promise<Record<string, number>> {
  const removed: Record<string, number> = {};
  for (const m of tenantModels()) {
    const { deletedCount } = await m.deleteMany({ workspaceId }).setOptions({ skipTenantScope: true });
    if (deletedCount) removed[m.modelName] = deletedCount;
  }
  return removed;
}
