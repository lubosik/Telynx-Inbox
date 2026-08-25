'use strict';
/**
 * routes/assistant.js - remote capability gate for the native assistant.
 *
 * Reasoning moved off the device on 24 Aug 2026. It now runs through
 * lib/openrouter-private.js, which is the existing privacy boundary: approved
 * models only, Zero Data Retention required, data collection denied, and
 * sensitive values tokenised before they leave. The question text does leave
 * the device, which the on-device build did not do, and the in-app privacy copy
 * has to say so.
 *
 * Business facts still come only from the existing services, reached through
 * tools that each name the permission their equivalent route requires. There is
 * no send tool, and its absence is the point: a capability that does not exist
 * cannot be reached by a confused model or a crafted customer message.
 *
 * Two independent gates apply:
 *   1. route policy requires assistant.use;
 *   2. this handler requires a named Owner/Admin actor.
 *
 * The second gate prevents a mistaken per-user grant from enabling the pilot
 * for a Support Agent, and prevents the shared identity from using a feature
 * whose transcript and actions need one accountable person.
 */

const express = require('express');

const { converse } = require('../lib/assistant/converse');
const { buildTools, permittedTools } = require('../lib/assistant/tools');
const { searchVoices, speak } = require('../lib/assistant/voice');
const { createCampaignService } = require('../lib/campaigns/service');
const { createAnalyticsService } = require('../lib/analytics/aggregate');
const { createOpportunityPortfolioService } = require('../lib/campaigns/opportunity-portfolio');
const { createProposalService } = require('../lib/campaigns/proposal-service');
const { draftProposals } = require('../lib/campaigns/proposal-writer');
const { createReferralService } = require('../lib/referrals/service');
const { createSegmentService } = require('../lib/campaigns/segment-service');

const ENABLED_VALUE = 'true';
const ELIGIBLE_ROLES = new Set(['owner', 'admin']);

function isNamedAdmin(actor) {
  if (!actor || !ELIGIBLE_ROLES.has(String(actor.role || '').toLowerCase())) return false;
  if (actor.isLegacyShared === true || actor.viaLegacySession === true) return false;
  return actor.id !== null && actor.id !== undefined && String(actor.id).trim() !== '';
}

function createAssistantRouter({ env = process.env, services } = {}) {
  const router = express.Router();

  // Built once. Each tool closes over a real service, so the assistant runs the
  // same audited code the app's own screens do rather than a parallel
  // implementation that could drift from it.
  let cachedTools = null;
  function tools() {
    if (cachedTools) return cachedTools;
    const portfolio = services?.opportunities || createOpportunityPortfolioService();
    const proposalService = services?.proposals || createProposalService();
    cachedTools = services?.tools || buildTools({
      segments: services?.segments || createSegmentService(),
      campaigns: services?.campaigns || createCampaignService(),
      // Composed here rather than assumed on the service. The proposal service
      // exposes accept/dismiss/get/list/saveBatch and nothing that drafts; the
      // writer is a separate module. An earlier version of the tools called
      // proposals.draft(), which does not exist, so every attempt to draft a
      // campaign failed at runtime and surfaced as "that lookup did not
      // succeed".
      proposals: Object.assign(Object.create(proposalService), {
        draftProposals: services?.draftProposals || draftProposals
      }),
      referrals: services?.referrals || createReferralService(),
      // The analytics SERVICE, not lib/campaigns/analytics. That module holds
      // campaign attribution helpers and has no overview; the overview the app
      // shows comes from lib/analytics/service via /api/analytics/overview.
      analytics: services?.analytics
        || createAnalyticsService({ client: require('../db').supabase }),
      opportunities: {
        current: async () => {
          const payload = await portfolio.current();
          return payload || { findings: [], refusals: [] };
        },
        read: async id => {
          const payload = await portfolio.current();
          return (payload?.findings || []).find(f => String(f.id) === String(id)) || null;
        }
      }
    });
    return cachedTools;
  }

  function gate(req, res) {
    if (!isNamedAdmin(req.actor)) {
      res.status(403).json({
        error: 'The assistant is available only to named Owner and Admin accounts.',
        code: 'ASSISTANT_NAMED_ADMIN_REQUIRED'
      });
      return false;
    }
    if (env.ASSISTANT_ENABLED !== ENABLED_VALUE) {
      res.status(503).json({ error: 'The assistant is not switched on.', code: 'ASSISTANT_DISABLED' });
      return false;
    }
    return true;
  }

  router.get('/status', (req, res) => {
    res.set('Cache-Control', 'no-store, private');

    if (!isNamedAdmin(req.actor)) {
      return res.status(403).json({
        error: 'The assistant pilot is available only to named Owner and Admin accounts.',
        code: 'ASSISTANT_NAMED_ADMIN_REQUIRED'
      });
    }

    const enabled = env.ASSISTANT_ENABLED === ENABLED_VALUE;
    return res.json({
      enabled,
      mode: 'on_device_read_only',
      minimumOSMajor: 26,
      reason: enabled ? null : 'pilot_disabled'
    });
  });

  // ── POST /api/assistant/converse ──────────────────────────────────────────
  // One question in, one spoken-shaped answer out, grounded in tool results.
  router.post('/converse', async (req, res) => {
    if (!gate(req, res)) return;
    const question = String(req.body?.question || '').trim();
    if (!question) return res.status(400).json({ error: 'A question is required.', code: 'QUESTION_REQUIRED' });
    // Bounded so one request cannot become an essay, and so a stuck dictation
    // cannot send a megabyte of transcript.
    if (question.length > 600) {
      return res.status(400).json({ error: 'That question is too long.', code: 'QUESTION_TOO_LONG' });
    }

    res.set('Cache-Control', 'no-store, private');
    try {
      const history = Array.isArray(req.body?.history)
        ? req.body.history
            .filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant'))
            .slice(-6)
            .map(turn => ({ role: turn.role, content: String(turn.content || '').slice(0, 600) }))
        : [];
      // Defaults to thorough. A client that does not know about the setting
      // gets the more capable behaviour rather than the faster one.
      const thorough = req.body?.thorough !== false;
      const result = await converse({ question, actor: req.actor, tools: tools(), history, thorough, env });
      return res.json({
        reply: result.reply,
        toolsUsed: result.toolsUsed,
        refused: result.refused,
        elapsedMs: result.elapsedMs
      });
    } catch (error) {
      // LOGGED HERE, NEVER RETURNED.
      //
      // The client gets a message with no provider detail in it, because that
      // detail can carry the prompt back out. But swallowing it entirely cost
      // real time once already: a dead OPENROUTER_API_KEY on Railway made every
      // question fail, the app showed a generic "could not finish that
      // response", and there was nothing in the logs to point at the 401. The
      // message and status are enough to tell a bad credential from a timeout
      // without printing anything sensitive.
      console.error('[ASSISTANT] converse failed:', error?.message || 'unknown');
      return res.status(502).json({ error: 'The assistant could not answer that right now.', code: 'ASSISTANT_UPSTREAM_FAILED' });
    }
  });

  // ── POST /api/assistant/speak ─────────────────────────────────────────────
  // Text in, audio out. The ElevenLabs key stays here.
  router.post('/speak', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const { audio, contentType } = await speak({
        text: req.body?.text,
        voiceID: req.body?.voiceId,
        env
      });
      res.set('Cache-Control', 'no-store, private');
      res.set('Content-Type', contentType);
      return res.send(audio);
    } catch (error) {
      const code = error?.code || 'VOICE_FAILED';
      console.error('[ASSISTANT] speak failed:', code, error?.message || '');
      const status = code === 'VOICE_NOT_CONFIGURED' ? 503 : code === 'EMPTY_TEXT' ? 400 : 502;
      return res.status(status).json({ error: 'Speech could not be produced.', code });
    }
  });

  // ── GET /api/assistant/voices ─────────────────────────────────────────────
  // The searchable library behind the Settings picker.
  router.get('/voices', async (req, res) => {
    if (!gate(req, res)) return;
    try {
      const result = await searchVoices({
        query: req.query.q,
        gender: req.query.gender,
        accent: req.query.accent,
        page: Number.parseInt(req.query.page, 10) || 0,
        env
      });
      // Public catalogue content, and it costs a provider round trip, so a
      // short private cache is worth more than the freshness it gives up.
      res.set('Cache-Control', 'private, max-age=600');
      return res.json(result);
    } catch (error) {
      const code = error?.code || 'VOICE_SEARCH_FAILED';
      return res.status(code === 'VOICE_NOT_CONFIGURED' ? 503 : 502)
        .json({ error: 'The voice library could not be reached.', code });
    }
  });

  return router;
}

module.exports = createAssistantRouter;
module.exports.isNamedAdmin = isNamedAdmin;
