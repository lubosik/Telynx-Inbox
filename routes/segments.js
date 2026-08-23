'use strict';
/**
 * routes/segments.js — saved campaign segments.
 *
 * The deterministic engine already knows who is due a reorder and who has
 * lapsed. Until this router existed, nobody could see it. Every endpoint here
 * is a window onto that engine's output plus the human overrides applied to
 * it; none of them message a customer, and none of them can.
 *
 * PERMISSIONS
 *   campaigns.read   to look. Support Agents hold this, so they can see a
 *                    segment and why somebody is in it.
 *   campaigns.manage to change anything. Support Agents do NOT hold this.
 *   Both are declared in lib/route-policy.js; the enforcer default-denies
 *   anything not declared there, so a route added here without a policy entry
 *   is closed, and test/route-policy.test.js fails rather than shipping it.
 */

const express = require('express');
const { logAuditSafely } = require('../lib/audit/log');
const { CampaignNotReadyError, CampaignRequestError } = require('../lib/campaigns/service');
const { createSegmentService } = require('../lib/campaigns/segment-service');
const { SegmentRuleDraftError } = require('../lib/campaigns/segment-rule-writer');
const { prepareSegmentChangeNotifications } = require('../lib/campaigns/segment-notifications');

const CREATE_BODY_KEYS = new Set(['kind', 'name', 'description', 'members', 'definitionKey']);
const RULE_DRAFT_BODY_KEYS = new Set(['description']);
const RULE_PREVIEW_BODY_KEYS = new Set(['rules', 'selfSegmentKey']);
const RULE_CREATE_BODY_KEYS = new Set(['name', 'description', 'rules']);
const MEMBER_BODY_KEYS = new Set(['phone', 'contactPhone', 'contactId', 'contactID', 'name', 'reason']);
const OVERRIDE_BODY_KEYS = new Set([
  'phone', 'contactPhone', 'overrideType', 'reason', 'contactId', 'contactID', 'name'
]);

function rejectUnknownKeys(body, allowed, message) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length) throw new CampaignRequestError(message, 'SEGMENT_INPUT_REJECTED', 400);
  return input;
}

function sendError(res, error) {
  if (error instanceof CampaignRequestError || error instanceof CampaignNotReadyError || error?.status) {
    const body = {
      error: error.message, code: error.code || 'INVALID_SEGMENT_REQUEST'
    };
    // A rule rejection is only useful if it says WHICH rule and why. These are
    // the validator's own reasons, built from constants in
    // lib/campaigns/segment-rule-schema.js: a dimension id, an operator name,
    // a limit, or a product name the operator themselves typed. No customer
    // value and no fragment of a model's reply travels in them.
    if (Array.isArray(error.errors) && error.errors.length) body.errors = error.errors;
    return res.status(error.status || 400).json(body);
  }
  console.error('[SEGMENTS] Request failed:', error?.code || 'internal_error');
  return res.status(500).json({
    error: 'The segment request could not be completed.', code: 'SEGMENT_REQUEST_FAILED'
  });
}

function segmentName(segment) {
  return segment?.name ? `“${String(segment.name).slice(0, 160)}”` : 'the segment';
}

/**
 * Audit metadata never carries a bare phone number for a bulk action, and
 * never carries evidence bodies. A single-person action names the person,
 * because "who did you exclude?" is the question the row exists to answer and
 * the audit table already stores contact references elsewhere.
 */
async function auditSegment(eventType, req, segment, details = {}) {
  return logAuditSafely({
    eventType,
    req,
    entityId: segment?.id || req.params?.id,
    summary: details.summary,
    previousState: details.previousState,
    newState: details.newState,
    metadata: details.metadata,
    contactPhone: details.contactPhone,
    fingerprint: details.fingerprint
  });
}

function createSegmentRouter({
  service,
  segmentNotificationSender,
  auditWriter
} = {}) {
  const segments = service || createSegmentService();
  // Lazy, like routes/campaigns.js: constructing this router in a unit test
  // must not require Supabase or an Apple credential, and the feature flag is
  // checked before any device row is read.
  const notifySegmentChange = segmentNotificationSender || ((...args) =>
    require('../lib/apns-notify').sendSegmentChangeNotifications(...args));
  const writeAudit = auditWriter || logAuditSafely;
  const router = express.Router();

  /**
   * Push, but never at the cost of the operation that triggered it. A failed
   * notification is reported in the response body and nothing else.
   */
  async function announce(segment, change) {
    try {
      const users = await segments.notificationUsers();
      const prepared = prepareSegmentChangeNotifications({
        users, segment, change, generatedAt: new Date()
      });
      if (!prepared.length) return { sent: 0, targeted: 0, reason: 'no_eligible_recipients' };
      return await notifySegmentChange(prepared, { dryRun: false });
    } catch (error) {
      console.error('[SEGMENTS] Change notification failed:', error?.code || 'internal_error');
      return { sent: 0, targeted: 0, error: 'segment_notification_dispatch_failed' };
    }
  }

  router.get('/', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await segments.list(req.query));
    } catch (error) { return sendError(res, error); }
  });

  // Literal before /:id so Express never reads "catalogue" as an id.
  router.get('/catalogue', async (_req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(segments.catalogue());
    } catch (error) { return sendError(res, error); }
  });

  // ── Describing a segment in words ─────────────────────────────────────────
  //
  // Three steps, in this order, and the order is the feature:
  //
  //   POST /rules/draft    a sentence in, DRAFT RULES out. Saves nothing.
  //   POST /rules/preview  rules in, a real count and a sample out. Saves
  //                        nothing.
  //   POST /rules          rules in, a segment out. This is the only one that
  //                        writes, and it is reached only after a person has
  //                        read the rules in plain English.
  //
  // The model never creates a segment and never returns people. Splitting the
  // three is what makes that structural rather than a promise: the drafting
  // endpoint has no code path to a write, and the writing endpoint has no code
  // path to a model.
  //
  // All three require campaigns.manage. A Support Agent cannot build a
  // segment, and the policy table says so in lib/route-policy.js.

  router.post('/rules/draft', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const input = rejectUnknownKeys(
        req.body, RULE_DRAFT_BODY_KEYS,
        'Only description may be provided. Customer data is server-owned and is never accepted here.'
      );
      const result = await segments.draftRules({ description: input.description });
      return res.json(result);
    } catch (error) {
      if (error instanceof SegmentRuleDraftError) {
        return res.status(error.status || 400).json({ error: error.message, code: error.code });
      }
      return sendError(res, error);
    }
  });

  router.post('/rules/preview', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const input = rejectUnknownKeys(
        req.body, RULE_PREVIEW_BODY_KEYS,
        'Only rules and selfSegmentKey may be provided.'
      );
      return res.json(await segments.previewRules(input));
    } catch (error) { return sendError(res, error); }
  });

  router.post('/rules', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const input = rejectUnknownKeys(
        req.body, RULE_CREATE_BODY_KEYS,
        'Only name, description and rules may be provided.'
      );
      const result = await segments.createFromRules(input, req.actor);
      await auditSegment('campaign.segment.created', req, result.segment, {
        summary: `Created the described segment ${segmentName(result.segment)}`,
        newState: { kind: 'automatic', member_count: 0 },
        metadata: {
          segment_key: result.segment.key,
          segment_kind: 'automatic',
          detector: 'rules',
          rule_version: result.segment.ruleVersion,
          // The rule shape, so the Activity Center can answer "what was this
          // segment built from" without storing the rules twice.
          rule_match: result.ruleSet.match,
          rule_condition_count: result.ruleSet.conditions.length,
          rule_dimensions: [...new Set(result.ruleSet.conditions.map(item => item.dimension))].sort()
        }
      });
      return res.status(201).json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.post('/', async (req, res) => {
    try {
      const input = rejectUnknownKeys(
        req.body, CREATE_BODY_KEYS,
        'Only kind, name, description, definitionKey and members may be provided.'
      );
      // The kind is chosen once, at creation, and the database refuses to
      // change it afterwards. Automatic means the engine owns membership;
      // manual means a person does. There is no third state and no migration
      // between the two.
      if (input.kind === 'automatic') {
        const result = await segments.createAutomatic(input, req.actor);
        if (!result.created) return res.status(200).json(result);
        await auditSegment('campaign.segment.created', req, result.segment, {
          summary: `Saved the automatic segment ${segmentName(result.segment)}`,
          newState: { kind: 'automatic', member_count: result.segment.memberCount },
          metadata: {
            segment_key: result.segment.key,
            segment_kind: 'automatic',
            rule_version: result.segment.ruleVersion
          }
        });
        const notification = await announce(result.segment, {
          reason: 'created', memberCount: result.segment.memberCount, joinedCount: 0, leftCount: 0
        });
        return res.status(201).json({ ...result, notification });
      }

      const result = await segments.createManual(input, req.actor);
      await auditSegment('campaign.segment.created', req, result.segment, {
        summary: `Created the manual segment ${segmentName(result.segment)} with ${result.memberCount} ${result.memberCount === 1 ? 'person' : 'people'}`,
        newState: { kind: 'manual', member_count: result.memberCount },
        metadata: {
          segment_key: result.segment.key,
          segment_kind: 'manual',
          member_count: result.memberCount
        }
      });
      return res.status(201).json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.get('/:id', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await segments.detail(req.params.id, req.query));
    } catch (error) { return sendError(res, error); }
  });

  // "Why is this person in this segment?" This is the endpoint that answers it.
  router.get('/:id/members/:phone', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await segments.member(req.params.id, req.params.phone));
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/members', async (req, res) => {
    try {
      const input = rejectUnknownKeys(
        req.body, MEMBER_BODY_KEYS,
        'Only phone, contactId, name and reason may be provided.'
      );
      const result = await segments.addMember(req.params.id, input, req.actor);
      await auditSegment('campaign.segment.member_added', req, { id: req.params.id }, {
        summary: 'Added a person to a manual segment',
        contactPhone: result.member.contactPhone,
        newState: { membership_source: result.member.membershipSource },
        metadata: { segment_id: String(req.params.id), membership_source: result.member.membershipSource }
      });
      return res.status(201).json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.delete('/:id/members/:phone', async (req, res) => {
    try {
      const result = await segments.removeMember(req.params.id, req.params.phone, req.actor);
      await auditSegment('campaign.segment.member_removed', req, { id: req.params.id }, {
        summary: 'Removed a person from a manual segment',
        contactPhone: result.contactPhone,
        metadata: { segment_id: String(req.params.id) }
      });
      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });

  // Force include or exclude on an AUTOMATIC segment. An exclusion outlives
  // every recompute until it is revoked here; see the header of
  // lib/campaigns/segment-membership.js for why it is stored separately.
  router.post('/:id/overrides', async (req, res) => {
    try {
      const input = rejectUnknownKeys(
        req.body, OVERRIDE_BODY_KEYS,
        'Only phone, overrideType, contactId, name and reason may be provided.'
      );
      const result = await segments.setOverride(req.params.id, input, req.actor);
      await auditSegment('campaign.segment.override_set', req, { id: req.params.id }, {
        summary: result.override.overrideType === 'exclude'
          ? 'Excluded a person from an automatic segment until this is revoked'
          : 'Force included a person in an automatic segment',
        contactPhone: result.override.contactPhone,
        newState: { override_type: result.override.overrideType },
        metadata: {
          segment_id: String(req.params.id),
          override_type: result.override.overrideType,
          reason: result.override.reason
        }
      });
      return res.status(201).json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.delete('/:id/overrides/:phone', async (req, res) => {
    try {
      const result = await segments.revokeOverride(
        req.params.id, req.params.phone, req.body || {}, req.actor
      );
      await auditSegment('campaign.segment.override_revoked', req, { id: req.params.id }, {
        summary: `Revoked a ${result.override.overrideType} override on an automatic segment`,
        contactPhone: result.override.contactPhone,
        previousState: { override_type: result.override.overrideType },
        metadata: {
          segment_id: String(req.params.id),
          override_type: result.override.overrideType,
          reason: result.override.revokeReason
        }
      });
      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });

  router.post('/:id/recompute', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const result = await segments.recompute(req.params.id, req.actor);
      const auditInput = {
        eventType: 'campaign.segment.recomputed',
        req,
        entityId: String(req.params.id),
        summary: result.run.replayed
          ? `Rechecked ${segmentName(result.segment)}; nothing had changed`
          : `Recomputed ${segmentName(result.segment)}: ${result.run.joinedCount} joined, ${result.run.leftCount} left, ${result.run.memberCount} now in it`,
        metadata: {
          segment_key: result.segment.key,
          rule_version: result.segment.ruleVersion,
          replayed: result.run.replayed,
          member_count: result.run.memberCount,
          joined_count: result.run.joinedCount,
          left_count: result.run.leftCount,
          refreshed_count: result.run.refreshedCount,
          forced_include_count: result.run.forcedIncludeCount,
          excluded_count: result.run.excludedCount,
          input_digest: result.run.digest
        },
        fingerprint: `segment-recomputed:${req.params.id}:${result.run.digest}`
      };
      if (writeAudit === logAuditSafely) await logAuditSafely(auditInput);
      else await writeAudit(auditInput);

      const notification = result.material
        ? await announce(result.segment, {
          reason: 'recomputed',
          memberCount: result.run.memberCount,
          joinedCount: result.run.joinedCount,
          leftCount: result.run.leftCount
        })
        : { sent: 0, targeted: 0, reason: 'change_not_material' };
      return res.json({ ...result, notification });
    } catch (error) { return sendError(res, error); }
  });

  return router;
}

module.exports = createSegmentRouter;
module.exports.sendError = sendError;
module.exports.auditSegment = auditSegment;
