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
const { logAudit, logAuditSafely } = require('../lib/audit/log');
const { CampaignNotReadyError, CampaignRequestError } = require('../lib/campaigns/service');
const { createSegmentService } = require('../lib/campaigns/segment-service');
const { prepareSegmentChangeNotifications } = require('../lib/campaigns/segment-notifications');

const CREATE_BODY_KEYS = new Set(['kind', 'name', 'description', 'purpose', 'members', 'definitionKey']);
const REMOVE_BODY_KEYS = new Set(['mode', 'reason']);
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
    return res.status(error.status || 400).json({
      error: error.message, code: error.code || 'INVALID_SEGMENT_REQUEST'
    });
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
  auditWriter,
  segmentRemovalAuditWriter
} = {}) {
  const segments = service || createSegmentService();
  // Lazy, like routes/campaigns.js: constructing this router in a unit test
  // must not require Supabase or an Apple credential, and the feature flag is
  // checked before any device row is read.
  const notifySegmentChange = segmentNotificationSender || ((...args) =>
    require('../lib/apns-notify').sendSegmentChangeNotifications(...args));
  const writeAudit = auditWriter || logAuditSafely;
  // Removal is the one segment action whose audit row must exist before the
  // effect. logAudit, not logAuditSafely: no row, no delete.
  const removalAuditWriter = segmentRemovalAuditWriter || logAudit;
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

  router.post('/', async (req, res) => {
    try {
      const input = rejectUnknownKeys(
        req.body, CREATE_BODY_KEYS,
        'Only kind, name, description, purpose, definitionKey and members may be provided.'
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
          member_count: result.memberCount,
          // The purpose is stored on the row and readable from the segment
          // screen. The audit metadata records only that one was given, so the
          // append-only log does not become a second, undeletable copy of
          // operator free text about customers.
          purpose_recorded: Boolean(result.segment.purpose)
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

  /**
   * Who could be added to this segment.
   *
   * `campaigns.manage`, not `campaigns.read`. This endpoint exists for one
   * reason: to stage an add or a force include. A Support Agent can never
   * perform either, and handing them a list of people they cannot act on is a
   * route with no reader. Segment membership itself stays readable at
   * `GET /:id`, which is the question they do get asked.
   *
   * The exclusion of current members happens in the service, before paging.
   * See the comment on `candidates()` for why filtering the visible page would
   * not be a fix.
   */
  router.get('/:id/candidates', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      return res.json(await segments.candidates(req.params.id, req.query));
    } catch (error) { return sendError(res, error); }
  });

  /**
   * Remove a segment from the list.
   *
   * DESTROY OR ARCHIVE IS NOT THE CALLER'S DECISION.
   *   A hand-made list of phone numbers that no campaign ever used, that the
   *   engine never ran on, that nobody overrode, and where nobody wrote down
   *   why any named person is in it, records no decision about anybody. It is
   *   somebody trying the feature out, and having no way to remove it is a
   *   papercut rather than a safeguard. That one is genuinely deleted.
   *
   *   Everything else is part of the answer to "who did we message and why".
   *   An override names a person, an author and a reason and survives every
   *   recompute. A recompute run is the engine's own record of what it decided.
   *   A member row carrying a written reason is the same class of thing as an
   *   override. A campaign built against the segment makes it the record of who
   *   that campaign was aimed at. Any of those and the segment is archived: it
   *   leaves the working list, the row stays, and `?archived=true` still finds
   *   it.
   *
   *   The body may ask for `mode: "archive"`. It may NOT ask for a delete.
   *   delete_sms_campaign_segment has no force path and repeats every blocker
   *   inside the transaction, so a segment that gets a campaign or an override
   *   between the preview below and the statement ends up archived, not gone.
   *
   * AUDIT ORDER. The row is written BEFORE the destructive statement, with
   *   `logAudit` so a failed write refuses the delete outright. After the
   *   delete there is nothing left to describe. Over-recording an attempt that
   *   then failed is a bookkeeping error; under-recording a destruction that
   *   succeeded is a hole in the audit trail, and only one of those is
   *   recoverable.
   */
  router.delete('/:id', async (req, res) => {
    try {
      const input = rejectUnknownKeys(
        req.body, REMOVE_BODY_KEYS, 'Only mode and reason may be provided.'
      );
      const requestedMode = input.mode === 'archive' ? 'archive' : 'auto';
      const reason = typeof input.reason === 'string' ? input.reason.slice(0, 500) : null;
      const preview = await segments.deletionPreview(req.params.id);
      const willDelete = requestedMode !== 'archive' && preview.destructible === true;

      if (willDelete) {
        const proof = await removalAuditWriter({
          eventType: 'campaign.segment.deleted',
          req,
          entityId: preview.segment.id,
          summary: `Deleted ${segmentName(preview.segment)}; it held no campaign, no engine run, no override and no written reason about anybody`,
          previousState: {
            kind: preview.segment.kind, member_count: preview.segment.memberCount
          },
          metadata: {
            segment_key: preview.segment.key,
            segment_kind: preview.segment.kind,
            member_count: preview.segment.memberCount,
            reason
          },
          fingerprint: `segment-deleted:${preview.segment.id}`
        });
        if (!proof?.recorded && proof?.reason !== 'duplicate') {
          throw Object.assign(new Error('Segment deletion audit was not recorded.'), {
            code: 'SEGMENT_DELETE_AUDIT_REQUIRED', status: 503
          });
        }
      }

      const result = await segments.remove(
        req.params.id, { mode: requestedMode, reason }, req.actor
      );

      if (result.outcome === 'archived') {
        await auditSegment('campaign.segment.archived', req, preview.segment, {
          summary: `Archived ${segmentName(preview.segment)}; it carries a record of a decision and cannot be deleted`,
          previousState: { kind: preview.segment.kind, archived: false },
          newState: { kind: result.kind, archived: true },
          metadata: {
            segment_key: preview.segment.key,
            segment_kind: preview.segment.kind,
            requested_mode: requestedMode,
            blockers: result.blockers,
            reason
          },
          fingerprint: `segment-archived:${preview.segment.id}`
        });
      } else if (!willDelete) {
        // The preview said archive, the RPC destroyed it. That means the two
        // disagree about the rules, which is a bug worth shouting about rather
        // than a row worth writing quietly.
        console.error('[SEGMENTS] Deletion preview and delete_sms_campaign_segment disagreed; the row is gone and unaudited.');
      }

      return res.json(result);
    } catch (error) { return sendError(res, error); }
  });

  /**
   * Put an archived segment back.
   *
   * Archiving has to be reversible or it is a slower delete, and an operator
   * who cannot undo it reaches for the destructive path instead. Nothing was
   * removed by the archive, so nothing is rebuilt here.
   */
  router.post('/:id/restore', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store, private');
      const result = await segments.restore(req.params.id, req.actor);
      await auditSegment('campaign.segment.restored', req, result.segment, {
        summary: `Restored ${segmentName(result.segment)} to the working list`,
        previousState: { archived: true },
        newState: { archived: false, member_count: result.segment.memberCount },
        metadata: {
          segment_key: result.segment.key,
          segment_kind: result.segment.kind
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
