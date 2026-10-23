import type { Request } from 'express';
import type { Types } from 'mongoose';
import { logger } from '../../lib/logger.js';
import { AuditLog } from './auditLog.model.js';

export interface AuditEntry {
  workspaceId: Types.ObjectId | string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Records a privileged change. Audit failures are logged but never break the request. */
export async function audit(req: Request, entry: AuditEntry): Promise<void> {
  try {
    await AuditLog.create({
      ...entry,
      actorUserId: req.user?._id ?? null,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    });
  } catch (err) {
    logger.error({ err, action: entry.action }, 'Failed to write audit log');
  }
}
