// util/mailer.ts — SMTP email via nodemailer.
// Current provider: Gmail SMTP (temporary — Resend is the planned long-term
// provider). Gmail config: SMTP_HOST=smtp.gmail.com, SMTP_PORT=587,
// SMTP_SECURE=false (STARTTLS), SMTP_USER/SMTP_PASS (Gmail address + App
// Password — NOT the regular Gmail password). The From address defaults to
// SMTP_USER (Gmail requires it to match the account).
// When SMTP_HOST/SMTP_USER are unset, email is unavailable and callers must
// degrade gracefully (see POST /api/users/:id/send-invite's 503 path).

import nodemailer from 'nodemailer';

/** True when the minimum SMTP config is present. */
export function isMailConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER);
}

/** From address: explicit SMTP_FROM, else SMTP_USER (what Gmail requires). */
export function mailFrom(): string {
  return process.env.SMTP_FROM || process.env.SMTP_USER || '';
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!isMailConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? '' }
        : undefined,
    });
  }
  return transporter;
}

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** Send an email. Throws when SMTP is not configured — callers decide how to degrade. */
export async function sendMail(opts: MailOptions): Promise<void> {
  const t = getTransporter();
  if (!t) throw new Error('Email sending is not set up yet.');
  await t.sendMail({
    from: mailFrom(),
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
  });
}

/** Escape user-controlled text for the HTML email body. */
export function escHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
