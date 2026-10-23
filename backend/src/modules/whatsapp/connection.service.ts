import type { Types } from 'mongoose';
import { decryptSecret, encryptSecret } from '../../lib/crypto.js';
import { AppError, conflict } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { UserDoc } from '../auth/user.model.js';
import type { WorkspaceDoc } from '../workspaces/workspace.model.js';
import { ProviderConnection, type ConnectionDoc } from './connection.model.js';
import { ProviderError, whatsappProvider, type ProviderCredentials } from './provider/index.js';

export interface ConnectInput {
  wabaId: string;
  phoneNumberId: string;
  accessToken: string;
}

export async function getConnection(workspaceId: Types.ObjectId, withToken = false): Promise<ConnectionDoc | null> {
  const query = ProviderConnection.findOne({ workspaceId });
  return withToken ? query.select('+accessTokenEncrypted') : query;
}

export function credentialsOf(conn: ConnectionDoc): ProviderCredentials {
  if (!conn.accessTokenEncrypted) throw new Error('Connection loaded without its access token');
  return { accessToken: decryptSecret(conn.accessTokenEncrypted), wabaId: conn.wabaId, phoneNumberId: conn.phoneNumberId };
}

/**
 * Validates the credentials against the provider before saving anything, then
 * subscribes our app to the business account so webhooks start flowing.
 */
export async function connectWhatsApp(workspace: WorkspaceDoc, user: UserDoc, input: ConnectInput): Promise<ConnectionDoc> {
  const provider = whatsappProvider();
  const taken = await ProviderConnection.findOne({ phoneNumberId: input.phoneNumberId }).setOptions({ skipTenantScope: true }).lean();
  if (taken && !taken.workspaceId.equals(workspace._id)) {
    throw conflict('NUMBER_IN_USE', 'This WhatsApp number is already connected to another workspace.');
  }

  let info;
  try {
    info = await provider.getPhoneNumber(input);
    await provider.subscribeApp(input);
  } catch (err) {
    throw providerToAppError(err, 'Could not verify these credentials with WhatsApp');
  }

  const conn = await ProviderConnection.findOneAndUpdate(
    { workspaceId: workspace._id },
    {
      $set: {
        provider: provider.name,
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        accessTokenEncrypted: encryptSecret(input.accessToken),
        ...info,
        status: 'connected',
        lastError: null,
        lastSyncAt: new Date(),
        connectedBy: user._id,
      },
    },
    { upsert: true, new: true },
  );

  if (workspace.status === 'setup') {
    workspace.status = 'active';
    await workspace.save();
  }
  return conn!;
}

/** Re-reads number health (quality rating, messaging tier) and confirms the token still works. */
export async function refreshConnection(conn: ConnectionDoc): Promise<ConnectionDoc> {
  try {
    const info = await whatsappProvider().getPhoneNumber(credentialsOf(conn));
    conn.set({ ...info, status: 'connected', lastError: null, lastSyncAt: new Date() });
  } catch (err) {
    if (err instanceof ProviderError && err.kind === 'auth') {
      conn.set({ status: 'error', lastError: err.message });
    } else {
      throw providerToAppError(err, 'Could not reach WhatsApp');
    }
  }
  await conn.save();
  return conn;
}

/** Called when the provider rejects our token: stop sending until the owner reconnects. */
export async function markConnectionAuthError(conn: ConnectionDoc, message: string): Promise<void> {
  logger.warn({ workspaceId: conn.workspaceId.toString() }, 'WhatsApp credentials rejected; connection paused');
  await ProviderConnection.updateOne({ _id: conn._id, workspaceId: conn.workspaceId }, { status: 'error', lastError: message });
}

export function providerToAppError(err: unknown, prefix: string): AppError {
  if (err instanceof ProviderError) {
    const status = err.kind === 'auth' ? 400 : err.retryable ? 503 : 400;
    return new AppError(status, err.kind === 'auth' ? 'PROVIDER_AUTH_FAILED' : 'PROVIDER_ERROR', `${prefix}: ${err.message}`);
  }
  return err instanceof AppError ? err : new AppError(502, 'PROVIDER_ERROR', prefix);
}
