import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Raw webhook inbox. Not tenant-scoped: the workspace is only known after the
 * payload is parsed. Persisting first lets us acknowledge Meta quickly and
 * process (and safely retry) asynchronously.
 */
const webhookEventSchema = new Schema(
  {
    provider: { type: String, required: true },
    // sha256 of the raw body: identical redeliveries are stored once.
    payloadHash: { type: String, required: true, unique: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: ['pending', 'processed', 'failed'], default: 'pending' },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: null },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// Raw payloads contain customer messages: keep them 30 days only.
webhookEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export type WebhookEventAttrs = InferSchemaType<typeof webhookEventSchema>;
export const WebhookEvent = model('WebhookEvent', webhookEventSchema);
