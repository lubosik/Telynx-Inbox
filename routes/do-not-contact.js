'use strict';
/**
 * routes/do-not-contact.js — the list of people this business will not message.
 *
 *   GET    /api/do-not-contact              campaigns.read
 *   POST   /api/do-not-contact              campaigns.manage
 *   DELETE /api/do-not-contact/:phone       campaigns.manage
 *
 * WHY THIS IS A SCREEN AND NOT A DATABASE TABLE SOMEBODY EDITS
 *   sms_campaign_suppressions already existed and was already enforced at send
 *   time by lib/campaigns/eligibility.js. What it never had was a way to put
 *   anybody on it or to look at it, so in practice it was empty and nobody knew
 *   it was there. An enforcement mechanism nobody can see is one nobody trusts.
 *
 * REMOVING SOMEBODY IS A DEACTIVATION, NOT A DELETE
 *   The row stays with `active = false`, so "we blocked this person in August
 *   and unblocked them in September" remains answerable. A list like this is
 *   evidence: the moment it can be silently emptied, it stops being evidence.
 *
 * A STOP IS NOT MANAGED HERE
 *   An opt-out is honoured by routes/webhook.js the moment it arrives and does
 *   not wait for anybody to curate a list. This screen is for the judgement
 *   calls: the refund that went badly, the person who should be left alone even
 *   though they never said the word.
 */

const express = require('express');
const { logAudit, logAuditSafely } = require('../lib/audit/log');

const WORKSPACE_ID = 'vici';
const MAX_REASON_LENGTH = 400;
// Every reason code the table's CHECK constraint accepts. A code outside this
// set is rejected by Postgres, and a constraint violation reads as a server
// fault rather than as "that is not a reason".
const REASON_CODES = new Set(['internal_identity', 'test_identity', 'manual_block', 'compliance_hold']);

function normalisePhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/[^0-9]/g, '');
  if (!digits) return null;
  return raw.startsWith('+') ? `+${digits}` : `+${digits}`;
}

function fail(res, status, code, message) {
  return res.status(status).json({ error: message, code });
}

function createDoNotContactRouter({ client } = {}) {
  const router = express.Router();
  const db = () => client || require('../db').supabase;

  // ── GET ─────────────────────────────────────────────────────────────────
  router.get('/', async (req, res) => {
    res.set('Cache-Control', 'no-store, private');
    try {
      const { data, error } = await db()
        .from('sms_campaign_suppressions')
        .select('id, contact_phone, reason_code, source, evidence_ref, active, effective_at, created_at')
        .eq('workspace_id', WORKSPACE_ID)
        .eq('active', true)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      const rows = data || [];
      // Names, so the screen reads as people rather than as phone numbers.
      // Chunked through selectIn because a bare .in() serialises every value
      // into the URL.
      const phones = [...new Set(rows.map(row => row.contact_phone))];
      const { selectIn } = require('../lib/fetch-all-rows');
      const contacts = phones.length
        ? await selectIn(db(), 'sms_contacts', 'phone, name', 'phone', phones)
        : [];
      const nameByPhone = new Map(contacts.map(row => [row.phone, row.name]));

      return res.json({
        entries: rows.map(row => ({
          id: row.id,
          phone: row.contact_phone,
          name: nameByPhone.get(row.contact_phone) || null,
          reasonCode: row.reason_code,
          source: row.source,
          addedAt: row.created_at
        })),
        total: rows.length
      });
    } catch (error) {
      console.error('[DNC] list failed:', error?.message || 'unknown');
      return fail(res, 502, 'DNC_READ_FAILED', 'The do not contact list could not be read.');
    }
  });

  // ── POST ────────────────────────────────────────────────────────────────
  router.post('/', async (req, res) => {
    const phone = normalisePhone(req.body?.phone);
    if (!phone || !/^\+[1-9][0-9]{7,14}$/.test(phone)) {
      return fail(res, 400, 'DNC_INVALID_PHONE', 'That is not a phone number this system can block.');
    }
    const reasonCode = String(req.body?.reasonCode || 'manual_block').trim();
    if (!REASON_CODES.has(reasonCode)) {
      return fail(res, 400, 'DNC_INVALID_REASON', 'That is not a reason this list accepts.');
    }
    const note = String(req.body?.note || '').trim().slice(0, MAX_REASON_LENGTH);

    try {
      // Already on the list is a success, not a conflict. Somebody blocking a
      // person twice means the same thing they meant the first time, and an
      // error here would read as "it did not work".
      const { data: existing } = await db()
        .from('sms_campaign_suppressions')
        .select('id')
        .eq('workspace_id', WORKSPACE_ID)
        .eq('contact_phone', phone)
        .eq('active', true)
        .maybeSingle();
      if (existing) return res.status(200).json({ entry: { id: existing.id, phone }, alreadyListed: true });

      const { data, error } = await db()
        .from('sms_campaign_suppressions')
        .insert({
          workspace_id: WORKSPACE_ID,
          contact_phone: phone,
          reason_code: reasonCode,
          source: 'app',
          // Never blank. The table requires evidence and a list of blocked
          // people with no stated reason is unauditable six months later.
          evidence_ref: note || `added by ${req.actor?.displayName || 'a teammate'}`,
          active: true,
          created_by: req.actor?.id ?? null
        })
        .select('id, contact_phone')
        .single();
      if (error) throw error;

      await logAudit({
        eventType: 'campaign.suppression.added',
        actor: req.actor,
        summary: 'Added somebody to the do not contact list',
        contactPhone: phone,
        metadata: { reason_code: reasonCode }
      }).catch(() => {});

      return res.status(201).json({ entry: { id: data.id, phone: data.contact_phone } });
    } catch (error) {
      console.error('[DNC] add failed:', error?.message || 'unknown');
      return fail(res, 502, 'DNC_WRITE_FAILED', 'That person could not be added right now.');
    }
  });

  // ── DELETE ──────────────────────────────────────────────────────────────
  router.delete('/:phone', async (req, res) => {
    const phone = normalisePhone(req.params.phone);
    if (!phone) return fail(res, 400, 'DNC_INVALID_PHONE', 'That is not a phone number this system can unblock.');
    try {
      const { data, error } = await db()
        .from('sms_campaign_suppressions')
        .update({ active: false, updated_at: new Date().toISOString() })
        .eq('workspace_id', WORKSPACE_ID)
        .eq('contact_phone', phone)
        .eq('active', true)
        .select('id');
      if (error) throw error;
      if (!data?.length) return fail(res, 404, 'DNC_NOT_LISTED', 'That person is not on the list.');

      await logAuditSafely({
        eventType: 'campaign.suppression.removed',
        actor: req.actor,
        summary: 'Removed somebody from the do not contact list',
        contactPhone: phone
      });
      return res.json({ removed: true, phone });
    } catch (error) {
      console.error('[DNC] remove failed:', error?.message || 'unknown');
      return fail(res, 502, 'DNC_WRITE_FAILED', 'That person could not be removed right now.');
    }
  });

  return router;
}

module.exports = createDoNotContactRouter;
module.exports.REASON_CODES = REASON_CODES;
