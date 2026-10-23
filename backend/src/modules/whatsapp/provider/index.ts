import { env } from '../../../config/env.js';
import { MetaCloudProvider } from './metaCloud.js';
import { SandboxProvider } from './sandbox.js';
import type { WhatsAppProvider } from './types.js';

let provider: WhatsAppProvider | undefined;

export function whatsappProvider(): WhatsAppProvider {
  provider ??= env.WHATSAPP_PROVIDER === 'sandbox' ? new SandboxProvider() : new MetaCloudProvider();
  return provider;
}

/** Test hook: swap in a fake provider. */
export function setWhatsAppProvider(next: WhatsAppProvider | undefined): void {
  provider = next;
}

export * from './types.js';
