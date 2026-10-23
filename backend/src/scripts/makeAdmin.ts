/**
 * Grants platform super-admin to an existing account:
 *   npm run make-admin -w backend -- someone@example.com
 */
import '../loadEnv.js';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../db/connect.js';
import { User } from '../modules/auth/user.model.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: npm run make-admin -w backend -- <email>');
  process.exit(1);
}

await connectDatabase(env.MONGODB_URI);
const user = await User.findOneAndUpdate({ email }, { isPlatformAdmin: true }, { new: true });
console.log(user ? `${user.email} is now a platform admin.` : `No user found with email ${email}. Sign up first.`);
await disconnectDatabase();
process.exit(user ? 0 : 1);
