'use strict';
/**
 * lib/email-templates.js — the bodies of the emails this service sends.
 *
 * Kept apart from lib/email.js on purpose: that module knows how to talk to a
 * provider and nothing about content, this one knows about content and nothing
 * about delivery. It is pure — same input, same strings, no I/O — so the tests
 * can assert on the exact wording without a network or a provider key.
 *
 * HTML RULES
 *   Email clients are not browsers. There is no <style> block, no external
 *   stylesheet, no web font, no flexbox and no grid, because Outlook and
 *   several mobile clients drop or mangle all of them. Everything is a table
 *   with inline styles, which is the only layout every client agrees on.
 *
 * THE APP, AND WHAT THE LINK CAN AND CANNOT PROMISE
 *   Vici Inbox is a native iPhone app distributed through TestFlight, and the
 *   accept URL is a Universal Link. On a phone with the app installed, tapping
 *   it opens the app. On any other device, or before the app is installed, it
 *   opens the same page in a browser. The copy must therefore say "once the app
 *   is installed" and never "this link opens the app" — an unconditional
 *   promise is false for the first tap of every single invitee, which is the
 *   one tap they all make, and it makes the product look broken at the exact
 *   moment somebody is deciding whether it works.
 *
 * NO TRACKING
 *   No pixel, no redirect wrapper, no per-recipient beacon. The only link in
 *   the message is the accept URL itself. Whether somebody opened an invitation
 *   is not information this product needs, and a tracking pixel in a mail that
 *   carries a credential is an invitation to a scanner to burn it.
 *
 * ROLES IN HUMAN WORDS
 *   The database key is `agent`; a person reads "Support Agent". The caller
 *   passes the display name from sms_roles when it has one, and `roleLabel()`
 *   is the fallback so a template can never render a raw key.
 */

/** Every value that reaches an HTML body goes through this first. */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Role key -> the words a human should see.
 * A key that is not in the map is title-cased rather than shown raw, so a role
 * added to the database before it is added here still reads as English.
 */
const ROLE_LABELS = Object.freeze({
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Support Agent',
  legacy: 'Team'
});

function roleLabel(roleKey, displayName) {
  const provided = String(displayName || '').trim();
  if (provided) return provided;
  const key = String(roleKey || '').trim().toLowerCase();
  if (ROLE_LABELS[key]) return ROLE_LABELS[key];
  if (!key) return 'Team Member';
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

/**
 * "Friday 29 August 2026 at 14:30 UTC". Always UTC and always spelled out:
 * the recipient's timezone is unknown, and an ISO string in a human sentence
 * reads as a fault rather than as a deadline.
 */
function formatExpiry(expiresAt) {
  const when = new Date(expiresAt);
  if (Number.isNaN(when.getTime())) return null;
  const formatted = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC'
  }).format(when);
  return `${formatted.replace(' at ', ' at ')} UTC`;
}

/**
 * The invitation email.
 *
 * @param {object} invite
 * @param {string} invite.inviteeName    who is being invited
 * @param {string} invite.inviterName    who invited them
 * @param {string} invite.workspaceName  the workspace they are joining
 * @param {string} invite.roleKey        e.g. 'agent'
 * @param {string} [invite.roleDisplayName]  e.g. 'Support Agent', from sms_roles
 * @param {string} invite.acceptUrl      ${APP_URL}/accept-invite?token=...
 *   Unchanged, and deliberately one URL for both jobs: it is the Universal Link
 *   iOS claims for the app (see lib/apple-site-association.js) AND the web page
 *   that answers when the app is not installed. A second "open in app" link
 *   would be a second thing to get wrong and would still not work any earlier.
 * @param {string} invite.expiresAt      ISO timestamp
 * @param {boolean} [invite.isResend]    softens the opening line on a re-send
 * @returns {{subject: string, text: string, html: string}}
 */
function invitationEmail(invite = {}) {
  const inviteeName = String(invite.inviteeName || '').trim();
  const inviterName = String(invite.inviterName || '').trim() || 'A teammate';
  const workspaceName = String(invite.workspaceName || '').trim() || 'Vici Inbox';
  const role = roleLabel(invite.roleKey, invite.roleDisplayName);
  const acceptUrl = String(invite.acceptUrl || '').trim();
  const expiry = formatExpiry(invite.expiresAt);
  const greeting = inviteeName ? `Hi ${inviteeName},` : 'Hi,';

  const subject = invite.isResend
    ? `Reminder: your invitation to ${workspaceName}`
    : `${inviterName} invited you to ${workspaceName}`;

  const expiryLine = expiry
    ? `This invitation expires on ${expiry}. After that the link stops working and you will need a new one.`
    : 'This invitation will expire, so please accept it soon.';

  const openingLine = invite.isResend
    ? `${inviterName} has sent your invitation to ${workspaceName} again.`
    : `${inviterName} has invited you to join ${workspaceName}.`;

  // Three sentences, in the order somebody actually needs them, and none of
  // them promising more than the link can deliver. "Once the app is installed"
  // is load-bearing: before that, the same link opens a web page, and saying
  // otherwise would make the first tap look like a fault.
  const appLine = `${workspaceName} is an iPhone app. You should also have an email from Apple `
    + 'inviting you to test it through TestFlight — install it from there first.';
  const linkLine = 'Once the app is installed, tapping the link below on your iPhone opens it '
    + 'straight in the app. On a computer, or before you install it, the same link opens in '
    + 'your browser and works exactly the same way.';

  const text = [
    greeting,
    '',
    `${openingLine} You have been given the ${role} role.`,
    '',
    appLine,
    '',
    'Accept your invitation and choose a password here:',
    acceptUrl,
    '',
    linkLine,
    '',
    expiryLine,
    '',
    'If you were not expecting this, you can ignore this email and nothing will happen.',
    '',
    `— ${workspaceName}`
  ].join('\n');

  const safe = {
    greeting: escapeHtml(greeting),
    opening: escapeHtml(openingLine),
    role: escapeHtml(role),
    workspace: escapeHtml(workspaceName),
    expiry: escapeHtml(expiryLine),
    app: escapeHtml(appLine),
    link: escapeHtml(linkLine),
    // Escaped for the href as well as the visible text. The token is base64url,
    // so it cannot itself contain a quote, but the URL is still attacker-
    // adjacent input and is never interpolated raw.
    url: escapeHtml(acceptUrl)
  };

  const html = [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safe.workspace}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background-color:#f4f4f5;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;padding:24px 12px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:8px;border:1px solid #e4e4e7;">',
    '<tr><td style="padding:32px 32px 8px 32px;font-family:Helvetica,Arial,sans-serif;font-size:20px;line-height:28px;font-weight:bold;color:#18181b;">',
    safe.workspace,
    '</td></tr>',
    '<tr><td style="padding:8px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#3f3f46;">',
    safe.greeting,
    '</td></tr>',
    '<tr><td style="padding:16px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#3f3f46;">',
    `${safe.opening} You have been given the <strong style="color:#18181b;">${safe.role}</strong> role.`,
    '</td></tr>',
    '<tr><td style="padding:16px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#3f3f46;">',
    safe.app,
    '</td></tr>',
    '<tr><td style="padding:24px 32px 0 32px;" align="left">',
    `<a href="${safe.url}" style="display:inline-block;background-color:#18181b;color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:bold;text-decoration:none;padding:14px 24px;border-radius:6px;">Accept your invitation</a>`,
    '</td></tr>',
    '<tr><td style="padding:20px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#71717a;">',
    'If the button does not work, copy and paste this link into your browser:<br>',
    `<a href="${safe.url}" style="color:#3f3f46;word-break:break-all;">${safe.url}</a>`,
    '</td></tr>',
    '<tr><td style="padding:20px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#71717a;">',
    safe.link,
    '</td></tr>',
    '<tr><td style="padding:20px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#71717a;">',
    safe.expiry,
    '</td></tr>',
    '<tr><td style="padding:16px 32px 32px 32px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#a1a1aa;border-top:1px solid #f4f4f5;">',
    'If you were not expecting this, you can ignore this email and nothing will happen.',
    '</td></tr>',
    '</table>',
    '</td></tr>',
    '</table>',
    '</body></html>'
  ].join('');

  return { subject, text, html };
}

module.exports = {
  invitationEmail,
  roleLabel,
  formatExpiry,
  escapeHtml,
  ROLE_LABELS
};
