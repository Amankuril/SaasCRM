import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { NODE_META, PALETTE_GROUPS } from '../../components/flow/meta';
import { Button, Card, cn } from '../../components/ui';
import type { FlowNodeType } from '../../lib/api';

const GUIDES: { title: string; body: string[] }[] = [
  {
    title: 'Getting started',
    body: [
      'Open the Flow Builder tab and click "New Automation", or pick one from "Browse Templates".',
      'Every automation begins with a Trigger. Choose what starts it: a keyword, any incoming message, a new contact, a tag being added, a form submission or your API.',
      'Drag steps from the left palette onto the canvas and connect the dots between them in the order they should run.',
      'Changes are saved as a draft automatically. Customers only see them after you click Publish.',
    ],
  },
  {
    title: 'Publishing, pausing and testing',
    body: [
      'Publish checks every step. Steps with missing details are highlighted in red and must be fixed first.',
      'Use Test in the builder to run the automation on your own WhatsApp number before customers see it.',
      'The switch in the automations list activates or pauses an automation. Pausing stops new runs and ends the ones in progress.',
      'Editing a live automation creates a draft. The live version keeps running until you publish again.',
    ],
  },
  {
    title: 'The 24-hour window',
    body: [
      'WhatsApp lets you send free-form messages only within 24 hours of the customer\'s last message.',
      'Outside that window use a Template Msg step: approved templates can be sent any time.',
      'A Wait step longer than 24 hours should be followed by a Template Msg step.',
    ],
  },
  {
    title: 'Using variables',
    body: [
      'Type {{contact.name}}, {{contact.phone}} or {{contact.email}} in any message to personalise it.',
      'Answers saved by Question steps are available as {{vars.<name>}} or on the contact as {{contact.custom.<field>}}.',
      'Webhook Request steps can copy values from the response into variables for later steps.',
    ],
  },
  {
    title: 'Handing over to your team',
    body: [
      'Transfer Agent pauses the bot, opens the chat in Team Inbox and can assign it to a teammate.',
      'Smart Ticket creates a ticket on the task board so nothing is forgotten.',
      'Resolve Chat closes the conversation once the automation has done its job.',
    ],
  },
];

/** In-app help for the Flow Builder module. */
export function FlowDocsTab({ onOpenBuilder }: { onOpenBuilder: () => void }) {
  const [open, setOpen] = useState(0);
  const steps = (Object.keys(NODE_META) as FlowNodeType[]).filter((t) => t !== 'trigger');

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div>
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl leading-8 font-medium text-ink">Documentation</h1>
            <p className="mt-1 text-sm text-slate-500">How to build, publish and measure automations.</p>
          </div>
          <Button onClick={onOpenBuilder}>Open flow builder</Button>
        </div>
        <Card className="divide-y divide-slate-100">
          {GUIDES.map((g, i) => (
            <div key={g.title}>
              <button type="button" onClick={() => setOpen(open === i ? -1 : i)} aria-expanded={open === i} className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left">
                <span className="text-sm font-semibold text-ink">{g.title}</span>
                <ChevronDown className={cn('size-4 text-slate-400 transition-transform', open !== i && '-rotate-90')} />
              </button>
              {open === i && (
                <ul className="list-disc space-y-1.5 px-4 pb-4 pl-9 text-sm leading-relaxed text-slate-600">
                  {g.body.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </Card>
      </div>
      <Card className="h-fit p-4">
        <h2 className="text-sm font-semibold text-ink">Step reference</h2>
        {PALETTE_GROUPS.map((group) => (
          <div key={group} className="mt-4">
            <p className="mb-2 text-xs font-semibold text-slate-400">{group}</p>
            <ul className="space-y-2">
              {steps
                .filter((t) => NODE_META[t].group === group && !NODE_META[t].hidden)
                .map((t) => {
                  const m = NODE_META[t];
                  return (
                    <li key={t} className="flex items-start gap-2.5">
                      <span className={cn('rounded-md p-1.5 ring-1', m.accent)}>
                        <m.icon className="size-3.5" />
                      </span>
                      <div>
                        <p className="text-sm font-medium text-slate-800">{m.label}</p>
                        <p className="text-xs text-slate-500">{m.description}</p>
                      </div>
                    </li>
                  );
                })}
            </ul>
          </div>
        ))}
      </Card>
    </div>
  );
}
