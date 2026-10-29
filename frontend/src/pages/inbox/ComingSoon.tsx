import { Phone, PhoneCall, PhoneIncoming, PhoneMissed, Users } from 'lucide-react';
import { Dialog } from '../../components/Dialog';

/** Lucide has no brand icons; the logo comes from the bundled simple-icons set. */
export const InstagramIcon = ({ className }: { className?: string }) => <img src="/integrations/instagram.svg" alt="" className={className} />;

/** Groups and Instagram need integrations that aren't available yet. */
export function ComingSoonPanel({ kind }: { kind: 'groups' | 'instagram' }) {
  const info =
    kind === 'groups'
      ? { icon: Users, title: 'WhatsApp Groups', text: 'Reply to customer groups from the same inbox, with the same assignment and notes. Coming soon.' }
      : { icon: InstagramIcon, title: 'Instagram Chats', text: 'Connect your Instagram business account to answer DMs and story replies next to WhatsApp. Coming soon.' };
  return (
    <div className="flex h-full min-h-80 flex-col items-center justify-center px-6 text-center">
      <span className="flex size-16 items-center justify-center rounded-2xl bg-slate-100 text-slate-500">
        <info.icon className="size-8" />
      </span>
      <h2 className="mt-4 text-xl font-bold text-ink">{info.title}</h2>
      <p className="mt-2 max-w-md text-slate-500">{info.text}</p>
      <span className="mt-4 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">Coming soon</span>
    </div>
  );
}

/** WhatsApp voice calls (Business Calling API) aren't connected yet, so there are no logs to show. */
export function CallLogsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog icon={<Phone className="size-5" />} title="Call Logs" subtitle="Incoming, outgoing and missed WhatsApp calls" width="max-w-2xl" onClose={onClose}>
      <div className="flex flex-col items-center py-8 text-center">
        <div className="flex gap-3 text-slate-300">
          <PhoneIncoming className="size-7" />
          <PhoneCall className="size-7" />
          <PhoneMissed className="size-7" />
        </div>
        <h3 className="mt-4 text-lg font-semibold text-ink">WhatsApp calling is coming soon</h3>
        <p className="mt-2 max-w-md text-sm text-slate-500">
          Once calling is enabled for your number, every call shows up here with who called, when, how long it lasted, recordings and transcripts, and you can open the chat in one click.
        </p>
      </div>
    </Dialog>
  );
}
