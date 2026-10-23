import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/** A refresh-token session. Only token hashes are stored; rotated on every refresh. */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    // The hash that was just rotated out: presenting it again means the token was stolen.
    previousTokenHash: { type: String, default: null, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: () => new Date() },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true },
);

// MongoDB removes sessions automatically once they expire.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type SessionDoc = HydratedDocument<InferSchemaType<typeof sessionSchema>>;
export const Session = model('Session', sessionSchema);
