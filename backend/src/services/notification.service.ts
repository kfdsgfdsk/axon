/**
 * Security / account-activity notifications.
 *
 * Currently logs structured events. Wire a real email/SMS provider in
 * sendEmail() / sendSms() for production. Callers MUST NOT block the
 * request path on delivery failures.
 */
import logger from '../utils/logger';
import config from '../config';

export type SecurityEvent =
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'password_changed'
  | 'new_session'
  | 'login_failed_lockout'
  | '2fa_enabled'
  | '2fa_disabled'
  | '2fa_backup_regenerated'
  | 'withdrawal_address_added'
  | 'withdrawal_requested'
  | 'role_changed'
  | 'email_verification_sent'
  | 'email_changed';

export interface NotifyPayload {
  userId?: string;
  email?: string;
  ip?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
}

async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<void> {
  // Production: integrate SMTP / SES / SendGrid / Postmark here using config.smtp
  if (!config.isProdLike) {
    logger.info('[DEV] security email', { to, subject, body: body.slice(0, 200) });
    return;
  }
  if (!(config as { twofa?: { smtp?: unknown } }).twofa?.smtp && !process.env.SMTP_HOST) {
    logger.warn('SMTP not configured — security email not delivered', { to, subject });
    return;
  }
  // Placeholder: replace with real transport
  logger.info('security email queued', { to, subject });
}

/**
 * Fire-and-forget security notification. Never throws to callers.
 */
export async function notifySecurityEvent(
  event: SecurityEvent,
  payload: NotifyPayload
): Promise<void> {
  try {
    logger.info('security_event', { event, ...payload });

    const email = payload.email;
    if (!email) return;

    const subjects: Partial<Record<SecurityEvent, string>> = {
      password_reset_requested: 'Password reset requested',
      password_reset_completed: 'Your password was changed',
      password_changed: 'Your password was changed',
      new_session: 'New sign-in to your account',
      login_failed_lockout: 'Multiple failed login attempts',
      '2fa_enabled': 'Two-factor authentication enabled',
      '2fa_disabled': 'Two-factor authentication disabled',
      '2fa_backup_regenerated': 'Backup codes regenerated',
      withdrawal_address_added: 'New withdrawal address added',
      withdrawal_requested: 'Withdrawal requested',
      role_changed: 'Account role changed',
      email_verification_sent: 'Verify your email',
      email_changed: 'Your email was changed',
    };

    const subject = subjects[event] || `Account activity: ${event}`;
    const lines = [
      `Event: ${event}`,
      payload.ip ? `IP: ${payload.ip}` : null,
      payload.userAgent ? `User-Agent: ${payload.userAgent}` : null,
      payload.meta ? `Details: ${JSON.stringify(payload.meta)}` : null,
      '',
      'If this was not you, reset your password and contact support immediately.',
    ].filter(Boolean);

    await sendEmail(email, subject, lines.join('\n'));
  } catch (e) {
    logger.warn('notifySecurityEvent failed', { event, error: String(e) });
  }
}
