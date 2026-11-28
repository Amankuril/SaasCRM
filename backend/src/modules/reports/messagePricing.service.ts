import type { Types } from 'mongoose';
import { logger } from '../../lib/logger.js';
import { Message } from '../messages/message.model.js';
import { addDays, localDate, zonedToUtc } from '../reminders/schedule.js';
import { Workspace } from '../workspaces/workspace.model.js';
import { MessageDailyRollup, RateCard, type RollupRow } from './messagePricing.model.js';

/** Shown for outbound messages Meta sent no pricing for (e.g. free-form replies in the 24h window). */
export const NOT_AVAILABLE = 'not_available';
export const MAX_RANGE_DAYS = 365;

export type Direction = 'all' | 'incoming' | 'outgoing';
export type Grouping = 'daily' | 'weekly' | 'monthly';

export interface ReportQuery {
  from: string;
  to: string;
  direction: Direction;
  type: string;
  category: string;
  source: string;
  group: Grouping;
}

interface WorkspaceLike {
  _id: Types.ObjectId;
  timezone: string;
  pricingMarkupPct?: number | null;
}

type Row = Omit<RollupRow, 'source' | 'type' | 'category' | 'market'> & { source: string | null; type: string | null; category: string | null; market: string | null };

const dayStart = (day: string, tz: string) => zonedToUtc(day, '00:00', tz);

export function daysBetweenInclusive(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Message counts per workspace day, straight from the messages collection. */
async function countDays(workspaceId: Types.ObjectId, tz: string, from: string, to: string): Promise<Map<string, Row[]>> {
  const out = new Map<string, Row[]>();
  const docs = await Message.aggregate<{ _id: { day: string; direction: string; source: string | null; type: string | null; category: string | null; market: string | null }; count: number; billable: number }>([
    { $match: { workspaceId, createdAt: { $gte: dayStart(from, tz), $lt: dayStart(addDays(to, 1), tz) } } },
    {
      $group: {
        _id: {
          day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: tz } },
          direction: '$direction',
          source: { $ifNull: ['$source', null] },
          type: { $ifNull: ['$pricing.type', null] },
          category: { $ifNull: ['$pricing.category', null] },
          market: { $ifNull: ['$pricing.market', null] },
        },
        count: { $sum: 1 },
        billable: { $sum: { $cond: [{ $eq: ['$pricing.billable', true] }, 1, 0] } },
      },
    },
  ]);
  for (const d of docs) {
    const { day, ...key } = d._id;
    const rows = out.get(day) ?? [];
    rows.push({ ...key, count: d.count, billable: d.billable });
    out.set(day, rows);
  }
  return out;
}

/**
 * Rows for every day in [from, to]. Finished days come from the rollup (counted
 * and stored the first time they are needed); today is always counted live.
 */
export async function rowsForRange(ws: WorkspaceLike, from: string, to: string): Promise<Map<string, Row[]>> {
  const tz = ws.timezone;
  const today = localDate(new Date(), tz);
  const result = new Map<string, Row[]>();
  const lastClosed = to < today ? to : addDays(today, -1);

  if (from <= lastClosed) {
    const stored = await MessageDailyRollup.find({ workspaceId: ws._id, day: { $gte: from, $lte: lastClosed } }).lean();
    const byDay = new Map(stored.map((s) => [s.day, s]));
    const missing: string[] = [];
    for (const day of daysBetweenInclusive(from, lastClosed)) {
      const s = byDay.get(day);
      if (s && s.rows && s.timezone === tz) result.set(day, s.rows as Row[]);
      else missing.push(day);
    }
    if (missing.length) {
      const counted = await countDays(ws._id, tz, missing[0]!, missing[missing.length - 1]!);
      for (const day of missing) {
        const rows = counted.get(day) ?? [];
        result.set(day, rows);
        const version = byDay.get(day)?.version ?? 0;
        // Only store if nothing invalidated the day while we were counting.
        await MessageDailyRollup.updateOne(
          { workspaceId: ws._id, day, version },
          { $set: { rows, timezone: tz, computedAt: new Date() } },
          { upsert: true },
        ).catch((err: { code?: number }) => {
          if (err.code !== 11000) throw err;
        });
      }
    }
  }

  if (to >= today && from <= today) {
    const live = await countDays(ws._id, tz, today, today);
    result.set(today, live.get(today) ?? []);
  }
  return result;
}

/** Called when pricing lands on a message: its day must be counted again. */
export async function invalidatePricingRollup(workspaceId: Types.ObjectId, createdAt: Date): Promise<void> {
  const ws = await Workspace.findById(workspaceId).select('timezone').lean();
  if (!ws) return;
  const day = localDate(createdAt, ws.timezone);
  if (day >= localDate(new Date(), ws.timezone)) return; // today is counted live anyway
  await MessageDailyRollup.updateOne({ workspaceId, day }, { $inc: { version: 1 }, $set: { rows: null } }, { upsert: true });
}

/** Hourly: stores yesterday for every workspace that messaged recently. */
export async function rollupRecentDays(): Promise<void> {
  const since = new Date(Date.now() - 2 * 86_400_000);
  const workspaces = await Workspace.find({}).select('timezone pricingMarkupPct').lean();
  for (const ws of workspaces) {
    try {
      if (!(await Message.exists({ workspaceId: ws._id, createdAt: { $gte: since } }))) continue;
      const yesterday = addDays(localDate(new Date(), ws.timezone), -1);
      await rowsForRange(ws, addDays(yesterday, -1), yesterday);
    } catch (err) {
      logger.warn({ err, workspaceId: ws._id.toString() }, 'Message pricing rollup failed');
    }
  }
}

// ---- rates ----

export interface Rate {
  market: string;
  category: string;
  priceInr: number;
  validFrom: string;
  validTo: string | null;
}

export async function activeRates(): Promise<Rate[]> {
  const rates = await RateCard.find({ deletedAt: null }).sort({ validFrom: -1 }).lean();
  return rates.map((r) => ({ market: r.market, category: r.category, priceInr: r.priceInr, validFrom: r.validFrom, validTo: r.validTo ?? null }));
}

/** The rate for a market + category on a day: the country's own rate first, then "*". Newest `validFrom` wins. */
export function rateFor(rates: Rate[], market: string | null, category: string | null, day: string): number | null {
  if (!category) return null;
  const valid = rates.filter((r) => r.category === category && r.validFrom <= day && (!r.validTo || day <= r.validTo));
  const own = market ? valid.find((r) => r.market === market) : undefined;
  return (own ?? valid.find((r) => r.market === '*'))?.priceInr ?? null;
}

// ---- report ----

const round = (n: number) => Math.round(n * 100) / 100;

function bucketOf(day: string, group: Grouping): string {
  if (group === 'daily') return day;
  if (group === 'monthly') return `${day.slice(0, 8)}01`;
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(day, -weekday);
}

/**
 * Outbound rows always have a pricing type and category ("not_available" when
 * Meta sent none). Inbound messages have no pricing, so choosing a pricing type
 * or category shows outgoing messages only.
 */
function matches(row: Row, q: ReportQuery): boolean {
  const inbound = row.direction === 'inbound';
  if (q.direction === 'incoming' && !inbound) return false;
  if (q.direction === 'outgoing' && inbound) return false;
  if (q.source !== 'all' && (inbound || (row.source ?? NOT_AVAILABLE) !== q.source)) return false;
  if (q.type !== 'all' && (inbound || (row.type ?? NOT_AVAILABLE) !== q.type)) return false;
  if (q.category !== 'all' && (inbound || (row.category ?? NOT_AVAILABLE) !== q.category)) return false;
  return true;
}

export async function buildMessagePricingReport(ws: WorkspaceLike, q: ReportQuery) {
  const [byDay, rates] = await Promise.all([rowsForRange(ws, q.from, q.to), activeRates()]);
  const markup = 1 + (ws.pricingMarkupPct ?? 0) / 100;

  const totals = { total: 0, incoming: 0, outgoing: 0, billable: 0, estCost: 0, unpricedBillable: 0 };
  const series = new Map<string, { date: string; incoming: number; outgoing: number; billable: number; estCost: number }>();
  const breakdown = new Map<string, { type: string; category: string; total: number; billable: number; estCost: number; unpricedBillable: number }>();

  for (const day of daysBetweenInclusive(q.from, q.to)) {
    const key = bucketOf(day, q.group);
    const point = series.get(key) ?? { date: key, incoming: 0, outgoing: 0, billable: 0, estCost: 0 };
    series.set(key, point);
    for (const row of byDay.get(day) ?? []) {
      if (!matches(row, q)) continue;
      totals.total += row.count;
      if (row.direction === 'inbound') {
        totals.incoming += row.count;
        point.incoming += row.count;
        continue;
      }
      totals.outgoing += row.count;
      point.outgoing += row.count;

      const type = row.type ?? NOT_AVAILABLE;
      const category = row.category ?? NOT_AVAILABLE;
      const b = breakdown.get(`${type}|${category}`) ?? { type, category, total: 0, billable: 0, estCost: 0, unpricedBillable: 0 };
      breakdown.set(`${type}|${category}`, b);
      b.total += row.count;
      if (!row.billable) continue;

      b.billable += row.billable;
      totals.billable += row.billable;
      point.billable += row.billable;
      const rate = rateFor(rates, row.market, row.category, day);
      if (rate === null) {
        b.unpricedBillable += row.billable;
        totals.unpricedBillable += row.billable;
      } else {
        const cost = row.billable * rate * markup;
        b.estCost += cost;
        totals.estCost += cost;
        point.estCost += cost;
      }
    }
  }

  return {
    range: { from: q.from, to: q.to, timezone: ws.timezone, group: q.group },
    currency: 'INR',
    markupPct: ws.pricingMarkupPct ?? 0,
    totals: { ...totals, estCost: round(totals.estCost) },
    series: [...series.values()].map((p) => ({ ...p, estCost: round(p.estCost) })),
    breakdown: [...breakdown.values()].map((b) => ({ ...b, estCost: round(b.estCost) })).sort((a, b) => b.total - a.total || b.billable - a.billable),
  };
}

export type MessagePricingReport = Awaited<ReturnType<typeof buildMessagePricingReport>>;
