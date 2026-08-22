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

/**
 * The shared card shell for the email-change messages below.
 *
 * invitationEmail() deliberately keeps its own hand-written markup: it is the
 * one message with a call-to-action button and a different rhythm, and folding
 * it into this helper would mean editing a live, working template to add a
 * feature that does not need it.
 *
 * Every value passed in must ALREADY be escaped. The parameter is named
 * `safeParagraphs` rather than `paragraphs` so a caller cannot pass raw text by
 * accident and have it read correctly.
 *
 * @param {object} parts
 * @param {string} parts.safeTitle       escaped
 * @param {string[]} parts.safeParagraphs escaped, one <td> each
 * @param {string} [parts.safeFooter]    escaped, rendered above a rule
 */
function cardShell({ safeTitle, safeParagraphs, safeFooter }) {
  const rows = safeParagraphs.map((paragraph, index) => [
    `<tr><td style="padding:${index === 0 ? '8px' : '16px'} 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;color:#3f3f46;">`,
    paragraph,
    '</td></tr>'
  ].join('')).join('');

  const footer = safeFooter
    ? '<tr><td style="padding:20px 32px 32px 32px;font-family:Helvetica,Arial,sans-serif;'
      + 'font-size:13px;line-height:20px;color:#a1a1aa;border-top:1px solid #f4f4f5;">'
      + safeFooter + '</td></tr>'
    : '<tr><td style="padding:0 32px 32px 32px;"></td></tr>';

  return [
    '<!doctype html>',
    '<html><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${safeTitle}</title>`,
    '</head>',
    '<body style="margin:0;padding:0;background-color:#f4f4f5;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f5;padding:24px 12px;">',
    '<tr><td align="center">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background-color:#ffffff;border-radius:8px;border:1px solid #e4e4e7;">',
    '<tr><td style="padding:32px 32px 8px 32px;font-family:Helvetica,Arial,sans-serif;font-size:20px;line-height:28px;font-weight:bold;color:#18181b;">',
    safeTitle,
    '</td></tr>',
    rows,
    footer,
    '</table>',
    '</td></tr>',
    '</table>',
    '</body></html>'
  ].join('');
}

/** `Hi Sarah,` or `Hi,`. */
function greetingFor(name) {
  const trimmed = String(name || '').trim();
  return trimmed ? `Hi ${trimmed},` : 'Hi,';
}

/**
 * Sent TO THE NEW ADDRESS. The only message in this file that carries a live
 * credential, and the only one with a link.
 *
 * Nothing has changed on the account when this is sent, and the copy says so in
 * as many words. That is not politeness: if this message reaches somebody who
 * did not ask for it, the useful thing to tell them is that ignoring it is
 * sufficient, because the change cannot complete without this exact link.
 *
 * The OLD address is never named here. Whoever holds the new mailbox may be a
 * stranger — that is precisely the case this confirmation exists to catch — and
 * they have no business learning which account is trying to move onto it.
 *
 * @param {object} change
 * @param {string} [change.recipientName]
 * @param {string} change.newEmail
 * @param {string} change.confirmUrl   ${APP_URL}/confirm-email-change?token=...
 * @param {string} change.expiresAt    ISO timestamp
 * @param {string} [change.workspaceName]
 * @returns {{subject: string, text: string, html: string}}
 */
function emailChangeConfirmationEmail(change = {}) {
  const workspaceName = String(change.workspaceName || '').trim() || 'Vici Inbox';
  const newEmail = String(change.newEmail || '').trim();
  const confirmUrl = String(change.confirmUrl || '').trim();
  const expiry = formatExpiry(change.expiresAt);
  const greeting = greetingFor(change.recipientName);

  const subject = `Confirm your new email address for ${workspaceName}`;
  const openingLine = `Somebody asked to move a ${workspaceName} account onto this address `
    + `(${newEmail}). Nothing has changed yet, and nothing will change until you open the link below.`;
  const expiryLine = expiry
    ? `This link expires on ${expiry}. After that it stops working and the change has to be started again.`
    : 'This link expires shortly, so please use it soon.';
  const ignoreLine = 'If you were not expecting this, ignore this email. The address stays where it is '
    + 'and no account gains access to this mailbox.';

  const text = [
    greeting,
    '',
    openingLine,
    '',
    'Confirm the change here:',
    confirmUrl,
    '',
    expiryLine,
    '',
    ignoreLine,
    '',
    `— ${workspaceName}`
  ].join('\n');

  const safe = {
    title: escapeHtml(workspaceName),
    greeting: escapeHtml(greeting),
    opening: escapeHtml(openingLine),
    expiry: escapeHtml(expiryLine),
    ignore: escapeHtml(ignoreLine),
    // Escaped for the href as well as the visible text. The token is base64url
    // and cannot contain a quote, but the URL is never interpolated raw.
    url: escapeHtml(confirmUrl)
  };

  const html = cardShell({
    safeTitle: safe.title,
    safeParagraphs: [
      safe.greeting,
      safe.opening,
      `<a href="${safe.url}" style="display:inline-block;background-color:#18181b;color:#ffffff;`
        + 'font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:bold;'
        + 'text-decoration:none;padding:14px 24px;border-radius:6px;">Confirm this address</a>',
      'If the button does not work, copy and paste this link into your browser:<br>'
        + `<a href="${safe.url}" style="color:#3f3f46;word-break:break-all;">${safe.url}</a>`,
      safe.expiry
    ],
    safeFooter: safe.ignore
  });

  return { subject, text, html };
}

/**
 * Sent TO THE CURRENT ADDRESS the moment a change is requested.
 *
 * This is the message that makes a hijack visible to its victim. It carries NO
 * LINK and no token, on purpose: it goes to a mailbox that may already be in
 * somebody else's hands, and the one thing it must not contain is a way to
 * complete the change. It names the new address, because "somebody is moving
 * your account somewhere" is useless without "to where", and it says plainly
 * what to do about it.
 *
 * @param {object} change
 * @param {string} [change.recipientName]
 * @param {string} change.newEmail
 * @param {string} change.expiresAt
 * @param {string} [change.workspaceName]
 * @returns {{subject: string, text: string, html: string}}
 */
function emailChangeNoticeEmail(change = {}) {
  const workspaceName = String(change.workspaceName || '').trim() || 'Vici Inbox';
  const newEmail = String(change.newEmail || '').trim();
  const expiry = formatExpiry(change.expiresAt);
  const greeting = greetingFor(change.recipientName);

  const subject = `Someone asked to change your ${workspaceName} email address`;
  const openingLine = `A request was made to change the email address on your ${workspaceName} `
    + `account to ${newEmail}. A confirmation link has been sent to that address.`;
  const nothingYetLine = 'Nothing has changed yet. The address only moves once that link is opened, '
    + `so until then you keep signing in exactly as you do today.${expiry ? ` The request expires on ${expiry}.` : ''}`;
  const actionLine = 'If this was you, there is nothing to do here. If it was NOT you, sign in now, '
    + 'cancel the pending change from your profile, and change your password. Then tell an admin, '
    + 'because somebody reached your session.';

  const text = [
    greeting,
    '',
    openingLine,
    '',
    nothingYetLine,
    '',
    actionLine,
    '',
    `— ${workspaceName}`
  ].join('\n');

  const html = cardShell({
    safeTitle: escapeHtml(workspaceName),
    safeParagraphs: [
      escapeHtml(greeting),
      escapeHtml(openingLine),
      escapeHtml(nothingYetLine)
    ],
    safeFooter: escapeHtml(actionLine)
  });

  return { subject, text, html };
}

/**
 * Sent TO BOTH the old and the new address when an ADMIN corrects somebody
 * else's address. There is no confirmation step on that path — it is an
 * administrative correction of a typo, not a self-service change — so this is
 * the only notification either mailbox gets, and it describes something that
 * has ALREADY happened.
 *
 * One template for both recipients, deliberately. Two variants would be two
 * things to keep in step, and there is nothing in the old-address copy that the
 * new address must not see: an admin who can perform this already knows both
 * addresses.
 *
 * @param {object} change
 * @param {string} [change.recipientName]
 * @param {string} change.previousEmail
 * @param {string} change.newEmail
 * @param {string} [change.actorName]  the admin who made the change
 * @param {string} [change.workspaceName]
 * @returns {{subject: string, text: string, html: string}}
 */
function emailChangedByAdminEmail(change = {}) {
  const workspaceName = String(change.workspaceName || '').trim() || 'Vici Inbox';
  const previousEmail = String(change.previousEmail || '').trim();
  const newEmail = String(change.newEmail || '').trim();
  const actor = String(change.actorName || '').trim() || 'An admin';
  const greeting = greetingFor(change.recipientName);

  const subject = `Your ${workspaceName} email address was changed`;
  const openingLine = `${actor} changed the email address on your ${workspaceName} account `
    + `from ${previousEmail} to ${newEmail}.`;
  const effectLine = `Sign in with ${newEmail} from now on. Your password has not changed. `
    + 'Any other device you were signed in on will ask you to sign in again.';
  const actionLine = 'If you were not expecting this, contact an admin straight away. '
    + 'An address change is how account recovery starts.';

  const text = [
    greeting,
    '',
    openingLine,
    '',
    effectLine,
    '',
    actionLine,
    '',
    `— ${workspaceName}`
  ].join('\n');

  const html = cardShell({
    safeTitle: escapeHtml(workspaceName),
    safeParagraphs: [
      escapeHtml(greeting),
      escapeHtml(openingLine),
      escapeHtml(effectLine)
    ],
    safeFooter: escapeHtml(actionLine)
  });

  return { subject, text, html };
}

/**
 * Sent TO AN ADDRESS SOMEBODY TRIED TO MOVE ONTO while it is already registered
 * to another account.
 *
 * This exists so that `POST /api/users/me/email` can answer identically whether
 * or not the requested address is already taken. The alternative — a 409 that
 * says "that address exists" — turns an endpoint any Support Agent can call
 * into an account-existence oracle for the whole workspace.
 *
 * So the collision path sends a real email to a real interested party, which
 * keeps the response honest ("we sent two messages" is true on both paths)
 * without telling the caller which path they were on. It carries no link and
 * names no other account.
 *
 * @param {object} change
 * @param {string} change.newEmail
 * @param {string} [change.workspaceName]
 * @returns {{subject: string, text: string, html: string}}
 */
function emailChangeAddressInUseEmail(change = {}) {
  const workspaceName = String(change.workspaceName || '').trim() || 'Vici Inbox';
  const newEmail = String(change.newEmail || '').trim();

  const subject = `Someone tried to use this address for ${workspaceName}`;
  const openingLine = `Somebody asked to move a ${workspaceName} account onto this address `
    + `(${newEmail}). It was refused, because this address already belongs to an account here.`;
  const effectLine = 'Nothing has changed, and no confirmation link was issued. '
    + 'If that was you, sign in with this address instead of moving another account onto it.';
  const actionLine = 'If it was not you, no action is needed. Nobody gained access to anything.';

  const text = [
    'Hi,',
    '',
    openingLine,
    '',
    effectLine,
    '',
    actionLine,
    '',
    `— ${workspaceName}`
  ].join('\n');

  const html = cardShell({
    safeTitle: escapeHtml(workspaceName),
    safeParagraphs: [
      'Hi,',
      escapeHtml(openingLine),
      escapeHtml(effectLine)
    ],
    safeFooter: escapeHtml(actionLine)
  });

  return { subject, text, html };
}

/**
 * The forgotten-password email.
 *
 * PLAIN AND SHORT ON PURPOSE
 *   Five lines: who it is for, that somebody asked for a reset, the link, when
 *   it dies, and what to do if it was not them. Anything else in a message that
 *   carries a live credential is either noise or a place for a mistake to hide.
 *
 * THE "IGNORE THIS" LINE IS NOT BOILERPLATE
 *   Most people who receive this did not ask for it, because the request
 *   endpoint is public and takes any address. That line is the whole of their
 *   experience of this feature, so it says explicitly that their password has
 *   NOT changed rather than the vaguer "nothing will happen".
 *
 * NO NAME IS REQUIRED
 *   `recipientName` is optional and the greeting degrades to "Hi,". The
 *   template must never render a placeholder, an empty pair of brackets, or the
 *   word "undefined" into a security email.
 *
 * @param {object} reset
 * @param {string} [reset.recipientName]
 * @param {string} [reset.workspaceName]
 * @param {string} reset.resetUrl    ${APP_URL}/reset-password?token=...
 * @param {string} [reset.expiresAt] ISO timestamp, shown as an absolute UTC time
 * @param {number} [reset.expiryMinutes]
 * @returns {{subject: string, text: string, html: string}}
 */
function passwordResetEmail(reset = {}) {
  const recipientName = String(reset.recipientName || '').trim();
  const workspaceName = String(reset.workspaceName || '').trim() || 'Vici Inbox';
  const resetUrl = String(reset.resetUrl || '').trim();
  const minutes = Number.isFinite(Number(reset.expiryMinutes)) && Number(reset.expiryMinutes) > 0
    ? Math.round(Number(reset.expiryMinutes))
    : 60;
  const expiry = formatExpiry(reset.expiresAt);
  const greeting = recipientName ? `Hi ${recipientName},` : 'Hi,';

  const subject = `Reset your ${workspaceName} password`;

  const openingLine = `Someone asked to reset the password for your ${workspaceName} account.`;

  // Both forms of the deadline. The relative one is what a person acts on, the
  // absolute one is what they check when they come back to the message later.
  const expiryLine = expiry
    ? `This link expires in ${minutes} minutes, at ${expiry}. After that it stops working and you can ask for another one.`
    : `This link expires in ${minutes} minutes. After that it stops working and you can ask for another one.`;

  const ignoreLine = 'If you did not ask for this, you can ignore this email. '
    + 'Your password has not changed and nobody has been given access to your account.';

  const text = [
    greeting,
    '',
    openingLine,
    '',
    'Choose a new password here:',
    resetUrl,
    '',
    expiryLine,
    '',
    ignoreLine,
    '',
    `From ${workspaceName}`
  ].join('\n');

  const safe = {
    greeting: escapeHtml(greeting),
    opening: escapeHtml(openingLine),
    workspace: escapeHtml(workspaceName),
    expiry: escapeHtml(expiryLine),
    ignore: escapeHtml(ignoreLine),
    // Escaped for the href as well as the visible text. The token is base64url
    // and cannot contain a quote, but the URL is never interpolated raw.
    url: escapeHtml(resetUrl)
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
    safe.opening,
    '</td></tr>',
    '<tr><td style="padding:24px 32px 0 32px;" align="left">',
    `<a href="${safe.url}" style="display:inline-block;background-color:#18181b;color:#ffffff;font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:20px;font-weight:bold;text-decoration:none;padding:14px 24px;border-radius:6px;">Choose a new password</a>`,
    '</td></tr>',
    '<tr><td style="padding:20px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#71717a;">',
    'If the button does not work, copy and paste this link into your browser:<br>',
    `<a href="${safe.url}" style="color:#3f3f46;word-break:break-all;">${safe.url}</a>`,
    '</td></tr>',
    '<tr><td style="padding:20px 32px 0 32px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#71717a;">',
    safe.expiry,
    '</td></tr>',
    '<tr><td style="padding:16px 32px 32px 32px;font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:20px;color:#a1a1aa;border-top:1px solid #f4f4f5;">',
    safe.ignore,
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
  passwordResetEmail,
  emailChangeConfirmationEmail,
  emailChangeNoticeEmail,
  emailChangedByAdminEmail,
  emailChangeAddressInUseEmail,
  roleLabel,
  formatExpiry,
  escapeHtml,
  ROLE_LABELS
};
