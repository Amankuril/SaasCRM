import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Lock } from 'lucide-react';
import { useState } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { ConfirmDialog, useToast } from '../../components/feedback';
import { Alert, Button, Card, errorMessage } from '../../components/ui';
import { api, type ReminderAccess } from '../../lib/api';
import { loadRazorpay, type RazorpayResult } from '../../lib/razorpay';
import { useWorkspace } from '../../layouts/workspaceContext';
import { money } from './shared';

/** One-time unlock. Title, price, discount, benefits and button come from Super Admin settings. */
export function UnlockPanel({ access }: { access: ReminderAccess }) {
  const { workspace, can } = useWorkspace();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [sandbox, setSandbox] = useState(false);
  const { offer } = access;
  const base = `/workspaces/${workspace.id}/reminders/unlock`;
  const done = () => {
    setSandbox(false);
    toast.success('Date reminders are unlocked.');
    void queryClient.invalidateQueries({ queryKey: ['reminders', workspace.id] });
  };
  const confirm = useMutation({ mutationFn: (r: RazorpayResult) => api.post(`${base}/confirm`, r), onSuccess: done });
  const finishSandbox = useMutation({ mutationFn: () => api.post(`${base}/sandbox`), onSuccess: done });
  const start = useMutation({
    mutationFn: async () => {
      const { order, razorpayKeyId } = await api.post<{ order: { orderId: string; amount: number; currency: string; provider: string }; razorpayKeyId: string | null }>(base);
      if (order.provider !== 'razorpay') return setSandbox(true);
      if (!razorpayKeyId) throw new Error('Online payments are not set up yet.');
      await loadRazorpay();
      const rzp = new window.Razorpay!({
        key: razorpayKeyId,
        order_id: order.orderId,
        amount: order.amount,
        currency: order.currency,
        name: 'Zeta Connect',
        description: `Date reminders, ${offer.title.toLowerCase()}`,
        prefill: { email: user?.email, name: user?.name },
        theme: { color: '#0a7d55' },
        handler: (r) => confirm.mutate(r),
      });
      rzp.on('payment.failed', (r) => toast.error(r.error?.description ?? 'The payment did not go through.'));
      rzp.open();
    },
  });
  const error = start.error ?? confirm.error ?? finishSandbox.error;

  return (
    <Card className="p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-ink">{offer.title}</h2>
        {offer.discountPercent > 0 && <span className="text-xs font-medium text-brand-700">{offer.discountPercent}% off</span>}
      </div>
      <p className="mt-3 flex items-baseline gap-2">
        <span className="text-3xl leading-none font-medium text-ink tabular-nums">{money(offer.price, offer.currency)}</span>
        {offer.comparePrice > offer.price && <span className="text-sm text-slate-400 tabular-nums line-through">{money(offer.comparePrice, offer.currency)}</span>}
      </p>
      {offer.benefits.length > 0 && (
        <ul className="mt-4 space-y-2 text-sm text-slate-600">
          {offer.benefits.map((b) => (
            <li key={b} className="flex items-center gap-2">
              <Check className="size-4 shrink-0 text-brand-600" strokeWidth={1.75} /> {b}
            </li>
          ))}
        </ul>
      )}
      {error != null && (
        <div className="mt-4">
          <Alert>{error instanceof Error && error.constructor === Error ? error.message : errorMessage(error)}</Alert>
        </div>
      )}
      <Button className="mt-5 w-full" disabled={!can('billing:manage')} loading={start.isPending || confirm.isPending} onClick={() => start.mutate()}>
        <Lock className="size-4" strokeWidth={1.75} /> {offer.buttonLabel}
      </Button>
      {!can('billing:manage') && <p className="mt-2 text-xs text-slate-500">Only the workspace owner can buy this.</p>}
      {sandbox && (
        <ConfirmDialog title="Sandbox payment" danger={false} confirmLabel="Simulate payment" loading={finishSandbox.isPending} onConfirm={() => finishSandbox.mutate()} onClose={() => setSandbox(false)}>
          No money moves in sandbox mode. Confirm to mark {money(offer.price, offer.currency)} as paid.
        </ConfirmDialog>
      )}
    </Card>
  );
}
