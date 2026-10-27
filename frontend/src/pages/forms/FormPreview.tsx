import { ArrowLeft, CheckCircle2, ExternalLink, X } from 'lucide-react';
import { useState } from 'react';
import type { FormScreen, WaForm } from '../../lib/api';
import { ElementView, INPUT_TYPES, type Answers } from './elements';

const filled = (v: Answers[string] | undefined) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? v.trim() !== '' : v === true);

/** Phone-sized walk-through of the form: the chat message, every screen, then the reply. */
export function FormPreviewDialog({ form, screens, onClose }: { form: WaForm; screens: FormScreen[]; onClose: () => void }) {
  // -1: the chat message with the button; screens.length: submitted.
  const [step, setStep] = useState(-1);
  const [answers, setAnswers] = useState<Answers>({});
  const screen = screens[step];
  const missing = screen?.components.some((c) => INPUT_TYPES.includes(c.type) && c.required && !filled(answers[c.key ?? c.id])) ?? false;
  const reply = form.successMessage.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => {
    const v = answers[k];
    return Array.isArray(v) ? v.join(', ') : typeof v === 'string' && v ? v : `{{${k}}}`;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4" onClick={onClose}>
      <div className="relative" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Form preview">
        <button onClick={onClose} className="absolute -top-2 -right-12 rounded-full bg-white p-1.5 text-slate-600 shadow hover:bg-slate-100" aria-label="Close preview">
          <X className="size-4" />
        </button>
        <div className="flex h-[640px] max-h-[85vh] w-[340px] flex-col overflow-hidden rounded-[2.2rem] border-[10px] border-slate-900 bg-[#efe7de] shadow-2xl">
          <div className="flex items-center gap-2 bg-[#075e54] px-4 py-3 text-white">
            <span className="flex size-7 items-center justify-center rounded-full bg-white/20 text-xs font-semibold">Z</span>
            <span className="text-sm font-medium">Your business</span>
          </div>
          <div className="relative min-h-0 flex-1">
            <div className="h-full space-y-2 overflow-y-auto p-3">
              <div className="max-w-[85%] rounded-lg rounded-tl-none bg-white p-2.5 text-sm shadow-sm">
                <p className="whitespace-pre-line text-slate-800">{form.intro || form.name}</p>
                <button type="button" onClick={() => setStep(0)} disabled={!screens.length} className="mt-2 flex w-full items-center justify-center gap-1.5 border-t border-slate-100 pt-2 text-sm font-medium text-sky-600 disabled:text-slate-400">
                  <ExternalLink className="size-3.5" /> {form.ctaText || 'Open form'}
                </button>
              </div>
              {step === screens.length && screens.length > 0 && (
                <div className="ml-auto max-w-[85%] rounded-lg rounded-tr-none bg-[#d9fdd3] p-2.5 text-sm shadow-sm">
                  <p className="flex items-center gap-1.5 font-medium text-slate-700">
                    <CheckCircle2 className="size-4 text-emerald-600" /> Response sent
                  </p>
                </div>
              )}
              {step === screens.length && reply && (
                <div className="max-w-[85%] rounded-lg rounded-tl-none bg-white p-2.5 text-sm whitespace-pre-line text-slate-800 shadow-sm">{reply}</div>
              )}
              {step === -1 && !screens.length && <p className="pt-6 text-center text-xs text-slate-500">Add a screen to preview the form.</p>}
            </div>
            {screen && (
              <div className="absolute inset-0 top-6 flex flex-col overflow-hidden rounded-t-2xl bg-white shadow-[0_-8px_24px_rgba(0,0,0,0.15)]">
                <div className="flex items-center gap-2 border-b border-slate-100 px-3 py-3">
                  <button type="button" onClick={() => setStep(step - 1)} className="rounded-full p-1 text-slate-600 hover:bg-slate-100" aria-label={step === 0 ? 'Close form' : 'Back'}>
                    {step === 0 ? <X className="size-4" /> : <ArrowLeft className="size-4" />}
                  </button>
                  <p className="flex-1 truncate text-center text-sm font-semibold text-slate-800">{screen.title || 'Untitled screen'}</p>
                  <span className="w-6 text-right text-[10px] text-slate-400">
                    {step + 1}/{screens.length}
                  </span>
                </div>
                <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
                  {screen.components.map((c) => (
                    <ElementView key={c.id} c={c} answers={answers} onChange={(k, v) => setAnswers((a) => ({ ...a, [k]: v }))} />
                  ))}
                  {!screen.components.length && <p className="text-center text-xs text-slate-400">This screen is empty.</p>}
                </div>
                <div className="border-t border-slate-100 p-3">
                  <button
                    type="button"
                    disabled={missing}
                    onClick={() => setStep(step + 1)}
                    className="w-full rounded-full bg-emerald-600 py-2.5 text-sm font-medium text-white disabled:bg-slate-200 disabled:text-slate-400"
                  >
                    {screen.footerLabel || 'Continue'}
                  </button>
                  <p className="mt-2 text-center text-[10px] text-slate-400">Managed by the business. Learn more</p>
                </div>
              </div>
            )}
          </div>
        </div>
        {step === screens.length && screens.length > 0 && (
          <button type="button" onClick={() => (setStep(-1), setAnswers({}))} className="mx-auto mt-3 block text-sm font-medium text-white hover:underline">
            Restart preview
          </button>
        )}
      </div>
    </div>
  );
}
