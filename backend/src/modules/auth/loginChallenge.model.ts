import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

/**
 * Second step of a business login: the password was right and a 6-digit code
 * was emailed. Only hashes are stored. The challenge token (kept by the
 * browser) ties the code to that login attempt.
 */
const loginChallengeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    sends: { type: Number, default: 1 },
    lastSentAt: { type: Date, default: () => new Date() },
    // Set once the code was right; a "log in here" retry then needs no new code.
    verifiedAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    userAgent: { type: String, default: null },
    ip: { type: String, default: null },
  },
  { timestamps: true },
);
loginChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export type LoginChallengeDoc = HydratedDocument<InferSchemaType<typeof loginChallengeSchema>>;
export const LoginChallenge = model('LoginChallenge', loginChallengeSchema);

/** Failed password attempts per email; locks the email for a while after too many. */
const loginThrottleSchema = new Schema({
  key: { type: String, required: true, unique: true },
  failures: { type: Number, default: 0 },
  lockedUntil: { type: Date, default: null },
  // Removed by MongoDB a day after the last failure.
  lastFailureAt: { type: Date, default: () => new Date(), expires: 24 * 60 * 60 },
});
export const LoginThrottle = model('LoginThrottle', loginThrottleSchema);
