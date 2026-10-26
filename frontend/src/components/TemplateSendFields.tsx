import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Loader2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { api, type SendRequirements, type TemplateExtras, type TemplateMediaInput } from '../lib/api';
import { useWorkspace } from '../layouts/workspaceContext';
import { Field, Input, cn, errorMessage, fieldError } from './ui';

/** Empty send values shaped like the template (one entry per carousel card). */
export function emptyExtras(req: SendRequirements | undefined): TemplateExtras {
  if (!req?.cards.length) return {};
  return { cards: req.cards.map((c) => ({ media: {}, bodyParams: Array(c.body).fill(''), buttonParams: Array(c.buttons.length).fill('') })) };
}

/** True when the template needs anything beyond header/body text variables. */
export function needsExtras(req: SendRequirements | undefined): boolean {
  return !!req && !!(req.headerMedia || req.headerLocation || req.offer?.expires || req.products || req.otp || req.cards.length);
}

/** Props for TemplatePreview that show the chosen media and card values. */
export function extrasPreview(extras: TemplateExtras) {
  return {
    mediaUrl: extras.headerMedia?.link,
    cardMediaUrls: (extras.cards ?? []).map((c) => c.media.link),
    cardBodyParams: (extras.cards ?? []).map((c) => c.bodyParams),
  };
}

export const buttonValueLabel = (b: SendRequirements['buttons'][number]) => (b.type === 'COPY_CODE' ? 'Offer code' : `“${b.text}” link value`);

/** Plain per-send button values (URL suffixes, coupon codes), used where there is one recipient. */
export function ButtonValueInputs({
  requirements,
  values,
  onChange,
  error,
}: {
  requirements: SendRequirements;
  values: string[];
  onChange: (v: string[]) => void;
  error?: unknown;
}) {
  if (!requirements.buttons.length) return null;
  return (
    <div className="space-y-2">
      {requirements.buttons.map((b, i) => (
        <Field key={b.index} label={buttonValueLabel(b)} htmlFor={`btn-${b.index}`} error={i === 0 ? fieldError(error, 'buttonParams') : undefined} hint={b.type === 'URL' ? 'Added to the end of the button’s link.' : undefined}>
          <Input id={`btn-${b.index}`} value={values[i] ?? ''} maxLength={b.type === 'COPY_CODE' ? 15 : 2000} onChange={(e) => onChange(requirements.buttons.map((_, j) => (j === i ? e.target.value : (values[j] ?? ''))))} />
        </Field>
      ))}
    </div>
  );
}

const MEDIA_ACCEPT = { IMAGE: 'image/jpeg,image/png', VIDEO: 'video/mp4', DOCUMENT: 'application/pdf', AUDIO: 'audio/mpeg,audio/ogg,audio/aac,audio/mp4,audio/amr' } as const;

/** Header/card media: upload a file to WhatsApp, or give a public https link. */
export function MediaInput({
  id,
  label,
  format,
  value,
  onChange,
  disabled,
  error,
}: {
  id: string;
  label: string;
  format: keyof typeof MEDIA_ACCEPT;
  value: TemplateMediaInput | undefined;
  onChange: (v: TemplateMediaInput | undefined) => void;
  disabled?: boolean;
  error?: string;
}) {
  const { workspace } = useWorkspace();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<'upload' | 'link'>(value?.link ? 'link' : 'upload');
  const upload = useMutation({
    mutationFn: (file: File) => api.upload<{ mediaId: string; fileName: string }>(`/workspaces/${workspace.id}/messages/media`, file),
    onSuccess: ({ mediaId, fileName }) => onChange({ id: mediaId, filename: fileName }),
  });
  const kind = format.toLowerCase();

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label htmlFor={id} className="text-sm font-medium text-slate-700">
          {label}
        </label>
        <div className="flex gap-0.5 rounded-md bg-slate-100 p-0.5 text-xs">
          {(['upload', 'link'] as const).map((m) => (
            <button
              key={m}
              type="button"
              disabled={disabled}
              onClick={() => {
                setMode(m);
                onChange(undefined);
              }}
              className={cn('rounded px-2 py-0.5', mode === m ? 'bg-white font-medium shadow-sm' : 'text-slate-500')}
            >
              {m === 'upload' ? 'Upload' : 'Link'}
            </button>
          ))}
        </div>
      </div>
      {mode === 'link' ? (
        <Input id={id} placeholder={`https://… public ${kind} URL`} disabled={disabled} value={value?.link ?? ''} onChange={(e) => onChange(e.target.value.trim() ? { link: e.target.value.trim() } : undefined)} />
      ) : (
        <>
          <input ref={fileRef} type="file" accept={MEDIA_ACCEPT[format]} className="hidden" onChange={(e) => e.target.files?.[0] && upload.mutate(e.target.files[0])} />
          <button
            id={id}
            type="button"
            disabled={disabled || upload.isPending}
            onClick={() => fileRef.current?.click()}
            className={cn(
              'flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left text-sm disabled:opacity-60',
              value?.id ? 'border-emerald-300 bg-emerald-50/50 text-emerald-800' : 'border-slate-300 text-slate-600 hover:bg-slate-50',
            )}
          >
            {upload.isPending ? <Loader2 className="size-4 animate-spin" /> : value?.id ? <CheckCircle2 className="size-4" /> : <Upload className="size-4" />}
            {upload.isPending ? 'Uploading to WhatsApp…' : value?.id ? `${value.filename ?? 'File'} uploaded · replace` : `Upload ${kind}`}
          </button>
        </>
      )}
      {upload.error != null && <p className="text-xs text-red-600">{errorMessage(upload.error)}</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

const toLocalInput = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

/**
 * Inputs for everything a template needs besides text variables: header media
 * or location, offer expiry, catalog products, OTP code and carousel cards.
 */
export function TemplateExtrasFields({
  requirements: req,
  value,
  onChange,
  disabled,
  error,
  shared = false,
}: {
  requirements: SendRequirements;
  value: TemplateExtras;
  onChange: (v: TemplateExtras) => void;
  disabled?: boolean;
  error?: unknown;
  /** Campaigns and flows: values are the same for every recipient. */
  shared?: boolean;
}) {
  if (!needsExtras(req)) return null;
  const set = (patch: Partial<TemplateExtras>) => onChange({ ...value, ...patch });
  const cards = value.cards ?? emptyExtras(req).cards ?? [];
  const setCard = (i: number, patch: Partial<(typeof cards)[number]>) => set({ cards: cards.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const relative = value.offerExpiresInMinutes !== undefined;
  const loc = value.headerLocation;
  const setLoc = (patch: Partial<NonNullable<TemplateExtras['headerLocation']>>) =>
    set({ headerLocation: { latitude: loc?.latitude ?? 0, longitude: loc?.longitude ?? 0, ...loc, ...patch } });

  return (
    <div className="space-y-4">
      {shared && <p className="text-xs text-slate-500">These values are the same for every recipient. Uploaded files stay available on WhatsApp for 30 days.</p>}

      {req.headerMedia && (
        <MediaInput id="x-header" label={`Header ${req.headerMedia.toLowerCase()}`} format={req.headerMedia} value={value.headerMedia} disabled={disabled} onChange={(headerMedia) => set({ headerMedia })} error={fieldError(error, 'headerMedia')} />
      )}

      {req.headerLocation && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Header location</p>
          <div className="grid grid-cols-2 gap-2">
            <Input aria-label="Latitude" type="number" step="any" placeholder="Latitude" disabled={disabled} value={loc?.latitude ?? ''} onChange={(e) => setLoc({ latitude: Number(e.target.value) })} />
            <Input aria-label="Longitude" type="number" step="any" placeholder="Longitude" disabled={disabled} value={loc?.longitude ?? ''} onChange={(e) => setLoc({ longitude: Number(e.target.value) })} />
            <Input aria-label="Place name" placeholder="Place name (optional)" disabled={disabled} value={loc?.name ?? ''} onChange={(e) => setLoc({ name: e.target.value || undefined })} />
            <Input aria-label="Address" placeholder="Address (optional)" disabled={disabled} value={loc?.address ?? ''} onChange={(e) => setLoc({ address: e.target.value || undefined })} />
          </div>
          {fieldError(error, 'headerLocation') && <p className="text-xs text-red-600">{fieldError(error, 'headerLocation')}</p>}
        </div>
      )}

      {req.offer?.expires && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-slate-700">Offer ends</p>
          <div className="flex flex-wrap gap-3 text-sm text-slate-700">
            <label className="flex items-center gap-1.5">
              <input type="radio" disabled={disabled} checked={!relative} onChange={() => set({ offerExpiresInMinutes: undefined })} /> At a set time
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" disabled={disabled} checked={relative} onChange={() => set({ offerExpiresAt: undefined, offerExpiresInMinutes: 24 * 60 })} /> A while after each message is sent
            </label>
          </div>
          {relative ? (
            <div className="flex items-center gap-2">
              <Input
                aria-label="Offer length in hours"
                type="number"
                min={1}
                max={720}
                className="w-28"
                disabled={disabled}
                value={Math.round((value.offerExpiresInMinutes ?? 0) / 60) || ''}
                onChange={(e) => set({ offerExpiresInMinutes: Math.max(1, Number(e.target.value) || 1) * 60 })}
              />
              <span className="text-sm text-slate-600">hours after sending</span>
            </div>
          ) : (
            <Input
              aria-label="Offer end time"
              type="datetime-local"
              className="max-w-xs"
              disabled={disabled}
              value={toLocalInput(value.offerExpiresAt)}
              onChange={(e) => set({ offerExpiresAt: e.target.value ? new Date(e.target.value).toISOString() : undefined })}
            />
          )}
          {fieldError(error, 'offerExpiresAt') && <p className="text-xs text-red-600">{fieldError(error, 'offerExpiresAt')}</p>}
        </div>
      )}

      {req.products && (
        <div className="space-y-2">
          <Field label="Featured product SKU" htmlFor="x-thumb" hint="The catalog retailer id shown as the thumbnail." error={fieldError(error, 'products')}>
            <Input id="x-thumb" disabled={disabled} value={value.products?.thumbnail ?? ''} onChange={(e) => set({ products: { items: value.products?.items ?? [], thumbnail: e.target.value.trim() } })} />
          </Field>
          {req.products === 'MPM' && (
            <Field label="Products to show" htmlFor="x-items" hint="Retailer ids separated by commas (up to 30).">
              <Input
                id="x-items"
                disabled={disabled}
                value={(value.products?.items ?? []).join(', ')}
                onChange={(e) => set({ products: { thumbnail: value.products?.thumbnail ?? '', items: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })}
              />
            </Field>
          )}
        </div>
      )}

      {req.otp && (
        <Field label="One-time code" htmlFor="x-otp" error={fieldError(error, 'otpCode')} hint="Usually sent by your app through the API, not by hand.">
          <Input id="x-otp" maxLength={15} disabled={disabled} value={value.otpCode ?? ''} onChange={(e) => set({ otpCode: e.target.value.trim() || undefined })} />
        </Field>
      )}

      {req.cards.length > 0 && (
        <div className="space-y-3">
          <p className="text-sm font-medium text-slate-700">Carousel cards</p>
          {req.cards.map((c, i) => {
            const card = cards[i] ?? { media: {}, bodyParams: [], buttonParams: [] };
            return (
              <div key={i} className="space-y-2 rounded-lg border border-slate-200 p-3">
                <MediaInput
                  id={`x-card-${i}`}
                  label={`Card ${i + 1} ${c.media.toLowerCase()}`}
                  format={c.media}
                  disabled={disabled}
                  value={card.media.id || card.media.link ? card.media : undefined}
                  onChange={(media) => setCard(i, { media: media ?? {} })}
                />
                {Array.from({ length: c.body }, (_, k) => (
                  <Input
                    key={`b${k}`}
                    aria-label={`Card ${i + 1} text {{${k + 1}}}`}
                    placeholder={`Card text {{${k + 1}}}`}
                    disabled={disabled}
                    value={card.bodyParams[k] ?? ''}
                    onChange={(e) => setCard(i, { bodyParams: Array.from({ length: c.body }, (_, j) => (j === k ? e.target.value : (card.bodyParams[j] ?? ''))) })}
                  />
                ))}
                {c.buttons.map((b, k) => (
                  <Input
                    key={`u${k}`}
                    aria-label={`Card ${i + 1} “${b.text}” link value`}
                    placeholder={`“${b.text}” link value`}
                    disabled={disabled}
                    value={card.buttonParams[k] ?? ''}
                    onChange={(e) => setCard(i, { buttonParams: c.buttons.map((_, j) => (j === k ? e.target.value : (card.buttonParams[j] ?? ''))) })}
                  />
                ))}
              </div>
            );
          })}
          {fieldError(error, 'cards') && <p className="text-xs text-red-600">{fieldError(error, 'cards')}</p>}
        </div>
      )}
    </div>
  );
}
