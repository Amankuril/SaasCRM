import { logger } from '../lib/logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/**
 * Development mailer: prints emails to the server log. Swap for a Resend/SES-backed
 * implementation before production.
 */
class ConsoleMailer implements Mailer {
  async send(message: MailMessage): Promise<void> {
    logger.info({ to: message.to, subject: message.subject }, `[mail]\n${message.text}`);
  }
}

export const mailer: Mailer = new ConsoleMailer();
