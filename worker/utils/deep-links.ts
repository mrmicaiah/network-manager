/**
 * Deep Link Generator — SMS and Email deep links for mobile devices.
 *
 * Generates `sms:` and `mailto:` URIs with pre-filled content that open
 * native apps on both iOS and Android. Used by the message drafting flow
 * to let users tap a link and land in their SMS/email app with the
 * recipient, subject, and body already filled in.
 *
 * Cross-platform notes:
 *
 *   SMS:
 *     - iOS uses `sms:+1234567890&body=Hello` (ampersand separator)
 *     - Android uses `sms:+1234567890?body=Hello` (question mark separator)
 *     - We generate both variants; the caller picks based on device detection
 *       or uses the iOS format as the default (works on most platforms).
 *
 *   Email:
 *     - `mailto:` is universal across platforms.
 *     - Multiple recipients supported via comma separation.
 *     - Subject, body, cc, bcc all supported as query params.
 *
 * Usage:
 *
 *   const smsLink = generateSmsDeepLink('+15551234567', 'Hey! How are you?');
 *   // → "sms:+15551234567&body=Hey!%20How%20are%20you%3F"
 *
 *   const emailLink = generateEmailDeepLink({
 *     to: 'sarah@example.com',
 *     subject: 'Catching up',
 *     body: 'Hey Sarah, it\'s been a while!',
 *   });
 *   // → "mailto:sarah@example.com?subject=Catching%20up&body=Hey%20Sarah%2C..."
 *
 * @see worker/services/nudge-service.ts (consumer — nudge action links)
 */

// ===========================================================================
// Types
// ===========================================================================

/**
 * Platform hint for SMS deep link generation.
 * Affects the separator between phone number and body parameter.
 */
export type SmsPlatform = 'ios' | 'android' | 'auto';

/**
 * Options for generating an email deep link.
 */
export interface EmailDeepLinkOptions {
  /** Recipient email address */
  to: string;
  /** Email subject line */
  subject?: string;
  /** Email body text (plain text, not HTML) */
  body?: string;
  /** CC recipients (comma-separated or array) */
  cc?: string | string[];
  /** BCC recipients (comma-separated or array) */
  bcc?: string | string[];
}

// ===========================================================================
// SMS Deep Links
// ===========================================================================

/**
 * Generate an SMS deep link that opens the native messaging app
 * with a pre-filled recipient and optional message body.
 *
 * @param phoneNumber - E.164 format phone number (e.g., '+15551234567')
 * @param messageBody - Optional pre-filled message text
 * @param platform    - Target platform for separator style (default: 'ios')
 * @returns `sms:` URI string
 *
 * @example
 *   generateSmsDeepLink('+15551234567');
 *   // → "sms:+15551234567"
 *
 *   generateSmsDeepLink('+15551234567', 'Hey!', 'ios');
 *   // → "sms:+15551234567&body=Hey!"
 *
 *   generateSmsDeepLink('+15551234567', 'Hey!', 'android');
 *   // → "sms:+15551234567?body=Hey!"
 */
export function generateSmsDeepLink(
  phoneNumber: string,
  messageBody?: string,
  platform: SmsPlatform = 'ios',
): string {
  // Strip any non-phone characters except + at start
  const cleanPhone = cleanPhoneNumber(phoneNumber);

  if (!messageBody) {
    return `sms:${cleanPhone}`;
  }

  // iOS uses & separator, Android uses ? separator
  // 'auto' defaults to iOS format which has broader compatibility
  const separator = platform === 'android' ? '?' : '&';
  const encodedBody = encodeURIComponent(messageBody);

  return `sms:${cleanPhone}${separator}body=${encodedBody}`;
}

/**
 * Generate both iOS and Android SMS deep link variants.
 * Useful when the dashboard serves both platforms and the frontend
 * can pick the right one based on user agent detection.
 *
 * @param phoneNumber - E.164 format phone number
 * @param messageBody - Optional pre-filled message text
 * @returns Object with ios and android link variants
 */
export function generateSmsDeepLinks(
  phoneNumber: string,
  messageBody?: string,
): { ios: string; android: string } {
  return {
    ios: generateSmsDeepLink(phoneNumber, messageBody, 'ios'),
    android: generateSmsDeepLink(phoneNumber, messageBody, 'android'),
  };
}

// ===========================================================================
// Email Deep Links
// ===========================================================================

/**
 * Generate a mailto: deep link that opens the native email app
 * with pre-filled recipient, subject, body, and optional cc/bcc.
 *
 * @param options - Email link options (to, subject, body, cc, bcc)
 * @returns `mailto:` URI string
 *
 * @example
 *   generateEmailDeepLink({ to: 'sarah@example.com' });
 *   // → "mailto:sarah@example.com"
 *
 *   generateEmailDeepLink({
 *     to: 'sarah@example.com',
 *     subject: 'Catching up',
 *     body: 'Hey Sarah!\n\nHow have you been?',
 *   });
 *   // → "mailto:sarah@example.com?subject=Catching%20up&body=Hey%20Sarah!%0A%0AHow%20have%20you%20been%3F"
 */
export function generateEmailDeepLink(options: EmailDeepLinkOptions): string;
/**
 * Shorthand overload: generateEmailDeepLink(email, subject?, body?)
 */
export function generateEmailDeepLink(
  email: string,
  subject?: string,
  body?: string,
): string;
export function generateEmailDeepLink(
  emailOrOptions: string | EmailDeepLinkOptions,
  subject?: string,
  body?: string,
): string {
  // Normalize to options object
  const opts: EmailDeepLinkOptions =
    typeof emailOrOptions === 'string'
      ? { to: emailOrOptions, subject, body }
      : emailOrOptions;

  const params: string[] = [];

  if (opts.subject) {
    params.push(`subject=${encodeURIComponent(opts.subject)}`);
  }

  if (opts.body) {
    params.push(`body=${encodeURIComponent(opts.body)}`);
  }

  if (opts.cc) {
    const ccStr = Array.isArray(opts.cc) ? opts.cc.join(',') : opts.cc;
    params.push(`cc=${encodeURIComponent(ccStr)}`);
  }

  if (opts.bcc) {
    const bccStr = Array.isArray(opts.bcc) ? opts.bcc.join(',') : opts.bcc;
    params.push(`bcc=${encodeURIComponent(bccStr)}`);
  }

  const queryString = params.length > 0 ? `?${params.join('&')}` : '';
  return `mailto:${opts.to}${queryString}`;
}

// ===========================================================================
// Phone Call Deep Link (bonus utility)
// ===========================================================================

/**
 * Generate a tel: deep link that initiates a phone call.
 * Included as a natural companion to SMS links.
 *
 * @param phoneNumber - E.164 format phone number
 * @returns `tel:` URI string
 */
export function generateCallDeepLink(phoneNumber: string): string {
  return `tel:${cleanPhoneNumber(phoneNumber)}`;
}

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Clean a phone number for use in URI schemes.
 * Preserves the leading + and digits, strips everything else.
 */
function cleanPhoneNumber(phone: string): string {
  // Keep + at start and all digits
  const cleaned = phone.replace(/[^\d+]/g, '');

  // Ensure it starts with + if it had one originally
  if (phone.startsWith('+') && !cleaned.startsWith('+')) {
    return '+' + cleaned;
  }

  return cleaned;
}
