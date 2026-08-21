'use strict';
/**
 * routes/audit.js — read API for the Activity Center audit trail.
 *
 * There is no POST, PATCH or DELETE here, and there will not be. sms_audit_log
 * is written only by lib/audit/log.js from inside the handler that performed
 * the action, because an audit row is a by-product of doing something, never a
 * thing a client asks for. A write API would also be an API for writing rows
 * that describe events that never happened.
 *
 * NAMING
 *   This is /api/audit, backed by `sms_audit_log`. It is NOT routes/activity.js
 *   — see the header of that file for why the two names collide.
 *
 * QUERY SHAPE — the constraints that took the inbox down on 20 August 2026
 *   (a) `category` is a stored column filtered with .eq(). Filtering a tab by
 *       listing its event types instead would need an `in` filter over a list
 *       that grows with every new type, which serialises into the request URL.
 *       test/no-unbounded-in.test.js fails the build on exactly that shape —
 *       including, as it turns out, on a comment that spells the call out
 *       literally, which is why this paragraph describes it in words.
 *   (b) `actor` is a SINGLE id, filtered with .eq(). Multi-actor selection is
 *       not offered, because it is the same unbounded list in a nicer shirt.
 *   (c) Actor display name and role are denormalised onto each row at write
 *       time, so this read path performs no lookup at all.
 *   (d) Pagination is keyset: .lt('id', cursor) + .order('id', desc) + .limit().
 *       Never .range() with a page number — on a feed that grows at the head,
 *       offsets duplicate and skip rows between requests, and PostgREST
 *       silently caps a response at 1000 rows.
 */

const express = require('express');
const { CATEGORIES } = require('../lib/audit/event-types');
const { normalisePhone } = require('../lib/phone');

const WORKSPACE_ID = 'vici';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/** How many recent rows /actors scans. Bounded on purpose; see the route. */
const ACTOR_SCAN_ROWS = 1000;

const SELECT_COLUMNS = [
  'id', 'occurred_at',
  'actor_type', 'actor_user_id', 'actor_display_name', 'actor_role',
  'event_type', 'category', 'visibility', 'severity',
  'entity_type', 'entity_id', 'contact_phone',
  'summary', 'previous_state', 'new_state', 'changed_fields', 'metadata',
  'ip', 'user_agent', 'request_id'
].join(', ');

const CATEGORY_SET = new Set(CATEGORIES);
const SAFE_ENTITY_TYPE = /^[a-z][a-z0-9_]{0,63}$/;

class AuditRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuditRequestError';
  }
}

/**
 * Whole digits only. Number.parseInt('7,9') returns 7, so a caller trying to
 * pass two actor ids would silently be shown one actor's rows and told nothing
 * about it. Rejecting the input is the honest answer: multi-actor selection is
 * not offered, and quietly answering a different question than the one asked is
 * worse in an audit tool than anywhere else.
 */
const WHOLE_NUMBER = /^\d+$/;

function parsePositiveInteger(value, name) {
  const text = String(value).trim();
  if (!WHOLE_NUMBER.test(text)) throw new AuditRequestError(`${name} must be a single whole number.`);
  const parsed = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AuditRequestError(`${name} must be a single whole number.`);
  }
  return parsed;
}

function parseLimit(value) {
  if (value === undefined || value === '') return DEFAULT_LIMIT;
  const parsed = parsePositiveInteger(value, 'limit');
  if (parsed > MAX_LIMIT) throw new AuditRequestError(`limit must be between 1 and ${MAX_LIMIT}.`);
  return parsed;
}

function parseCursor(value) {
  if (value === undefined || value === '') return null;
  return parsePositiveInteger(value, 'cursor');
}

function parseActor(value) {
  if (value === undefined || value === '') return null;
  return parsePositiveInteger(value, 'actor');
}

function parseTimestamp(value, name) {
  if (value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new AuditRequestError(`${name} must be a valid date.`);
  return new Date(parsed).toISOString();
}

function parseBoolean(value, name, fallback) {
  if (value === undefined || value === '') return fallback;
  const text = String(value).toLowerCase();
  if (text === 'true') return true;
  if (text === 'false') return false;
  throw new AuditRequestError(`${name} must be true or false.`);
}

function feedParams(query = {}) {
  const category = query.category ? String(query.category).toLowerCase() : null;
  if (category && !CATEGORY_SET.has(category)) throw new AuditRequestError('Unknown audit category.');
  const from = parseTimestamp(query.from, 'from');
  const to = parseTimestamp(query.to, 'to');
  if (from && to && Date.parse(from) > Date.parse(to)) {
    throw new AuditRequestError('from must not be later than to.');
  }
  return {
    category,
    actor: parseActor(query.actor),
    from,
    to,
    cursor: parseCursor(query.cursor),
    limit: parseLimit(query.limit),
    includeAudit: parseBoolean(query.includeAudit, 'includeAudit', false)
  };
}

function isMissingAuditSchema(error) {
  // Mirrors lib/audit/log.js. A bare table-name match also catches RLS,
  // permission and constraint errors, which would report "apply the migration"
  // for a table that exists and is simply refusing the read.
  if (['42P01', 'PGRST205', 'PGRST204'].includes(error?.code)) return true;
  const message = String(error?.message || '');
  return /does not exist|could not find|schema cache/i.test(message) &&
    /sms_audit_log/i.test(message);
}

function sendError(res, error) {
  if (error instanceof AuditRequestError) {
    return res.status(400).json({ error: error.message, code: 'INVALID_AUDIT_REQUEST' });
  }
  if (isMissingAuditSchema(error)) {
    return res.status(503).json({
      error: 'The activity audit trail is unavailable until scripts/audit-migration.sql is applied.',
      code: 'AUDIT_NOT_READY'
    });
  }
  // The provider/database message can carry row and connection detail, so it is
  // logged rather than returned.
  console.error('[AUDIT] Read failed:', error?.code || error?.message || 'internal_error');
  return res.status(500).json({ error: 'Activity could not be loaded.', code: 'AUDIT_LOAD_FAILED' });
}

/**
 * Keyset page. One extra row is requested so "is there another page" is a fact
 * rather than a guess, which avoids handing the client a cursor that leads to
 * an empty page.
 */
async function keysetPage(query, limit) {
  const { data, error } = await query.order('id', { ascending: false }).limit(limit + 1);
  if (error) throw error;
  const rows = data || [];
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return {
    items,
    hasMore,
    nextCursor: hasMore && items.length ? items[items.length - 1].id : null
  };
}

function createAuditRouter({ client } = {}) {
  const db = client || require('../db').supabase;
  const router = express.Router();

  function base() {
    return db.from('sms_audit_log').select(SELECT_COLUMNS).eq('workspace_id', WORKSPACE_ID);
  }

  // GET /api/audit — the main feed.
  router.get('/', async (req, res) => {
    try {
      const params = feedParams(req.query);
      let query = base();
      if (!params.includeAudit) query = query.neq('visibility', 'audit');
      if (params.category) query = query.eq('category', params.category);
      if (params.actor) query = query.eq('actor_user_id', params.actor);
      if (params.from) query = query.gte('occurred_at', params.from);
      if (params.to) query = query.lte('occurred_at', params.to);
      if (params.cursor) query = query.lt('id', params.cursor);

      const page = await keysetPage(query, params.limit);
      res.set('Cache-Control', 'no-store, private');
      return res.json({ ...page, limit: params.limit });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // GET /api/audit/entity/:entityType/:entityId — everything that happened to
  // one scheduled message, contact, call, or sync job.
  router.get('/entity/:entityType/:entityId', async (req, res) => {
    try {
      const entityType = String(req.params.entityType || '').toLowerCase();
      if (!SAFE_ENTITY_TYPE.test(entityType)) throw new AuditRequestError('Invalid entity type.');
      const entityID = String(req.params.entityId || '');
      if (!entityID || entityID.length > 128) throw new AuditRequestError('Invalid entity id.');

      const limit = parseLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);
      const includeAudit = parseBoolean(req.query.includeAudit, 'includeAudit', false);

      let query = base().eq('entity_type', entityType).eq('entity_id', entityID);
      if (!includeAudit) query = query.neq('visibility', 'audit');
      if (cursor) query = query.lt('id', cursor);

      const page = await keysetPage(query, limit);
      res.set('Cache-Control', 'no-store, private');
      return res.json({ ...page, limit, entity_type: entityType, entity_id: entityID });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // GET /api/audit/contact/:phone — the per-contact export. This is the reason
  // contact_phone stores the full number rather than the last four digits.
  router.get('/contact/:phone', async (req, res) => {
    try {
      const phone = normalisePhone(decodeURIComponent(req.params.phone || ''));
      if (!phone) throw new AuditRequestError('A valid phone number is required.');

      const limit = parseLimit(req.query.limit);
      const cursor = parseCursor(req.query.cursor);
      const includeAudit = parseBoolean(req.query.includeAudit, 'includeAudit', false);

      let query = base().eq('contact_phone', phone);
      if (!includeAudit) query = query.neq('visibility', 'audit');
      if (cursor) query = query.lt('id', cursor);

      const page = await keysetPage(query, limit);
      res.set('Cache-Control', 'no-store, private');
      return res.json({ ...page, limit, contact_phone: phone });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // GET /api/audit/actors — the actor filter's option list.
  //
  // Bounded to the most recent ACTOR_SCAN_ROWS rows and deduplicated in memory.
  // That is a deliberate trade: an actor who has done nothing in the last
  // thousand events will not appear here, but the alternative shapes are a
  // SELECT DISTINCT over the whole table on every page load, or a second table
  // to keep in sync. Filtering by an absent actor still works — the client can
  // pass any id to GET /api/audit?actor=.
  router.get('/actors', async (req, res) => {
    try {
      const { data, error } = await db
        .from('sms_audit_log')
        .select('actor_user_id, actor_display_name, actor_role, actor_type, occurred_at')
        .eq('workspace_id', WORKSPACE_ID)
        .order('id', { ascending: false })
        .limit(ACTOR_SCAN_ROWS);
      if (error) throw error;

      const seen = new Map();
      for (const row of data || []) {
        const key = row.actor_user_id === null || row.actor_user_id === undefined
          ? `name:${row.actor_display_name}`
          : `id:${row.actor_user_id}`;
        if (seen.has(key)) {
          seen.get(key).event_count += 1;
          continue;
        }
        seen.set(key, {
          actor_user_id: row.actor_user_id ?? null,
          actor_display_name: row.actor_display_name,
          actor_role: row.actor_role ?? null,
          actor_type: row.actor_type,
          last_seen: row.occurred_at,
          event_count: 1
        });
      }

      res.set('Cache-Control', 'no-store, private');
      return res.json({ actors: [...seen.values()], scanned_rows: (data || []).length, scan_limit: ACTOR_SCAN_ROWS });
    } catch (error) {
      return sendError(res, error);
    }
  });

  // GET /api/audit/summary — counts per category for the tab badges.
  // One bounded head-count per category; no rows are transferred.
  router.get('/summary', async (req, res) => {
    try {
      const from = parseTimestamp(req.query.from, 'from');
      const to = parseTimestamp(req.query.to, 'to');
      const includeAudit = parseBoolean(req.query.includeAudit, 'includeAudit', false);

      function counter(apply) {
        let query = db
          .from('sms_audit_log')
          .select('id', { count: 'exact', head: true })
          .eq('workspace_id', WORKSPACE_ID);
        if (!includeAudit) query = query.neq('visibility', 'audit');
        if (from) query = query.gte('occurred_at', from);
        if (to) query = query.lte('occurred_at', to);
        return apply ? apply(query) : query;
      }

      const results = await Promise.all([
        counter(null),
        counter(query => query.eq('severity', 'warning')),
        ...CATEGORIES.map(category => counter(query => query.eq('category', category)))
      ]);

      const failed = results.find(result => result.error);
      if (failed) throw failed.error;

      const byCategory = {};
      CATEGORIES.forEach((category, index) => {
        byCategory[category] = results[index + 2].count || 0;
      });

      res.set('Cache-Control', 'no-store, private');
      return res.json({
        total: results[0].count || 0,
        warnings: results[1].count || 0,
        by_category: byCategory,
        from,
        to
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}

// Same shape as routes/analytics.js: a factory, so server.js mounts it with
// `require('./routes/audit')()` and tests can inject a fake Supabase client.
module.exports = createAuditRouter;
module.exports.createAuditRouter = createAuditRouter;
module.exports.feedParams = feedParams;
module.exports.AuditRequestError = AuditRequestError;
module.exports.sendError = sendError;
