// util/mailer.ts — transactional email via Resend's HTTPS API.
// Resend works over HTTPS (port 443), which hosting providers don't block —
// unlike SMTP ports, which Render's free tier blocks entirely (Gmail SMTP
// was tried and fails with ETIMEDOUT).
// Config: RESEND_API_KEY, RESEND_FROM (e.g. "Quick Scheduling <noreply@yourdomain.com>").
// Until a domain is verified in Resend, use Resend's test sender.
// When RESEND_API_KEY is unset, email is unavailable and callers must
// degrade gracefully (see POST /api/users/:id/send-invite's 503 path).

/** Alias for sendMail — attachments are part of MailOptions. */
export const sendMailWithAttachment = sendMail;

/** True when the Resend API key is present. */
export function isMailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/** From address for outgoing mail. */
export function mailFrom(): string {
  return process.env.RESEND_FROM || 'Quick Scheduling <onboarding@resend.dev>';
}

export interface MailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: Buffer }[];
}

interface ResendError {
  message?: string;
  name?: string;
}

/** Send an email via Resend. Throws when not configured — callers decide how to degrade. */
export async function sendMail(opts: MailOptions): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Email sending is not set up yet.');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: mailFrom(),
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
      attachments: (opts.attachments || []).map(a => ({
        filename: a.filename,
        content: a.content.toString('base64'),
      })),
    }),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as ResendError;
      if (body && body.message) detail += ` ${body.message}`;
    } catch {
      // ignore JSON parse errors
    }
    throw new Error(`Resend rejected the email (${detail}).`);
  }
}

/** Escape user-controlled text for the HTML email body. */
export function escHtml(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
