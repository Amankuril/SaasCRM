import { afterEach, describe, expect, it, vi } from 'vitest';
import { MetaCloudProvider } from '../src/modules/whatsapp/provider/metaCloud.js';
import { ProviderError } from '../src/modules/whatsapp/provider/types.js';

const creds = { accessToken: 'tok', wabaId: '111', phoneNumberId: '222' };

function mockFetch(status: number, body: unknown) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('MetaCloudProvider', () => {
  it('sends templates in the Cloud API shape with a bearer token', async () => {
    const fetch = mockFetch(200, { messages: [{ id: 'wamid.ABC' }] });
    const res = await new MetaCloudProvider().sendMessage(creds, {
      type: 'template',
      to: '+919811112222',
      template: { name: 'appointment_reminder', language: 'en', headerParams: ['Priya'], bodyParams: ['Mon', '10:30'] },
    });

    expect(res.providerMessageId).toBe('wamid.ABC');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/222\/messages$/);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919811112222',
      type: 'template',
      template: {
        name: 'appointment_reminder',
        language: { code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'text', text: 'Priya' }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Mon' }, { type: 'text', text: '10:30' }] },
        ],
      },
    });
  });

  it('sends reply buttons and CTA URL buttons as interactive messages', async () => {
    const fetch = mockFetch(200, { messages: [{ id: 'wamid.X' }] });
    const provider = new MetaCloudProvider();
    await provider.sendMessage(creds, { type: 'buttons', to: '+911', body: 'Visited?', footer: 'Clinic', buttons: [{ id: 'yes', title: 'Yes' }] });
    await provider.sendMessage(creds, { type: 'cta_url', to: '+911', body: 'Review us', header: 'Thanks!', buttonText: 'Open', url: 'https://g.page/x' });
    const bodies = fetch.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0].interactive).toEqual({
      type: 'button',
      body: { text: 'Visited?' },
      footer: { text: 'Clinic' },
      action: { buttons: [{ type: 'reply', reply: { id: 'yes', title: 'Yes' } }] },
    });
    expect(bodies[1].interactive).toEqual({
      type: 'cta_url',
      header: { type: 'text', text: 'Thanks!' },
      body: { text: 'Review us' },
      action: { name: 'cta_url', parameters: { display_text: 'Open', url: 'https://g.page/x' } },
    });
  });

  it.each([
    [401, 190, 'auth'],
    [400, 131056, 'rate_limit'],
    [500, 1, 'transient'],
    [400, 131026, 'permanent'],
    [400, 132001, 'permanent'],
  ])('classifies HTTP %i / code %i as %s', async (status, code, kind) => {
    mockFetch(status, { error: { message: 'boom', code, error_data: { details: 'more detail' } } });
    const err = await new MetaCloudProvider().sendMessage(creds, { type: 'text', to: '1', text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind, code: String(code), message: 'more detail' });
  });

  it('treats network failures as transient', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('fetch failed'))));
    const err = await new MetaCloudProvider().getPhoneNumber(creds).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'transient' });
  });
});
