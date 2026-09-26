'use strict';

/**
 * Campaigns that may omit the repeated opt-out footer from an individual
 * message. This does not disable STOP handling, consent checks, suppression,
 * or the opt-in disclosure. It only controls whether the same instruction is
 * required at the end of every body.
 *
 * Keep this list deliberately narrow. Ordinary promotional campaigns retain
 * the stricter footer rule.
 */
const OPTIONAL_FOOTER_WORKFLOWS = new Set(['checkin_21d', 'vip']);

function requiresOptOutFooter(workflowCategory) {
  return !OPTIONAL_FOOTER_WORKFLOWS.has(String(workflowCategory || '').trim().toLowerCase());
}

module.exports = { OPTIONAL_FOOTER_WORKFLOWS, requiresOptOutFooter };
