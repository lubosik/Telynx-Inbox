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
 *   For a long time that was true by absence: there was no send tool at all.
 *   The reorder check-in is the business's revenue activity, so the capability
 *   now exists, but only in the shape that keeps the guarantee. The one tool
 *   that concerns sending, `request_campaign_send`, is `kind: 'request'`: it
 *   reads, it returns a QUESTION carrying the true recipient and suppression
 *   counts, and the app puts that question behind Face ID. It performs no
 *   write and holds no transport. The bytes that reach a phone still leave
 *   through the approve and schedule routes, which this file cannot call.
 *
 *   So the property is now: every path from this assistant to a customer runs
 *   through a person's face and through routes the assistant cannot reach.
 *   The three send locks stay shut underneath it as defence in depth.
 *
 * WRITES ARE DRAFTS
 *   Creating a segment or a campaign draft produces reviewable state. Nothing
 *   here reaches a customer. Everything created carries `createdVia:
 *   "assistant"` in its metadata so demo debris can be found and cleared in one
 *   query rather than being indistinguishable from real work.
 */

const ASSISTANT_ORIGIN = 'assistant';

const { customerProfile, findCustomers, recentConversations } = require('./customer-lookup');
const { buildSendConfirmation } = require('./send-request');

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

function buildTools({ segments, campaigns, proposals, referrals, analytics, opportunities }) {
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
      description: 'The revenue opportunities the engine has found, and the ones it refused to size. Each carries an id. Use for "where is the money", "biggest opportunity", "what should we do next", and call this first when asked to draft a campaign, because draft_campaign needs one of these ids.',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        // portfolio.current(), not a method I wished existed. The proposal
        // service has no `opportunities`; the portfolio service does, and it
        // returns the cached computation with its refusals attached.
        const portfolio = await opportunities.current();
        return ok(
          `${portfolio.findings?.length || 0} findings, ${portfolio.refusals?.length || 0} refused to size`,
          {
            findings: (portfolio.findings || []).slice(0, 8).map(finding => ({
              // THE ID IS THE POINT OF THIS LIST.
              //
              // draft_campaign takes an opportunityId and nothing else can
              // produce one. Slimming this payload dropped it, so the model was
              // asked for an identifier it had never been shown and drafting
              // was impossible from inside a conversation.
              id: finding.id,
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
        const revenue = overview?.revenue || {};
        // Slimmed to the figures a person says out loud. The raw payload nests
        // a dozen attribution measures, and handing all of them to the model
        // invites it to read out "weighted attributed value" as though anybody
        // asked for it.
        return ok(`revenue for ${args.period}`, {
          period: args.period,
          totalRevenueImpact: revenue.totalRevenueImpact ?? null,
          attributedRevenue: revenue.attributedRevenue ?? null,
          recoveredRevenue: revenue.recoveredRevenue ?? null,
          orders: overview?.orders?.count ?? overview?.orders ?? null,
          currency: overview?.currency || 'USD',
          // Analytics refuses to report before this date rather than showing a
          // misleadingly small number, and that refusal is worth saying.
          notReadyReason: overview?.notReady || overview?.reason || null
        });
      }
    },

    {
      name: 'find_customer',
      permission: 'contact.read',
      kind: 'read',
      description: 'Find a customer by name or phone number. Use before asking about a specific person.',
      schema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'A name, or any part of a phone number.' } },
        required: ['query'],
        additionalProperties: false
      },
      async run(args) {
        const result = await findCustomers({ query: args.query });
        if (!result.matches?.length) {
          return refuse('no_match', { detail: `Nobody matches "${args.query}".` });
        }
        return ok(`${result.matches.length} match(es)`, { customers: result.matches });
      }
    },
    {
      name: 'customer_profile',
      permission: 'contact.read',
      kind: 'read',
      description: 'One customer in detail: who they are, how many times they have bought, what they bought and when they last ordered. Use after find_customer.',
      schema: {
        type: 'object',
        properties: { phone: { type: 'string', description: 'The exact phone number from find_customer.' } },
        required: ['phone'],
        additionalProperties: false
      },
      async run(args) {
        const profile = await customerProfile({ phone: args.phone });
        if (!profile.found) {
          return refuse(profile.reason || 'no_such_customer', { detail: 'No customer with that number.' });
        }
        return ok(`${profile.customer.name || 'that customer'}: ${profile.orderCount} paid orders`, profile);
      }
    },
    {
      name: 'recent_conversations',
      permission: 'conversation.read',
      kind: 'read',
      description: 'What customers have messaged in recently. Use for "what are people saying" or "anything come in".',
      schema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const result = await recentConversations({});
        return ok(`${result.messages.length} recent inbound messages`, result);
      }
    },

    {
      name: 'open_screen',
      permission: 'campaigns.read',
      kind: 'read',
      description: 'Take the operator to a screen in the app, optionally to one specific thing. Use when asked to show, open, take me to, or go to something. Prefer this over describing a screen the person could simply be shown.',
      schema: {
        type: 'object',
        properties: {
          screen: {
            type: 'string',
            enum: ['inbox', 'contacts', 'growth', 'calls', 'analytics',
                   'automations', 'campaigns', 'audiences', 'opportunities',
                   'campaignProposals', 'referrals', 'activity'],
            description: 'Which part of the app to open.'
          },
          targetId: {
            type: 'string',
            description: 'Optional. An audience id, campaign id, or a customer phone number, to open that one thing rather than the list.'
          }
        },
        required: ['screen'],
        additionalProperties: false
      },
      async run(args) {
        // Returns an INSTRUCTION, it does not navigate. The server cannot move
        // a phone; the app reads this off the reply and performs the move
        // itself, which keeps navigation something the client decides and can
        // refuse. It also means a failed move is the client's to report, not a
        // silent no-op the model would describe as done.
        return ok(`opening ${args.screen}`, {
          navigate: { screen: args.screen, targetId: args.targetId || null }
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
      description: 'Write a draft campaign for one of the revenue opportunities, including the message copy. It is saved for review and is NOT sent. Call list_opportunities first to get an opportunity id.',
      schema: {
        type: 'object',
        properties: {
          opportunityId: {
            type: 'string',
            description: 'The opportunity id from list_opportunities. Campaigns are drafted from an opportunity, not from an audience.'
          }
        },
        required: ['opportunityId'],
        additionalProperties: false
      },
      async run(args, ctx) {
        // Drafting hangs off an opportunity, which is how the product already
        // works: an opportunity carries the audience, the evidence and the
        // mechanism, and the copy writer refuses without them. An earlier
        // version of this tool invented `proposals.draft({segmentID, goal})`,
        // a method that does not exist, so every attempt failed at runtime and
        // came back as "that lookup did not succeed".
        // The same two steps POST /api/campaign-proposals/draft performs:
        // read the server-owned opportunity, then run the compliance-checked
        // writer over it. Reusing them means the assistant inherits the copy
        // rules and the refusals rather than a looser second implementation.
        const opportunity = await opportunities.read(String(args.opportunityId || ''));
        if (!opportunity) {
          return refuse('opportunity_not_found', {
            detail: 'That opportunity is not in the current portfolio. Call list_opportunities again.'
          });
        }
        const result = await proposals.draftProposals({ opportunity, opportunitySource: 'detector' });
        if (!result?.proposals?.length) {
          return refuse('could_not_draft', {
            // The writer's own refusals, by rule identity. The refused draft
            // text deliberately never leaves that process, so there is nothing
            // here for anybody to lift out and paste into a campaign.
            detail: 'No compliant copy could be produced for that opportunity.',
            refusedRules: (result?.refused || []).map(r => r.rule || r.code).filter(Boolean).slice(0, 5)
          });
        }
        const saved = await proposals.saveBatch(result.proposals, { model: result.model });
        const first = result.proposals[0];
        return ok(`${result.proposals.length} draft(s) created and waiting for review`, {
          savedIds: (saved?.saved || []).map(item => item.id).slice(0, 5),
          audience: first.segmentName || opportunity.title || null,
          message: first.message || first.copy || null,
          status: 'awaiting_approval',
          createdVia: ASSISTANT_ORIGIN
        });
      }
    },

    // ---- REQUEST. Asks the operator for a face. Still cannot reach anybody. ----

    {
      name: 'request_campaign_send',
      permission: 'campaigns.launch',
      kind: 'request',
      description: 'Ask the operator to confirm sending a campaign that is already drafted. This does NOT send. It returns the real recipient count and who was suppressed, and the person must confirm with Face ID before anything goes out. Call list_campaigns first to get a campaign id.',
      schema: {
        type: 'object',
        properties: {
          campaignId: {
            type: 'string',
            description: 'The campaign id from list_campaigns or draft_campaign.'
          }
        },
        required: ['campaignId'],
        additionalProperties: false
      },
      async run(args, ctx) {
        // Reads only. The confirmation it returns is carried out of the loop
        // by converse() the same way a navigation instruction is, and the app
        // is what decides to show it. A server cannot scan a face, and it
        // deliberately cannot send on the strength of having asked.
        const outcome = await buildSendConfirmation({
          campaignId: args.campaignId,
          campaigns,
          actor: ctx?.actor
        });
        if (!outcome.ok) return refuse(outcome.reason, outcome);

        const { confirmSend } = outcome;
        // The summary is what the model will speak, so it says the number out
        // loud including the suppressed one. "Send to 41 people" and "send to
        // 41 of 900, the other 859 have no recorded consent" are different
        // decisions and the operator is entitled to make the second one.
        const suppressedNote = confirmSend.suppressed > 0
          ? `, ${confirmSend.suppressed} suppressed`
          : '';
        return ok(
          `waiting for your confirmation to send to ${confirmSend.recipients} ${confirmSend.recipients === 1 ? 'person' : 'people'}${suppressedNote}`,
          { confirmSend }
        );
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
