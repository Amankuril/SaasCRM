import { Router } from 'express';
import { z } from 'zod';
import { badRequest, notFound } from '../../lib/errors.js';
import { objectId, parse } from '../../lib/validate.js';
import { isRealDate } from '../reminders/schedule.js';
import { RateCard, type RateCardDoc } from '../reports/messagePricing.model.js';
import { adminLog } from './admin.service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine(isRealDate, 'Not a real date.');

const rateSchema = z.object({
  market: z.string().trim().toUpperCase().refine((v) => v === '*' || /^[A-Z]{2}$/.test(v), 'Use a 2-letter country code, or * for all other countries.'),
  category: z.string().trim().toLowerCase().regex(/^[a-z_]{2,40}$/, 'Use a Meta pricing category, e.g. marketing.'),
  priceInr: z.number().min(0).max(100),
  validFrom: day,
  validTo: day.nullable().default(null),
  note: z.string().trim().max(200).nullable().default(null),
});

const toPublicRate = (r: RateCardDoc) => ({
  id: r.id as string,
  market: r.market,
  category: r.category,
  priceInr: r.priceInr,
  validFrom: r.validFrom,
  validTo: r.validTo ?? null,
  note: r.note ?? null,
  updatedAt: r.updatedAt,
});

function checkDates(v: { validFrom: string; validTo: string | null }) {
  if (v.validTo && v.validTo < v.validFrom) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { validTo: ['Must be on or after the start date.'] });
}

/** Mounted at /api/admin/rate-cards: Meta's per-message rates used for cost estimates. */
export const adminRatesRouter = Router();

adminRatesRouter.get('/', async (_req, res) => {
  const rates = await RateCard.find({ deletedAt: null }).sort({ market: 1, category: 1, validFrom: -1 });
  res.json({ rates: rates.map(toPublicRate) });
});

adminRatesRouter.post('/', async (req, res) => {
  const input = parse(rateSchema, req.body);
  checkDates(input);
  const rate = await RateCard.create({ ...input, createdBy: req.user!._id });
  await adminLog(req, { action: 'admin.rate_card_created', targetType: 'rate_card', targetId: rate.id, metadata: input });
  res.status(201).json({ rate: toPublicRate(rate) });
});

adminRatesRouter.patch('/:rateId', async (req, res) => {
  const input = parse(rateSchema.partial(), req.body);
  const rate = await RateCard.findOne({ _id: objectId((req.params as { rateId: string }).rateId), deletedAt: null });
  if (!rate) throw notFound('Rate not found.');
  const before = toPublicRate(rate);
  rate.set(input);
  checkDates({ validFrom: rate.validFrom, validTo: rate.validTo ?? null });
  await rate.save();
  await adminLog(req, { action: 'admin.rate_card_updated', targetType: 'rate_card', targetId: rate.id, metadata: { before, change: input } });
  res.json({ rate: toPublicRate(rate) });
});

/** Soft delete: the row stays in the database for the record. */
adminRatesRouter.delete('/:rateId', async (req, res) => {
  const rate = await RateCard.findOne({ _id: objectId((req.params as { rateId: string }).rateId), deletedAt: null });
  if (!rate) throw notFound('Rate not found.');
  rate.deletedAt = new Date();
  await rate.save();
  await adminLog(req, { action: 'admin.rate_card_deleted', targetType: 'rate_card', targetId: rate.id, metadata: toPublicRate(rate) });
  res.status(204).end();
});
