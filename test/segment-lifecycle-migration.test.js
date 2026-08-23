'use strict';
/**
 * scripts/segment-lifecycle-migration.sql, read as text.
 *
 * Shape assertions, not behaviour: there is no Postgres in the offline run.
 * They exist because the properties they check are the ones that cannot be
 * recovered afterwards. A force-delete path added to the RPC would be invisible
 * until a segment carrying an override history was gone.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'scripts/segment-lifecycle-migration.sql'), 'utf8');
const appliedSql = fs.readFileSync(path.join(ROOT, 'scripts/campaign-segments-migration.sql'), 'utf8');

/**
 * The file with its `--` comments removed.
 *
 * Several assertions below are "this construct is absent". The comments in this
 * migration explain at length WHY NOT VALID and a force-delete mode were both
 * rejected, so matching against the raw text would fail on the very paragraph
 * arguing for the property being asserted.
 */
const statements = sql.split('\n').map(line => line.replace(/--.*$/, '')).join('\n');

test('it is a new file, and the applied one is untouched', () => {
  assert.match(sql, /^BEGIN;$/m);
  assert.match(sql, /^COMMIT;$/m);
  assert.match(sql, /NOTIFY pgrst, 'reload schema'/);

  // scripts/campaign-segments-migration.sql is applied in production. If a
  // future edit tries to add the purpose column there instead, this fails.
  assert.doesNotMatch(appliedSql, /\bpurpose\b/);
  assert.doesNotMatch(appliedSql, /delete_sms_campaign_segment/);

  assert.doesNotMatch(sql, /\bDROP TABLE\b/i);
  assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bDROP COLUMN\b/i);
  // A new permission key would make the deploy order a startup crash loop.
  assert.doesNotMatch(sql, /INSERT INTO sms_permissions/);
  // And it messages nobody.
  assert.doesNotMatch(sql, /sendSMS|api\.telnyx|fetch\s*\(/i);
});

test('the purpose column is backfilled BEFORE it is constrained', () => {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS purpose text/);

  const backfill = sql.indexOf("SET purpose = 'Recorded before a purpose was required");
  const constraint = sql.indexOf('sms_campaign_segment_purpose_matches_kind CHECK');
  assert.ok(backfill > -1, 'existing manual segments must be given a purpose');
  assert.ok(constraint > -1, 'the constraint must exist');
  assert.ok(backfill < constraint, 'constraining before backfilling would fail on the owner\'s existing segment');

  // NOT VALID was the obvious tool and is the wrong one: it is still enforced
  // on UPDATE, so a legacy manual segment could never have a member added to
  // it again, because add_sms_campaign_segment_member updates member_count.
  assert.doesNotMatch(statements, /NOT VALID/);
});

test('a manual segment must carry a purpose and an automatic one must not', () => {
  assert.match(sql, /segment_kind = 'automatic' AND purpose IS NULL/);
  assert.match(sql, /segment_kind = 'manual'\s*\n\s*AND purpose IS NOT NULL/);
  assert.match(sql, /char_length\(trim\(purpose\)\) BETWEEN 1 AND 500/);
  assert.match(sql, /RAISE EXCEPTION 'segment_purpose_required'/);
});

test('the segment purpose does not replace the per-person reason', () => {
  // Two different questions. "Why does this group exist?" is answered once, on
  // the segment. "Why is this named human here, or deliberately not here?" is
  // answered on the member row and on the override, and both keep their own
  // storage. If this ever fails, the second answer has been thrown away.
  assert.match(sql, /inclusion_evidence/);
  assert.match(appliedSql, /sms_campaign_segment_overrides/);
  assert.doesNotMatch(sql, /ALTER TABLE public\.sms_campaign_segment_overrides/);
  assert.doesNotMatch(sql, /DROP FUNCTION[^;]*set_sms_campaign_segment_override/);
  assert.doesNotMatch(sql, /DROP FUNCTION[^;]*add_sms_campaign_segment_member/);
});

test('create is replaced rather than overloaded, so no ambiguous candidate can win', () => {
  // Two functions with different rules about whether a purpose is required
  // would let PostgREST pick the permissive one and quietly reintroduce the
  // purposeless manual segment this change exists to stop.
  assert.match(
    sql,
    /DROP FUNCTION IF EXISTS public\.create_sms_campaign_segment\(\s*\n?\s*text, bigint, text, text, text, text, jsonb, text, jsonb\s*\n?\);/
  );
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.create_sms_campaign_segment\(/);
  assert.match(sql, /p_purpose text/);
  // And the gap it opens is written down rather than discovered.
  assert.match(sql, /DEPLOY ORDER/);
  assert.match(sql, /PGRST202/);
});

test('the delete RPC has no force path', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.delete_sms_campaign_segment\(/);
  assert.match(sql, /IF coalesce\(p_mode, 'auto'\) NOT IN \('auto', 'archive'\) THEN/);
  assert.match(sql, /RAISE EXCEPTION 'segment_delete_mode_invalid'/);
  assert.doesNotMatch(statements, /force_delete/);

  // The mode a caller CAN ask for only ever makes the outcome safer.
  assert.match(sql, /IF p_mode = 'archive' OR array_length\(v_blockers, 1\) IS NOT NULL THEN/);
});

test('every part of "who did we message and why" blocks destruction', () => {
  for (const blocker of [
    'already_archived', 'campaign_reference', 'engine_has_run',
    'recompute_history', 'override_history', 'member_reasons'
  ]) {
    assert.match(sql, new RegExp(`v_blockers \\|\\| '${blocker}'`), `${blocker} must be a blocker`);
  }

  // A revoked override counts. The table keeps revoked rows on purpose so that
  // who decided what and who undid it both stay readable, and destroying the
  // segment would destroy both.
  const overrideCheck = sql.slice(
    sql.indexOf('FROM public.sms_campaign_segment_overrides WHERE segment_id = p_segment_id')
  ).slice(0, 200);
  assert.doesNotMatch(overrideCheck, /revoked_at IS NULL/);

  // Bare membership is deliberately NOT a blocker. A hand-picked list of phone
  // numbers with no written reasons records no decision about anybody, and the
  // owner having no way to remove it is the papercut this fixes.
  assert.match(sql, /nullif\(trim\(coalesce\(inclusion_evidence->>'reason', ''\)\), ''\) IS NOT NULL/);
});

test('the blockers are re-checked inside the transaction that acts on them', () => {
  const body = sql.slice(sql.indexOf('FUNCTION public.delete_sms_campaign_segment'));
  assert.match(body, /FOR UPDATE/, 'the segment row is locked before its blockers are read');
  const deleteAt = body.indexOf('DELETE FROM public.sms_campaign_segments');
  const archiveAt = body.indexOf("'outcome', 'archived'");
  assert.ok(archiveAt > -1 && deleteAt > archiveAt,
    'the archive return must come first, so the destructive statement is unreachable when a blocker fired');
});

test('archiving is reversible, or it is only a slower delete', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.restore_sms_campaign_segment\(/);
  assert.match(sql, /SET archived_at = NULL, archived_by = NULL, archive_reason = NULL/);
});

test('the new functions are reachable by the service role and by nobody else', () => {
  for (const signature of [
    'create_sms_campaign_segment\\(text,bigint,text,text,text,text,text,jsonb,text,jsonb\\)',
    'delete_sms_campaign_segment\\(uuid,text,bigint,text,text\\)',
    'restore_sms_campaign_segment\\(uuid,text,bigint\\)'
  ]) {
    assert.match(
      sql,
      new RegExp(`REVOKE ALL ON FUNCTION public\\.${signature} FROM PUBLIC, anon, authenticated`),
      `${signature} must be revoked from anon and authenticated`
    );
    assert.match(
      sql,
      new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${signature} TO service_role`),
      `${signature} must be granted to the service role`
    );
  }
  // Same posture as every other segment RPC.
  const definers = sql.match(/SECURITY DEFINER/g) || [];
  assert.equal(definers.length, 3);
  assert.equal((sql.match(/SET search_path = ''/g) || []).length, 3);
});
