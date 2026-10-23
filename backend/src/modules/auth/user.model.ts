import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    isPlatformAdmin: { type: Boolean, default: false },
    emailVerifiedAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export type UserAttrs = InferSchemaType<typeof userSchema>;
export type UserDoc = HydratedDocument<UserAttrs>;

export const User = model('User', userSchema);

export function toPublicUser(user: UserDoc) {
  return {
    id: user.id as string,
    name: user.name,
    email: user.email,
    isPlatformAdmin: user.isPlatformAdmin,
    emailVerified: Boolean(user.emailVerifiedAt),
    createdAt: user.createdAt,
  };
}
