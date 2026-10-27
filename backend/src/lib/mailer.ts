import nodemailer, { type Transporter } from 'nodemailer';
import { env, isProd } from '../config/env.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

let transporter: Transporter | undefined;

const smtpMailer: Mailer = {
  async send(message) {
    if (!env.SMTP_HOST) {
      if (isProd) throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Email is not set up on this server yet. Please contact support.');
      // Development without SMTP: the code is printed so logins still work locally.
      logger.warn({ to: message.to, subject: message.subject, text: message.text }, 'SMTP not configured; email printed instead of sent');
      return;
    }
    transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } : undefined,
    });
    try {
      await transporter.sendMail({ from: env.MAIL_FROM, ...message });
    } catch (err) {
      logger.error({ err, to: message.to }, 'Email send failed');
      throw new AppError(502, 'EMAIL_SEND_FAILED', 'We could not send the email. Please try again in a minute.');
    }
  },
};

let mailer: Mailer = smtpMailer;
export const getMailer = () => mailer;
/** Tests capture emails instead of sending them; undefined restores SMTP. */
export function setMailer(m: Mailer | undefined) {
  mailer = m ?? smtpMailer;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The login code email: plain text plus a simple, client-safe HTML version. */
export function loginCodeEmail(to: string, name: string, code: string, minutes: number, device: string): MailMessage {
  const text = `Hi ${name},\n\nYour Zeta Connect login code is ${code}.\nIt expires in ${minutes} minutes.\n\nRequested from: ${device}\n\nIf this wasn't you, change your password; someone knows it.`;
  const html = `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border-radius:16px;padding:32px">
<tr><td style="font-size:18px;font-weight:bold;color:#059669">Zeta Connect</td></tr>
<tr><td style="padding-top:20px;font-size:15px">Hi ${escapeHtml(name)},</td></tr>
<tr><td style="padding-top:8px;font-size:15px;color:#475569">Use this code to finish logging in:</td></tr>
<tr><td align="center" style="padding:24px 0"><div style="display:inline-block;font-size:32px;letter-spacing:10px;font-weight:bold;background:#ecfdf5;color:#065f46;border-radius:12px;padding:14px 22px">${code}</div></td></tr>
<tr><td style="font-size:13px;color:#64748b">It expires in ${minutes} minutes. Requested from ${escapeHtml(device)}.</td></tr>
<tr><td style="padding-top:16px;font-size:13px;color:#64748b">If this wasn't you, change your password; someone knows it.</td></tr>
</table></td></tr></table></body></html>`;
  return { to, subject: `${code} is your Zeta Connect login code`, text, html };
}
