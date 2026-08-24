'use strict';
/**
 * lib/assistant/tools.js — everything the assistant is allowed to do.
 *
 * THE PERMISSION ON EACH TOOL IS THE WHOLE SECURITY MODEL
 *   Every tool names the permission its own HTTP route requires, and the
 *   dispatcher checks it against the caller's actor before the handler runs.
 *   Without that, the assistant becomes a privilege escalation path: a Support
 *   Agent asking a question in English to reach data their session could not
 *   fetch directly. `test/assistant-tools.test.js` asserts every tool's
 *   permission matches the route in lib/route-policy.js that performs the same
 *   work, so the two cannot drift.
 *
 * NO TOOL SENDS ANYTHING
 *   There is deliberately no send, launch, approve or schedule tool. Not
 *   disabled, not permission-gated: absent. A tool that does not exist cannot
 *   be called by a confused model, a crafted customer message, or a demo that
 *   went further than intended. The three existing send locks stay shut
 *   underneath this as defence in depth, but the first defence is that the
 *   capability was never handed over.
 *
 * WRITES ARE DRAFTS
 *   Creating a segment or a campaign draft produces reviewable state. Nothing
 *   here reaches a customer. Everything created carries `createdVia:
 *   "assistant"` in its metadata so demo debris can be found and cleared in one
 *   query rather than being indistinguishable from real work.
 */

const ASSISTANT_ORIGIN = 'assistant';

/**
 * @typedef {object} AssistantTool
 * @property {string}   name
 * @property {string}   permission   the same key the equivalent route requires
 * @property {'read'|'prepare'} kind
 * @property {object}   schema       JSON Schema for the arguments
 * @property {Function} run          (args, context) => Promise<object>
 */

/** Small helper so every handler returns the same envelope. */
function ok(summary, data = {}) {
  return { ok: true, summary, ...data };
}

function refuse(reason, detail = {}) {
  return { ok: false, reason, ...detail };
}

/**
 * Reads are shaped down before they reach the model.
 *
 * A raw segment page is thousands of tokens of ids, timestamps and rule
 * versions, and every one of them is a chance for the model to quote something
 * meaningless back as though it mattered. Only fields a person would say out
 * loud survive this.
 */
function slimSegment(segment) {
  return {
    id: segment.id,
    name: segment.name,
    people: segment.memberCount,
    purpose: segment.statedPurpose || segment.description || null,
    kind: segment.kind,
    lastComputedAt: segment.lastComputedAt || null
  };
}

function slimCampaign(campaign) {
  return {
    id: campaign.id,
    title: campaign.title,
    status: campaign.status,
    recipients: campaign.recipientCount ?? null,
    createdAt: campaign.createdAt || null
  };
}

function buildTools({ segments, campaigns, proposals, referrals, analytics }) {
  /** @type {AssistantTool[]} */
  const tools = [
    {
      name: 'list_audiences',
      permission: 'campaigns.read',
      kind: 'read',
      description: 'List the customer audiences (segments), with how many people are in each and why each exists. Use this for questions about audiences, groups, or how many customers match something.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async run(_args, ctx) {
        const page = await segments.list({ page: 1, pageSize: 50 });
        const items = (page?.segments?.items || page?.items || []).map(slimSegment);
        return ok(`${items.length} audiences`, { audiences: items });
      }
    },
    {
      name: 'explain_audience',
      permission: 'campaigns.read',
      kind: 'read',
      description: 'Explain one audience: who is in it and the recorded reason each person matched. Use when asked why somebody is in a group, or to look inside one audience.',
      schema: {
        type: 'object',
        properties: { audienceId: { type: 'string', description: 'The audience id from list_audiences.' } },
        required: ['audienceId'],
        additionalProperties: false
      },
      async run(args, ctx) {
        const detail = await segments.detail(args.audienceId, { page: 1, pageSize: 5 });
        const members = (detail?.members?.items || []).map(member => ({
          name: member.contactName || member.contactPhone,
          reason: member.inclusionEvidence?.summary
            || member.inclusionEvidence?.cohortKey
            || 'recorded evidence available in the app'
        }));
        return ok(`${detail.segment.name}: ${detail.members?.total ?? members.length} people`, {
          audience: slimSegment(detail.segment),
          totalPeople: detail.members?.total ?? members.length,
          sampleMembers: members
        });
      }
    },
    {
      name: 'why_is_this_person_in_audiences',
      permission: 'campaigns.read',
      kind: 'read',
      description: 'Every audience one customer belongs to and the reason for each. Use when asked about a specific person by phone number.',
      schema: {
        type: 'object',
        properties: { phone: { type: 'string', description: 'The customer phone number.' } },
        required: ['phone'],
        additionalProperties: false
      },
      async run(args) {
        const summary = await segments.personMemberships(args.phone);
        return ok(`in ${summary.total} audiences`, {
          audiences: (summary.memberships || []).map(entry => ({
            name: entry.segment.name,
            archived: entry.archived,
            reason: entry.member?.inclusionEvidence?.cohortKey || entry.segment.statedPurpose || null
          }))
        });
      }
    },
    {
      name: 'list_campaigns',
      permission: 'campaigns.read',
      kind: 'read',
      description: 'List campaigns and their status. Use for questions about what campaigns exist, what is waiting for review, or what has run.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const page = await campaigns.list({ page: 1, pageSize: 25 });
        const items = (page?.campaigns?.items || page?.items || []).map(slimCampaign);
        return ok(`${items.length} campaigns`, { campaigns: items });
      }
    },
    {
      name: 'list_opportunities',
      permission: 'campaigns.read',
      kind: 'read',
      description: 'The revenue opportunities the engine has found, and the ones it refused to size. Use for "where is the money", "biggest opportunity", "what should we do next".',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const portfolio = await proposals.opportunities();
        return ok(
          `${portfolio.findings?.length || 0} findings, ${portfolio.refusals?.length || 0} refused to size`,
          {
            findings: (portfolio.findings || []).slice(0, 8).map(finding => ({
              title: finding.title,
              people: finding.audienceSize ?? null,
              mechanism: finding.mechanism || null
            })),
            // Refusals are surfaced, not hidden. "I cannot size that, and here
            // is why" is a real answer and the engine already produces it.
            refusedToSize: (portfolio.refusals || []).slice(0, 5).map(r => ({
              title: r.title || r.key, reason: r.reason
            }))
          }
        );
      }
    },
    {
      name: 'list_referrals',
      permission: 'referral.read',
      kind: 'read',
      description: 'Conversations teammates have referred, and who they went to. Use for "what has been passed to me", "what did somebody hand over".',
      schema: {
        type: 'object',
        properties: { box: { type: 'string', enum: ['inbox', 'sent'], description: 'inbox = referred to me, sent = I referred it.' } },
        additionalProperties: false
      },
      async run(args, ctx) {
        const box = args.box === 'sent' ? 'sent' : 'inbox';
        const page = await referrals.list({ box, actor: ctx.actor, page: 1, pageSize: 25 });
        return ok(`${page?.items?.length || 0} referrals in ${box}`, {
          referrals: (page?.items || []).map(item => ({
            customer: item.contactName || item.contactPhone,
            state: item.state,
            note: item.note || null
          }))
        });
      }
    },
    {
      name: 'get_revenue',
      permission: 'analytics.read',
      kind: 'read',
      description: 'Revenue and order figures for a period. Use for "how much did we make", "how are we doing", "revenue this week".',
      schema: {
        type: 'object',
        properties: {
          period: {
            type: 'string',
            enum: ['today', 'week', 'month', 'year', 'all'],
            description: 'Which window to report.'
          }
        },
        required: ['period'],
        additionalProperties: false
      },
      async run(args) {
        const overview = await analytics.overview({ period: args.period });
        return ok(`revenue for ${args.period}`, {
          period: args.period,
          revenue: overview?.revenue ?? null,
          orders: overview?.orders ?? null,
          currency: overview?.currency || 'USD'
        });
      }
    },

    // ---- PREPARE. Creates reviewable state. Still cannot reach a customer. ----

    {
      name: 'create_audience_from_description',
      permission: 'campaigns.manage',
      kind: 'prepare',
      description: 'Build a new customer audience from a plain-English description, for example "people who bought once over 200 dollars and have not returned in 90 days". Creates it for review. Does not message anybody.',
      schema: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Plain English description of who should be in it.' },
          name: { type: 'string', description: 'A short name for the audience.' }
        },
        required: ['description'],
        additionalProperties: false
      },
      async run(args, ctx) {
        // draftRules is the existing plain-English to rules path, already
        // validated and already able to say "I cannot express that". Reusing it
        // means the assistant inherits those refusals rather than inventing a
        // second, weaker interpretation of the same sentence.
        const draft = await segments.draftRules({ description: args.description });
        if (!draft?.rules) {
          return refuse('could_not_express_that', {
            detail: draft?.reason || 'That description could not be turned into rules this system can evaluate.',
            questions: draft?.questions || []
          });
        }
        const preview = await segments.previewRules({ rules: draft.rules });
        const created = await segments.createFromRules({
          name: args.name || draft.suggestedName || 'Assistant audience',
          description: args.description,
          rules: draft.rules,
          origin: ASSISTANT_ORIGIN
        }, ctx.actor);
        return ok(`created "${created.segment.name}" with ${preview?.total ?? 0} people`, {
          audience: slimSegment(created.segment),
          people: preview?.total ?? null,
          createdVia: ASSISTANT_ORIGIN
        });
      }
    },
    {
      name: 'draft_campaign',
      permission: 'campaigns.manage',
      kind: 'prepare',
      description: 'Write a draft campaign for an audience, including the message copy. It is saved for review and is NOT sent. Use for "write a campaign for", "draft an offer to".',
      schema: {
        type: 'object',
        properties: {
          audienceId: { type: 'string', description: 'Audience id from list_audiences.' },
          goal: { type: 'string', description: 'What the campaign should achieve, in plain English.' }
        },
        required: ['audienceId', 'goal'],
        additionalProperties: false
      },
      async run(args, ctx) {
        const drafted = await proposals.draft({
          segmentID: args.audienceId,
          goal: args.goal,
          origin: ASSISTANT_ORIGIN,
          actor: ctx.actor
        });
        if (!drafted?.proposal) {
          return refuse('could_not_draft', { detail: drafted?.reason || 'No compliant copy could be produced for that audience.' });
        }
        return ok('draft created and waiting for review', {
          proposalId: drafted.proposal.id,
          audience: drafted.proposal.segmentName || null,
          message: drafted.proposal.message || drafted.proposal.copy || null,
          status: 'awaiting_approval',
          createdVia: ASSISTANT_ORIGIN
        });
      }
    }
  ];

  return tools;
}

/** OpenAI-shape definitions for the model. */
function toolDefinitions(tools) {
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.schema
    }
  }));
}

/**
 * The tools this actor may actually use.
 *
 * Filtering here rather than refusing at call time is deliberate: a tool the
 * model cannot see is a tool it cannot promise. Showing a Support Agent a
 * `draft_campaign` tool and then refusing it produces an assistant that offers
 * things it cannot do, which reads as broken rather than as secure.
 */
function permittedTools(tools, actor) {
  const held = actor?.permissions instanceof Set
    ? actor.permissions
    : new Set(Array.isArray(actor?.permissions) ? actor.permissions : []);
  return tools.filter(tool => held.has(tool.permission));
}

module.exports = {
  ASSISTANT_ORIGIN,
  buildTools,
  permittedTools,
  toolDefinitions
};
