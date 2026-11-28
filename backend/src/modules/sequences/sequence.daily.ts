import { logger } from '../../lib/logger.js';
import { Contact } from '../contacts/contact.model.js';
import { addDays, localDate } from '../reminders/schedule.js';
import { Workspace } from '../workspaces/workspace.model.js';
import { enroll } from './sequence.engine.js';
import { Sequence, type SequenceDoc } from './sequence.model.js';
import { dayOf } from './sequence.rules.js';

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
function localMinutes(at: Date, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((x) => [x.type, x.value]));
  return Number(p.hour) * 60 + Number(p.minute);
}

/**
 * Hourly: date-field and inactivity sequences scan their contacts once a day,
 * after the trigger's time of day (workspace timezone). Each date (or quiet
 * spell) is one occurrence, so a contact joins once per appointment / birthday.
 */
export async function runDailyTriggers(now = new Date()): Promise<number> {
  const sequences = await Sequence.find({ status: 'active', 'trigger.type': { $in: ['date_field', 'inactive'] } }).setOptions({ skipTenantScope: true });
  let joined = 0;
  for (const seq of sequences) {
    try {
      joined += await runOne(seq, now);
    } catch (err) {
      logger.error({ err, sequenceId: String(seq._id) }, 'Daily sequence trigger failed');
    }
  }
  return joined;
}

async function runOne(seq: SequenceDoc, now: Date): Promise<number> {
  const ws = await Workspace.findById(seq.workspaceId).select('timezone').lean();
  if (!ws) return 0;
  const tz = ws.timezone;
  const today = localDate(now, tz);
  const t = seq.trigger!;
  if (seq.dailyRunDay === today) return 0;
  if (localMinutes(now, tz) < minutesOf(t.time || '09:00')) return 0;
  // Claim today's run so two workers never scan the same sequence twice.
  const claimed = await Sequence.updateOne({ _id: seq._id, workspaceId: seq.workspaceId, dailyRunDay: { $ne: today } }, { dailyRunDay: today });
  if (!claimed.modifiedCount) return 0;

  let joined = 0;
  if (t.type === 'date_field' && t.fieldKey) {
    const offset = t.direction === 'before' ? t.offsetDays : t.direction === 'after' ? -t.offsetDays : 0;
    const target = addDays(today, offset); // the field date that triggers today
    const path = `customFields.${t.fieldKey}`;
    const cursor = Contact.find({ workspaceId: seq.workspaceId, [path]: { $nin: [null, ''] } }).cursor();
    for await (const contact of cursor) {
      const raw = ((contact.customFields ?? {}) as Record<string, unknown>)[t.fieldKey];
      const day = dayOf(raw, tz);
      if (!day) continue;
      const hit = t.repeatYearly ? day.slice(5) === target.slice(5) : day === target;
      if (!hit) continue;
      const occurrence = t.repeatYearly ? `${target.slice(0, 4)}-${day.slice(5)}` : day;
      const { result } = await enroll(seq, contact, { via: 'trigger:date_field', data: { [t.fieldKey]: t.repeatYearly ? occurrence : day }, occurrence });
      if (result === 'enrolled') joined++;
    }
  }

  if (t.type === 'inactive' && t.days > 0) {
    // Last message from them N days ago (2-day window in case a day was missed).
    const to = new Date(now.getTime() - t.days * 86_400_000);
    const from = new Date(to.getTime() - 2 * 86_400_000);
    const cursor = Contact.find({ workspaceId: seq.workspaceId, lastInboundAt: { $gte: from, $lt: to } }).cursor();
    for await (const contact of cursor) {
      const { result } = await enroll(seq, contact, { via: 'trigger:inactive', occurrence: `quiet:${contact.lastInboundAt!.toISOString()}` });
      if (result === 'enrolled') joined++;
    }
  }
  return joined;
}
