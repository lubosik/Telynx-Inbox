#!/usr/bin/env node
'use strict';

/**
 * Privacy-preserving historical sentiment classifier.
 *
 * Default mode is aggregate-only and read-only. It never prints message bodies
 * or phone numbers. Persistence requires --persist plus the exact environment
 * gate ANALYTICS_BACKFILL_APPROVED=YES.
 */

const path = require('node:path');
const { normalizePhone } = require('../woocommerce');
const { CLASSIFIER_VERSION, classifyLocalSentiment } = require('../lib/analytics/sentiment');

const WORKSPACE_ID = 'vici';
const PAGE_SIZE = 1000;

function parseCSV(value) {
  return new Set(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
}

function parseArgs(argv) {
  const args = { persist: false };
  for (const arg of argv) {
    if (arg === '--persist') args.persist = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function persistenceAllowed(args, env = process.env) {
  return args.persist === true && env.ANALYTICS_BACKFILL_APPROVED === 'YES';
}

function prepareSentimentCandidates(messages, options = {}) {
  const excludedPhones = options.excludedPhones || new Set();
  const seen = new Set();
  const candidates = [];
  const excluded = { non_inbound: 0, internal_or_test: 0, reply_or_reaction: 0, invalid_metadata: 0, empty_or_tapback: 0, ambiguous: 0, duplicate: 0 };

  for (const message of messages || []) {
    if (message?.direction !== 'inbound') { excluded.non_inbound += 1; continue; }
    const phone = normalizePhone(message.contact_phone);
    if (phone && excludedPhones.has(phone)) { excluded.internal_or_test += 1; continue; }
    if (message.reply_to_message_id || (message.reactions && Object.keys(message.reactions).length)) {
      excluded.reply_or_reaction += 1;
      continue;
    }
    const messageID = message?.id ?? message?.message_id;
    if (messageID === null || messageID === undefined || !message.created_at || !Number.isFinite(Date.parse(message.created_at))) {
      excluded.invalid_metadata += 1;
      continue;
    }
    const uniqueKey = `${messageID}:${CLASSIFIER_VERSION}`;
    if (seen.has(uniqueKey)) { excluded.duplicate += 1; continue; }
    seen.add(uniqueKey);

    const result = classifyLocalSentiment(message.body);
    if (!result.eligible) {
      if (result.reason === 'ambiguous_mixed') excluded.ambiguous += 1;
      else excluded.empty_or_tapback += 1;
      continue;
    }
    candidates.push({
      workspace_id: WORKSPACE_ID,
      message_id: String(messageID),
      occurred_at: message.created_at,
      score: result.score,
      label: result.label,
      classifier: result.classifier,
      classifier_version: result.classifierVersion,
      model: null,
      confidence: result.score === 0 ? 0.55 : 0.8
    });
  }

  const distribution = { very_negative: 0, negative: 0, neutral: 0, positive: 0, very_positive: 0 };
  let scoreTotal = 0;
  for (const candidate of candidates) {
    distribution[candidate.label] += 1;
    scoreTotal += candidate.score;
  }
  return {
    candidates,
    aggregate: {
      classifier_version: CLASSIFIER_VERSION,
      messages_examined: (messages || []).length,
      messages_eligible: candidates.length,
      excluded,
      distribution,
      average_score: candidates.length ? Number((scoreTotal / candidates.length).toFixed(3)) : null
    }
  };
}

async function fetchAllInbound(client) {
  const rows = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const { data, error } = await client.from('sms_messages')
      .select('id,direction,contact_phone,body,created_at,reply_to_message_id,reactions,media_urls')
      .eq('direction', 'inbound')
      .range(start, start + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function persistCandidates(client, candidates) {
  let persisted = 0;
  for (let index = 0; index < candidates.length; index += 250) {
    const chunk = candidates.slice(index, index + 250);
    const { error } = await client.from('message_sentiment').upsert(chunk, {
      onConflict: 'workspace_id,message_id,classifier_version',
      ignoreDuplicates: true
    });
    if (error) throw error;
    persisted += chunk.length;
  }
  return persisted;
}

function usage() {
  return 'Usage: node scripts/backfill-sentiment.js [--persist]\n\nDefault is a read-only aggregate dry run. Persistence also requires ANALYTICS_BACKFILL_APPROVED=YES.\n';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return console.log(usage());
  if (args.persist && !persistenceAllowed(args)) {
    throw new Error('Persistence refused: pass --persist AND set ANALYTICS_BACKFILL_APPROVED=YES after manual approval.');
  }
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  const { supabase } = require('../db');
  const excludedPhones = new Set([...parseCSV(process.env.ANALYTICS_EXCLUDED_PHONES)].map(normalizePhone).filter(Boolean));
  const messages = await fetchAllInbound(supabase);
  const analysis = prepareSentimentCandidates(messages, { excludedPhones });
  const output = { mode: args.persist ? 'persist' : 'dry_run', ...analysis.aggregate };
  if (args.persist) output.rows_submitted_idempotently = await persistCandidates(supabase, analysis.candidates);
  console.log(JSON.stringify(output, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[SENTIMENT BACKFILL] ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, persistenceAllowed, prepareSentimentCandidates };
