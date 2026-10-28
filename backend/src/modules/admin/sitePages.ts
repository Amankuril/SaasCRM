import { Router } from 'express';
import { z } from 'zod';
import { notFound } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { SITE_PAGE_SLUGS, SitePage, type SitePageDoc, type SitePageSlug } from './admin.model.js';
import { adminLog } from './admin.service.js';

/**
 * Starter text, inserted the first time a page is read. It is a generic template:
 * the platform owner should review it (ideally with a lawyer) and edit it in the panel.
 */
const DEFAULTS: Record<SitePageSlug, { title: string; content: string }> = {
  privacy: {
    title: 'Privacy Policy',
    content: `This policy explains what information Zeta Connect collects when businesses use our WhatsApp platform, and how we use and protect it.

## Information we collect

- **Account details:** your name, email address and password (stored only as a secure hash).
- **Business details:** business name, country, timezone and billing information.
- **Customer data you upload:** contacts, conversations, templates and other content your team adds. You stay the owner of this data; we process it only to provide the service.
- **Usage data:** log-ins, device and IP information, used to keep accounts secure.

## How we use information

- To run the platform: sending and receiving WhatsApp messages, automations, reports and billing.
- To keep accounts secure: email login codes, detecting suspicious activity.
- To contact you about your account, billing or important service changes.

We do not sell your data or your customers' data.

## Sharing

We share data only with providers needed to run the service (for example Meta for WhatsApp messaging, our payment provider and our hosting provider), or when required by law.

## Retention and deletion

Your data is kept while your account is active. You can export it at any time, and ask us to delete your account and data by contacting support.

## Contact

Questions about this policy? See our [Support](/support) page.`,
  },
  terms: {
    title: 'Terms of Service',
    content: `These terms apply to every business that uses Zeta Connect. By creating an account you agree to them.

## Your account

- You are responsible for your account, your team members and everything sent from your workspace.
- Keep your login details private. Tell us immediately if you suspect unauthorised access.

## Acceptable use

- Follow the WhatsApp Business and Commerce policies of Meta.
- Only message people who have agreed to hear from you, and honour opt-out requests.
- Do not send spam, illegal, misleading or harmful content.

We may suspend workspaces that break these rules or put the platform at risk.

## Plans and payments

- Paid plans are billed in advance for each billing period. WhatsApp conversation fees are charged by Meta directly to your Meta account.
- If a payment fails, you keep full access for a short grace period; after that sending is paused until the payment is made.
- You can cancel at any time; access continues until the end of the period you paid for.

## Availability

We work hard to keep Zeta Connect running, but the service is provided "as is" and may occasionally be unavailable for maintenance or reasons outside our control (including Meta outages).

## Changes

We may update these terms. Significant changes will be announced in the app before they take effect.

## Contact

See our [Support](/support) page.`,
  },
  support: {
    title: 'Support',
    content: `We're here to help with setup, WhatsApp connection, billing and anything else.

## Before you write

- **Messages not sending?** Check that your WhatsApp number shows *Connected* and that your plan is active.
- **Template rejected?** Meta reviews every template; edit the wording and submit again.
- **Billing question?** Include your business name and the invoice number.

When you contact us, please include your business name and the email you sign in with.`,
  },
};

export async function getSitePage(slug: SitePageSlug): Promise<SitePageDoc> {
  return SitePage.findOneAndUpdate({ slug }, { $setOnInsert: { slug, ...DEFAULTS[slug] } }, { upsert: true, new: true });
}

export function toPublicSitePage(p: SitePageDoc) {
  return {
    slug: p.slug,
    title: p.title,
    content: p.content,
    contact: p.slug === 'support' ? { email: p.contact?.email ?? null, phone: p.contact?.phone ?? null, whatsapp: p.contact?.whatsapp ?? null, hours: p.contact?.hours ?? null } : null,
    published: p.published,
    updatedAt: p.updatedAt,
  };
}

const slugSchema = z.enum(SITE_PAGE_SLUGS);

/** Mounted at /api/pages: public, no login (linked from the login and sign-up pages). */
export const publicPagesRouter = Router();

publicPagesRouter.get('/:slug', async (req, res) => {
  const slug = slugSchema.safeParse(req.params.slug);
  if (!slug.success) throw notFound('Page not found.');
  const page = await getSitePage(slug.data);
  if (!page.published) throw notFound('Page not found.');
  const { published: _published, ...rest } = toPublicSitePage(page);
  res.json({ page: rest });
});

/** Mounted at /api/admin/pages. Platform admin only. */
export const adminPagesRouter = Router();

adminPagesRouter.get('/', async (_req, res) => {
  const pages = await Promise.all(SITE_PAGE_SLUGS.map(getSitePage));
  res.json({ pages: pages.map(toPublicSitePage) });
});

const optionalText = (max: number) => z.string().trim().max(max).nullable().transform((v) => v || null);
const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    content: z.string().max(60_000),
    published: z.boolean(),
    contact: z.object({ email: optionalText(254), phone: optionalText(40), whatsapp: optionalText(40), hours: optionalText(120) }).partial(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

adminPagesRouter.put('/:slug', async (req, res) => {
  const slug = slugSchema.safeParse(req.params.slug);
  if (!slug.success) throw notFound('Page not found.');
  const input = parse(updateSchema, req.body);
  const page = await getSitePage(slug.data);
  const { contact, ...rest } = input;
  page.set({ ...rest, updatedBy: req.user!._id });
  for (const [k, v] of Object.entries(contact ?? {})) page.set(`contact.${k}`, v);
  await page.save();
  await adminLog(req, { action: 'admin.site_page_updated', targetType: 'page', targetId: page.slug, metadata: { fields: Object.keys(input) } });
  res.json({ page: toPublicSitePage(page) });
});
