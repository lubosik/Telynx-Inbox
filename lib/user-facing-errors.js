'use strict';
/**
 * lib/user-facing-errors.js — what a person is allowed to be shown when
 * something goes wrong.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS
 *
 *   Approving a campaign put this on the owner's phone:
 *
 *       Campaign error
 *       createCoupons requires an array of coupon specs.
 *
 *   That is a sentence written for whoever is editing woocommerce-coupons.js.
 *   To the person holding the phone it says nothing about what happened, what
 *   it cost, or what to do, and it is faintly alarming in a way the actual
 *   problem did not warrant.
 *
 *   The route's error handler passed `error.message` straight through for any
 *   error carrying a `status`, and CouponRequestError carries 400. So every
 *   internal validation message in the coupon module, the personalisation
 *   module and anything else with a status was one throw away from the screen.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * DEFAULT DENY, THE SAME AS THE ROUTE POLICY
 *
 *   A message is shown only if its code is on the list below. Everything else,
 *   including everything written in future, becomes a generic sentence and a
 *   reference. That way a new internal error is quiet by default rather than
 *   leaking until somebody notices.
 *
 * WHAT EARNS A PLACE ON THE LIST
 *
 *   One question: can the person reading it do something about it? "Deselect
 *   the three recipients who cannot be personalised" can. "Only 3 people are
 *   eligible and a campaign needs 25" can. "createCoupons requires an array"
 *   cannot, and neither can "column sms_sent_log.created_at does not exist".
 *
 * THE REFERENCE IS THE POINT OF THE GENERIC MESSAGE
 *
 *   "Something went wrong" with nothing else is worse than the leak: the owner
 *   cannot report it and nobody can find it. Every hidden error is logged in
 *   full against a short reference, and the reference is what appears on
 *   screen, so "quote VIC-8F3K2A" turns a dead end into a grep.
 */

const crypto = require('node:crypto');

/**
 * Families of code whose messages are written for the person reading them.
 *
 * A first version listed thirty codes by hand and downgraded a hundred and
 * sixty others, turning real 4xx answers like "this segment matches nobody"
 * and "value out of range for lifetime spend" into "something went wrong".
 * That is not safety, it is a worse app.
 *
 * These prefixes are the families whose members are feedback on something the
 * person did: a rule they wrote, a body they sent, a state they can change.
 * A code outside every family is unknown and therefore hidden, so default deny
 * survives.
 */
const USER_FACING_FAMILIES = [
  'CAMPAIGN_', 'SEGMENT_', 'PROPOSAL_', 'OPPORTUNITY_',
  'RULE_SET_', 'CONDITION_', 'DIMENSION_', 'OPERATOR_', 'ENUM_', 'VALUE_',
  'LABEL_', 'LIST_', 'PRODUCT_', 'AUDIENCE_', 'SEGMENTS_', 'SUGGESTION_',
  'MESSAGE_', 'BRIEF_', 'UNKNOWN_RECIPE', 'INVALID_', 'ALL_DRAFTS_REJECTED'
];

/**
 * ...except these, which are faults rather than feedback.
 *
 * This codebase names a fault consistently: something FAILED, something is an
 * ERROR, a read was TRUNCATED, a dependency is UNAVAILABLE. Their messages
 * name functions, columns and tables, and none of them tells a person what to
 * do. The deny patterns win over the families above.
 *
 * COUPON_ and PERSONALISATION_ are denied wholesale. Every message in those
 * modules is written for whoever is editing them, and one of them is the
 * sentence that reached the owner's phone.
 */
const INTERNAL_PATTERNS = [
  /_FAILED$/, /_ERROR$/, /_UNAVAILABLE$/, /_TRUNCATED$/,
  /DATABASE/, /^PGRST/, /^COUPON_/, /^PERSONALISATION_/,
  /_LOAD_/, /_PERSIST_/, /_UNPARSEABLE$/, /_UNIMPLEMENTED$/
];

/** Whether this code's own message may be shown. */
function isUserFacing(code) {
  if (!code || typeof code !== 'string') return false;
  if (INTERNAL_PATTERNS.some(pattern => pattern.test(code))) return false;
  return USER_FACING_FAMILIES.some(family => code.startsWith(family));
}

/**
 * A short, sayable reference. Six characters from a random 32-bit draw, in an
 * alphabet with no O/0 or I/1, because this gets read down a phone.
 */
const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newReference() {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (const byte of bytes) out += REFERENCE_ALPHABET[byte % REFERENCE_ALPHABET.length];
  return `VIC-${out}`;
}

/**
 * Decide what to show, and log what is hidden.
 *
 * `action` is what the person was trying to do, in their words: "approving
 * this campaign", "planning a campaign". It goes in the generic message so the
 * sentence describes their situation rather than the server's.
 */
function presentError(error, { action = 'doing that', logger = console } = {}) {
  const code = error?.code || null;
  const status = Number(error?.status) || 500;

  if (isUserFacing(code)) {
    return { status, body: { error: error.message, code } };
  }

  // Hidden. Logged in full, including the stack, against a reference the owner
  // can quote. Without the reference this is an unreportable dead end.
  const reference = newReference();
  logger.error(
    `[ERROR ${reference}] while ${action}: ${code || 'no_code'} ${error?.message || 'no message'}`,
    error?.stack || ''
  );

  return {
    status: status >= 500 ? status : 500,
    body: {
      // Deliberately claims nothing about what did or did not happen. A
      // failure during approval may have minted coupons before it threw, and
      // a reassuring "nothing was changed" that turns out to be false is
      // worse than saying less.
      error: `Something went wrong while ${action}. `
        + `Send this reference to Lubosi and he can find it: ${reference}`,
      code: 'INTERNAL_ERROR',
      reference
    }
  };
}

module.exports = {
  INTERNAL_PATTERNS,
  REFERENCE_ALPHABET,
  USER_FACING_FAMILIES,
  isUserFacing,
  newReference,
  presentError
};
