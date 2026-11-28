import { Router } from 'express';
import { z } from 'zod';
import { csvCell } from '../../lib/csv.js';
import { badRequest } from '../../lib/errors.js';
import { parse } from '../../lib/validate.js';
import { requirePermission } from '../../middleware/workspace.js';
import { MESSAGE_SOURCES } from '../messages/message.model.js';
import { addDays, daysBetween, isRealDate, localDate } from '../reminders/schedule.js';
import { MAX_RANGE_DAYS, buildMessagePricingReport, type ReportQuery } from './messagePricing.service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.').refine(isRealDate, 'Not a real date.');
const key = z.string().trim().toLowerCase().regex(/^[a-z_]{1,40}$/, 'Unknown value.');

const querySchema = z.object({
  from: day.optional(),
  to: day.optional(),
  direction: z.enum(['all', 'incoming', 'outgoing']).default('all'),
  type: key.default('all'),
  category: key.default('all'),
  source: z.enum(['all', ...MESSAGE_SOURCES]).default('all'),
  group: z.enum(['daily', 'weekly', 'monthly']).default('daily'),
});

function readQuery(raw: unknown, timezone: string): ReportQuery {
  const q = parse(querySchema, raw);
  const to = q.to ?? localDate(new Date(), timezone);
  const from = q.from ?? addDays(to, -29);
  if (from > to) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { from: ['The start date must be on or before the end date.'] });
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) throw badRequest('VALIDATION_ERROR', 'Some fields are invalid.', { from: [`Choose at most ${MAX_RANGE_DAYS} days.`] });
  return { ...q, from, to };
}

/** Mounted at /api/workspaces/:workspaceId/reports. */
export const reportsRouter = Router();

reportsRouter.get('/message-pricing', requirePermission('conversations:view_all'), async (req, res) => {
  const ws = req.workspace!;
  res.json(await buildMessagePricingReport(ws, readQuery(req.query, ws.timezone)));
});

/** The breakdown and the time series as one CSV file (two sections). */
reportsRouter.get('/message-pricing/export', requirePermission('conversations:view_all'), async (req, res) => {
  const ws = req.workspace!;
  const q = readQuery(req.query, ws.timezone);
  const r = await buildMessagePricingReport(ws, q);
  const line = (cells: unknown[]) => cells.map(csvCell).join(',');
  const lines = [
    line(['Message pricing report', `${q.from} to ${q.to}`, `Timezone ${ws.timezone}`]),
    line(['Filters', `direction=${q.direction}`, `type=${q.type}`, `category=${q.category}`]),
    line(['Estimate only. Actual charges come from your Meta invoice.']),
    '',
    line(['Pricing type', 'Pricing category', 'Total messages', 'Billable', 'Est. cost (INR)']),
    ...r.breakdown.map((b) => line([b.type, b.category, b.total, b.billable, b.estCost.toFixed(2)])),
    '',
    line([q.group === 'daily' ? 'Date' : q.group === 'weekly' ? 'Week starting' : 'Month', 'Incoming', 'Outgoing', 'Billable', 'Est. cost (INR)']),
    ...r.series.map((p) => line([q.group === 'monthly' ? p.date.slice(0, 7) : p.date, p.incoming, p.outgoing, p.billable, p.estCost.toFixed(2)])),
    '',
    line(['Total', r.totals.incoming, r.totals.outgoing, r.totals.billable, r.totals.estCost.toFixed(2)]),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="message-pricing-${q.from}-to-${q.to}.csv"`);
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});
