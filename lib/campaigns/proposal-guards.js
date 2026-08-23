'use strict';
/**
 * lib/campaigns/proposal-guards.js — the two refusals this feature is built
 * around, written as pure functions so they can be tested, mutated and proved.
 *
 * WHY THEY LIVE IN THEIR OWN FILE
 *   Both guards are called from more than one place on purpose — the writer,
 *   the service and the route each apply them, so removing one call site does
 *   not open the gate. A guard scattered as three inline `if` statements
 *   cannot be mutation-tested as a unit and cannot be found by somebody
 *   auditing "what stops this thing sending a message". These can.
 *
 * GUARD ONE — assertSurfaceable
 *   A proposal whose drafted copy did not pass lib/campaigns/copy-validator.js
 *   is never shown to a human, never persisted, and never returned by an API.
 *   It is not repaired, not truncated, and not shown with a warning: a
 *   reviewer who can see the text of a rejected draft can paste it into a
 *   campaign, and at that point the validator was decoration. The refusal is
 *   surfaced as check identity only.
 *
 * GUARD TWO — assertHumanAcceptance
 *   A proposal becomes a campaign draft only when a named, authenticated human
 *   accepts it. Not when it is generated, not when it is saved, not when it is
 *   read, and not on a timer. There is no code path in this feature that
 *   creates a campaign without passing through this function, and the caller
 *   must ALSO win a compare-and-swap on the stored row, so two clicks cannot
 *   produce two campaigns.
 *
 * NEITHER GUARD IS THE LAST ONE
 *   An accepted proposal produces a campaign in `draft`. It still has to pass
 *   the existing submit, review, approve, schedule and delivery brakes, every
 *   one of which is somebody else's code and none of which this feature
 *   touches. Accepting a proposal is not approving a campaign and is certainly
 *   not sending one.
 */

class ProposalGuardError extends Error {
  constructor(message, code, status = 409) {
    super(message);
    this.name = 'ProposalGuardError';
    this.code = code;
    this.status = status;
  }
}

/** The only status from which a proposal may be accepted or dismissed. */
const OPEN_STATUS = 'proposed';
const TERMINAL_STATUSES = Object.freeze(['accepted', 'dismissed']);
const PROPOSAL_STATUSES = Object.freeze([OPEN_STATUS, ...TERMINAL_STATUSES]);

const MIN_DISMISSAL_REASON = 4;
const MAX_DISMISSAL_REASON = 500;

/**
 * May this proposal be shown to a person?
 *
 * Every condition is spelled out separately and none is combined with `||`,
 * so a mutation to any single one is caught by its own test rather than being
 * masked by a neighbouring clause.
 *
 * @param {object} proposal
 * @throws {ProposalGuardError}
 */
function assertSurfaceable(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    throw new ProposalGuardError('A proposal must be an object.', 'PROPOSAL_MALFORMED', 500);
  }
  const copy = proposal.copy;
  if (!copy || typeof copy !== 'object') {
    throw new ProposalGuardError(
      'A proposal with no drafted copy is not surfaceable.',
      'PROPOSAL_COPY_MISSING', 500
    );
  }
  if (copy.validated !== true) {
    throw new ProposalGuardError(
      'This proposal was never put through the copy validator, so it is not surfaceable.',
      'PROPOSAL_COPY_UNVALIDATED', 500
    );
  }
  if (typeof copy.text !== 'string' || !copy.text.trim()) {
    throw new ProposalGuardError(
      'This proposal carries no message text.',
      'PROPOSAL_COPY_EMPTY', 500
    );
  }
  if (!Array.isArray(copy.failedChecks)) {
    throw new ProposalGuardError(
      'This proposal carries no record of which copy checks ran.',
      'PROPOSAL_COPY_UNVALIDATED', 500
    );
  }
  if (copy.failedChecks.length !== 0) {
    throw new ProposalGuardError(
      `This proposal's copy failed ${copy.failedChecks.length} compliance check(s) and is never shown.`,
      'PROPOSAL_COPY_REJECTED', 500
    );
  }
  return true;
}

/**
 * True/false form of the same rule, for filtering a batch.
 *
 * It calls the assertion rather than repeating its conditions, because two
 * implementations of one rule drift and the drift is always in the permissive
 * direction.
 */
function isSurfaceable(proposal) {
  try {
    return assertSurfaceable(proposal);
  } catch (error) {
    if (error instanceof ProposalGuardError) return false;
    /* istanbul ignore next — anything else is a bug, not a rejection. */
    throw error;
  }
}

/**
 * May this stored proposal become a campaign draft, for this actor, now?
 *
 * @param {object} proposal   the row as loaded, not as posted by a client
 * @param {object} actor      req.actor, resolved server-side from the database
 * @throws {ProposalGuardError}
 */
function assertHumanAcceptance(proposal, actor) {
  if (!proposal || typeof proposal !== 'object') {
    throw new ProposalGuardError('A proposal must be an object.', 'PROPOSAL_MALFORMED', 500);
  }
  // A named human. `req.actor` is rebuilt from the database on every request,
  // including for the shared legacy identity, which is a real row with a real
  // id. A null id means nobody is attributable and the acceptance does not
  // happen.
  const actorID = Number(actor?.id);
  if (!Number.isSafeInteger(actorID) || actorID <= 0) {
    throw new ProposalGuardError(
      'Accepting a proposal requires a named, signed-in person. Nothing accepts a proposal automatically.',
      'PROPOSAL_ACTOR_REQUIRED', 403
    );
  }
  if (proposal.status !== OPEN_STATUS) {
    throw new ProposalGuardError(
      `This proposal is ${String(proposal.status || 'unknown')} and can no longer be accepted.`,
      'PROPOSAL_NOT_OPEN', 409
    );
  }
  if (proposal.createdCampaignId) {
    throw new ProposalGuardError(
      'This proposal has already produced a campaign draft.',
      'PROPOSAL_ALREADY_CONVERTED', 409
    );
  }
  // A proposal that could not be shown to a person cannot have been accepted
  // by one. Checked again here rather than assumed from the fact that it was
  // stored, because "it is in the table so it must be fine" is how a bad row
  // written by a future code path becomes a customer message.
  assertSurfaceable(proposal);
  return true;
}

/**
 * A proposal that never had an audience cannot become a campaign.
 *
 * This is a refusal with an instruction attached, not a failure. A cohort the
 * detector has not saved as a segment has no membership to attach to a
 * campaign draft, and nothing here is going to resolve one on the fly:
 * inventing a recipient list at acceptance time is exactly the kind of
 * implicit audience the segment work exists to prevent. The operator saves the
 * audience as a segment first, using the rules the proposal already carries,
 * and then accepts.
 */
function assertAudienceIsSaved(proposal) {
  const audience = proposal?.audience;
  if (!audience || typeof audience !== 'object') {
    throw new ProposalGuardError(
      'This proposal carries no audience.',
      'PROPOSAL_AUDIENCE_MISSING', 500
    );
  }
  if (typeof audience.segmentKey !== 'string' || !audience.segmentKey.trim()) {
    throw new ProposalGuardError(
      'This proposal targets an audience that has not been saved as a segment yet. Save the rules as a segment, check the member count, then accept the proposal.',
      'PROPOSAL_AUDIENCE_NOT_SAVED', 409
    );
  }
  return true;
}

/**
 * A dismissal must say why.
 *
 * docs/campaigns/TRACKING-AND-LEARNING-RESEARCH.md: "Store every variant
 * proposed, including rejected ones, with the reason. Without it you cannot
 * tell whether the loop is improving or whether the human is doing all the
 * work." A dismissal with no reason is a discarded signal, so it is refused.
 */
function assertDismissalReason(reason) {
  if (typeof reason !== 'string') {
    throw new ProposalGuardError(
      'Say why this proposal is being dismissed. The reason is the only training signal this loop gets.',
      'PROPOSAL_DISMISSAL_REASON_REQUIRED', 400
    );
  }
  const text = reason.replace(/\s+/g, ' ').trim();
  if (text.length < MIN_DISMISSAL_REASON) {
    throw new ProposalGuardError(
      'Say why this proposal is being dismissed. The reason is the only training signal this loop gets.',
      'PROPOSAL_DISMISSAL_REASON_REQUIRED', 400
    );
  }
  if (text.length > MAX_DISMISSAL_REASON) {
    throw new ProposalGuardError(
      `Keep the dismissal reason under ${MAX_DISMISSAL_REASON} characters.`,
      'PROPOSAL_DISMISSAL_REASON_TOO_LONG', 400
    );
  }
  return text;
}

module.exports = {
  MAX_DISMISSAL_REASON,
  MIN_DISMISSAL_REASON,
  OPEN_STATUS,
  PROPOSAL_STATUSES,
  ProposalGuardError,
  TERMINAL_STATUSES,
  assertAudienceIsSaved,
  assertDismissalReason,
  assertHumanAcceptance,
  assertSurfaceable,
  isSurfaceable
};
