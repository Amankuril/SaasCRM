import { CalendarClock, Clock, Hand, MessageSquare, RotateCcw, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, PageHeader } from '../../components/ui';

/** Sequences > Guide: how sequences work, with worked examples to copy. */
export function SequenceGuidePage() {
  return (
    <div className="max-w-4xl">
      <PageHeader title="Sequences guide" description="How a sequence works, and three examples a clinic can copy today." />

      <div className="grid gap-4 md:grid-cols-2">
        <Block icon={Zap} title="1. Who joins">
          Each sequence has exactly one trigger: added manually or by API, a tag is added, a lifecycle stage, a contact list, a new contact, a custom field change, a date in a custom field, or going quiet. Only things that happen
          <strong> after you publish</strong> bring people in. Add <em>Only these contacts</em> to narrow it down.
        </Block>
        <Block icon={MessageSquare} title="2. Messages and waits">
          Messages use your <strong>approved</strong> Marketing or Utility templates. Map each <code>{'{{1}}'}</code> to the contact's name, a custom field, data sent when they joined, today's date or fixed text, with a fallback.
          Waits are relative to when each person joined: someone who joins today gets message 1 today, someone who joins next week starts next week.
        </Block>
        <Block icon={CalendarClock} title="3. Dates for reminders">
          For webinars use <em>one date for everyone</em>; for trials, renewals and bookings use <em>each contact's own date</em> (a key in their joined-with data, or a custom field). <em>Wait until date</em> steps run N days
          before, on or after that date. Late joiners skip reminders whose time has passed; the history says so.
        </Block>
        <Block icon={ShieldCheck} title="4. When it stops">
          <strong>Goal</strong> (e.g. tag <em>Paid</em>) ends it as a success. Stop conditions, a reply (if "Stop when contact replies" is on), STOP/unsubscribe, removal, or a failed delivery (if you require delivery) end it too. Goals are checked
          the moment they happen and again right before every message.
        </Block>
        <Block icon={Clock} title="5. Sending rules">
          No messages at night (21:00–09:00 by default), only on the days you pick, at most 3 messages per contact per day across all sequences. When your monthly messages run out, contacts wait as <em>Needs attention</em> and continue
          when the plan renews. Nobody is lost.
        </Block>
        <Block icon={RotateCcw} title="6. Test, publish, edit">
          <strong>Test</strong> sends the whole draft to your own number with 20-second waits. <strong>Preview & publish</strong> shows the flow and how many messages it needs. After publishing, edits only affect new joiners: people already
          inside keep their path. The trigger is locked once live; duplicate the sequence to change it.
        </Block>
      </div>

      <h2 className="mt-8 mb-3 text-lg font-medium text-ink">Examples for a clinic</h2>
      <div className="space-y-3">
        <Example icon={CalendarClock} title="Appointment reminders" start="Appointment reminders">
          Keep each patient's appointment date in the custom field <code>appointment</code>. The sequence joins them the day before. A Utility reminder goes at 10:00 the day before, and "See you today" at 08:00 on the day. Turn off "Stop
          when contact replies" so a "Thanks!" doesn't cancel the morning reminder.
        </Example>
        <Example icon={Hand} title="Welcome new patients" start="Welcome new contacts">
          Joins when someone messages your number for the first time. The welcome goes right away; with "free message if the 24-hour window is open" it costs nothing. Three days later, a check-up offer.
        </Example>
        <Example icon={RotateCcw} title="Win back quiet patients" start="Win back quiet contacts">
          Joins people who chatted before but sent nothing for 30 days: a "we miss you" message, then a last offer four days later. Set the goal to the stage <em>Booked</em> so anyone who books leaves at once.
        </Example>
      </div>
    </div>
  );
}

function Block({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <h3 className="mb-2 flex items-center gap-2 font-medium text-ink">
        <Icon className="size-4 text-brand-600" strokeWidth={1.5} /> {title}
      </h3>
      <p className="text-sm leading-relaxed text-slate-600">{children}</p>
    </Card>
  );
}

function Example({ icon: Icon, title, start, children }: { icon: LucideIcon; title: string; start: string; children: ReactNode }) {
  return (
    <Card className="flex gap-4 p-5">
      <span className="h-fit rounded-lg bg-brand-50 p-2 text-brand-700">
        <Icon className="size-5" strokeWidth={1.5} />
      </span>
      <div>
        <h3 className="font-medium text-ink">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">{children}</p>
        <p className="mt-2 text-xs text-slate-500">
          New sequence → start from <strong>{start}</strong>
        </p>
      </div>
    </Card>
  );
}
