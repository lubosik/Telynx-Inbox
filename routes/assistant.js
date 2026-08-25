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
const threads = require('../lib/assistant/threads');

const ENABLED_VALUE = 'true';
const ELIGIBLE_ROLES = new Set(['owner', 'admin']);

/**
 * ThreadError codes to HTTP statuses.
 *
 * A missing thread and somebody else's thread both answer 404, and that is the
 * whole point of the mapping. A 403 for a thread that exists but is not yours
 * would confirm the id is real, which turns a guess into an enumeration.
 * lib/assistant/threads.js never distinguishes the two cases, so there is
 * nothing here that could leak the difference by accident.
 */
const THREAD_ERROR_STATUS = new Map([
  ['THREAD_NOT_FOUND', 404],
  ['THREAD_TITLE_REQUIRED', 400],
  ['THREAD_LIMIT_REACHED', 409],
  ['THREAD_ACTOR_REQUIRED', 403],
  // Nothing to save is a bad request, not a storage outage. Without this it
  // falls through to the 502 that says conversations could not be reached,
  // which sends somebody looking for a database problem that is not there.
  ['THREAD_EXCHANGE_EMPTY', 400]
]);

function isNamedAdmin(actor) {
  if (!actor || !ELIGIBLE_ROLES.has(String(actor.role || '').toLowerCase())) return false;
  if (actor.isLegacyShared === true || actor.viaLegacySession === true) return false;
  return actor.id !== null && actor.id !== undefined && String(actor.id).trim() !== '';
}

function createAssistantRouter({ env = process.env, services } = {}) {
  const router = express.Router();

  // Lazy, like routes/auth.js. Requiring the client at module load would build
  // a Supabase connection just to enumerate routes, which the offline route
  // policy test does on every run.
  let cachedDb = null;
  function db() {
    if (!cachedDb) cachedDb = services?.db || require('../db').supabase;
    return cachedDb;
  }

  /**
   * Work that runs after the response has been sent.
   *
   * Compaction costs a model call, and it must not be added to the wait for an
   * answer the operator is listening for. Detaching it means a test cannot
   * simply await the request, so the promise is handed to this hook: tests
   * collect and await it, and production ignores it. A silent
   * fire and forget would have made the compaction path untestable, and an
   * untested compaction is the one that quietly loses a conversation.
   */
  const background = services?.background || (promise => {
    promise.catch(error => {
      console.error('[ASSISTANT] background task failed:', error?.message || 'unknown');
    });
  });

  // The agent loop, injectable for the same reason `tools` is: a test of the
  // thread plumbing should not need an OpenRouter key, and a test that reaches
  // a real provider is not a test of the thread plumbing.
  const runConverse = services?.converse || converse;

  function failThread(res, error, what) {
    const status = THREAD_ERROR_STATUS.get(error?.code);
    if (status) {
      return res.status(status).json({ error: error.message, code: error.code });
    }
    // Storage detail is logged and never returned. A PostgREST message can name
    // columns, constraints and table structure.
    console.error(`[ASSISTANT] ${what} failed:`, error?.message || 'unknown');
    return res.status(502).json({
      error: 'Your conversations could not be reached right now.',
      code: 'THREAD_STORE_FAILED'
    });
  }

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

  // ── Threads ───────────────────────────────────────────────────────────────
  //
  // A conversation the operator can name, leave, and come back to. Everything
  // here is scoped to `req.actor.id` inside lib/assistant/threads.js, on every
  // query rather than once at the door: the thread id comes from the client, so
  // it is a claim about ownership and not evidence of it.

  // GET /api/assistant/threads
  router.get('/threads', async (req, res) => {
    if (!gate(req, res)) return;
    res.set('Cache-Control', 'no-store, private');
    try {
      const items = await threads.listThreads({
        client: db(),
        userId: req.actor.id,
        limit: req.query.limit
      });
      return res.json({ threads: items });
    } catch (error) {
      return failThread(res, error, 'listing threads');
    }
  });

  // POST /api/assistant/threads
  router.post('/threads', async (req, res) => {
    if (!gate(req, res)) return;
    res.set('Cache-Control', 'no-store, private');
    try {
      const thread = await threads.createThread({
        client: db(),
        userId: req.actor.id,
        // Optional. A thread created from the New chat button has no name until
        // the first question supplies one.
        title: req.body?.title
      });
      return res.status(201).json({ thread });
    } catch (error) {
      return failThread(res, error, 'creating a thread');
    }
  });

  // GET /api/assistant/threads/:id
  router.get('/threads/:id', async (req, res) => {
    if (!gate(req, res)) return;
    res.set('Cache-Control', 'no-store, private');
    try {
      const { thread, messages } = await threads.getThread({
        client: db(),
        userId: req.actor.id,
        threadId: req.params.id
      });
      return res.json({ thread, messages });
    } catch (error) {
      return failThread(res, error, 'reading a thread');
    }
  });

  // PATCH /api/assistant/threads/:id
  router.patch('/threads/:id', async (req, res) => {
    if (!gate(req, res)) return;
    res.set('Cache-Control', 'no-store, private');
    try {
      const thread = await threads.renameThread({
        client: db(),
        userId: req.actor.id,
        threadId: req.params.id,
        title: req.body?.title
      });
      return res.json({ thread });
    } catch (error) {
      return failThread(res, error, 'renaming a thread');
    }
  });

  // DELETE /api/assistant/threads/:id
  router.delete('/threads/:id', async (req, res) => {
    if (!gate(req, res)) return;
    res.set('Cache-Control', 'no-store, private');
    try {
      const deleted = await threads.deleteThread({
        client: db(),
        userId: req.actor.id,
        threadId: req.params.id
      });
      return res.json({ deleted: deleted.id });
    } catch (error) {
      return failThread(res, error, 'deleting a thread');
    }
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

    // A conversation this question belongs to, if the client named one. Absent
    // is the old behaviour exactly: client-supplied history, nothing stored.
    const threadId = req.body?.threadId ? String(req.body.threadId) : null;

    // HISTORY COMES FROM THE DATABASE WHEN THERE IS A THREAD, AND THE CLIENT'S
    // COPY IS DISCARDED.
    //
    // Not a tidiness preference. `history` is request body, so a caller can
    // send whatever it likes, including turns the assistant never said. Grounding
    // is the property this whole feature rests on, and it is worth nothing if
    // the transcript the model reasons over is attacker supplied. With a thread
    // id the server reads what it actually recorded. Without one there is
    // nothing to read, so the old client-supplied path stands unchanged and is
    // still bounded to six turns.
    let summary = null;
    let history = [];
    if (threadId) {
      try {
        const context = await threads.loadContext({
          client: db(),
          userId: req.actor.id,
          threadId
        });
        summary = context.summary;
        history = context.turns;
      } catch (error) {
        // Before the model call, deliberately. A bad or borrowed thread id
        // should cost nothing and reach nothing.
        return failThread(res, error, 'loading a thread');
      }
    } else {
      history = Array.isArray(req.body?.history)
        ? req.body.history
            .filter(turn => turn && (turn.role === 'user' || turn.role === 'assistant'))
            .slice(-6)
            .map(turn => ({ role: turn.role, content: String(turn.content || '').slice(0, 600) }))
        : [];
    }

    try {
      // Defaults to thorough. A client that does not know about the setting
      // gets the more capable behaviour rather than the faster one.
      const thorough = req.body?.thorough !== false;
      const result = await runConverse({
        question, actor: req.actor, tools: tools(), history, summary, thorough, env
      });

      // Saved before the reply is returned, because a thread with a hole in it
      // is worse than a slow answer, and two inserts are not slow. A failure
      // still returns the answer: the operator asked a question and is owed
      // what came back, even if it could not be filed. `saved: false` is how
      // the app knows not to claim it was kept.
      let saved = null;
      if (threadId) {
        saved = true;
        try {
          await threads.recordExchange({
            client: db(),
            userId: req.actor.id,
            threadId,
            question,
            reply: result.reply,
            toolsUsed: result.toolsUsed
          });
        } catch (error) {
          saved = false;
          console.error('[ASSISTANT] saving a turn failed:', error?.message || 'unknown');
        }
      }

      res.json({
        reply: result.reply,
        toolsUsed: result.toolsUsed,
        refused: result.refused,
        elapsedMs: result.elapsedMs,
        ...(threadId ? { threadId, saved } : {})
      });

      // After the response. Compaction is a second model call, and charging the
      // operator two round trips of silence on every tenth question, on a voice
      // interface, would be a worse feature than a long thread.
      if (threadId && saved) {
        background(threads.compactThreadIfNeeded({
          client: db(),
          userId: req.actor.id,
          threadId,
          env
        }));
      }
      return undefined;
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
