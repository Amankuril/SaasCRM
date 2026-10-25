/**
 * Meta Embedded Signup ("Connect WhatsApp with Facebook") in the browser.
 * The popup reports the chosen WhatsApp account and number through a window
 * message, and the FB.login callback carries a short-lived (30s) code that the
 * server exchanges for the business's token.
 */

interface FacebookSdk {
  init(options: { appId: string; autoLogAppEvents?: boolean; xfbml?: boolean; version: string }): void;
  login(
    callback: (response: { authResponse?: { code?: string } | null; status?: string }) => void,
    options: { config_id: string; response_type: 'code'; override_default_response_type: boolean; extras: Record<string, unknown> },
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

let sdk: Promise<FacebookSdk> | null = null;

export function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  sdk ??= new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(window.FB!);
    };
    const script = document.createElement('script');
    script.src = 'https://connect.facebook.net/en_US/sdk.js';
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      sdk = null;
      reject(new Error('Could not load Facebook. Check your connection or ad blocker and try again.'));
    };
    document.body.appendChild(script);
  });
  return sdk;
}

export interface SignupResult {
  code: string;
  wabaId: string;
  phoneNumberId: string;
}

export class SignupCancelled extends Error {}

/** Opens the Embedded Signup popup and resolves once both the code and the chosen number are known. */
export async function launchEmbeddedSignup(opts: { appId: string; configId: string; version: string }): Promise<SignupResult> {
  const FB = await loadFacebookSdk(opts.appId, opts.version);

  return new Promise<SignupResult>((resolve, reject) => {
    let code: string | null = null;
    let ids: { wabaId: string; phoneNumberId: string } | null = null;

    const done = (fn: () => void) => {
      window.removeEventListener('message', onMessage);
      fn();
    };
    const maybeResolve = () => {
      if (code && ids) done(() => resolve({ code: code!, ...ids! }));
    };

    function onMessage(event: MessageEvent) {
      if (!event.origin.endsWith('facebook.com')) return;
      let data: { type?: string; event?: string; data?: Record<string, string> };
      try {
        data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        return;
      }
      if (data?.type !== 'WA_EMBEDDED_SIGNUP') return;
      if (data.event?.startsWith('FINISH')) {
        if (!data.data?.phone_number_id || !data.data?.waba_id) {
          done(() => reject(new Error('Facebook did not return a phone number. Make sure you add or choose a number during signup.')));
          return;
        }
        ids = { wabaId: data.data.waba_id, phoneNumberId: data.data.phone_number_id };
        maybeResolve();
      } else if (data.event === 'CANCEL') {
        done(() => reject(data.data?.error_message ? new Error(data.data.error_message) : new SignupCancelled('Signup was closed before finishing.')));
      } else if (data.event === 'ERROR') {
        done(() => reject(new Error(data.data?.error_message ?? 'Facebook reported an error during signup.')));
      }
    }
    window.addEventListener('message', onMessage);

    FB.login(
      (response) => {
        const c = response.authResponse?.code;
        if (!c) {
          done(() => reject(new SignupCancelled('Signup was closed before finishing.')));
          return;
        }
        code = c;
        maybeResolve();
      },
      { config_id: opts.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {} } },
    );
  });
}
