'use strict';
/**
 * lib/route-policy.js — the single declarative source of truth for which
 * permission each authenticated `/api` endpoint requires.
 *
 * RULES
 *   1. Every `/api` endpoint registered on the Express app must appear here
 *      exactly once. test/route-policy.test.js asserts that bijection, so
 *      adding an endpoint without a policy fails CI instead of shipping open.
 *   2. `permission: null` means "any authenticated actor, no specific
 *      permission". It is spelled explicitly, and used ONLY for
 *      `/api/users/me/...` endpoints that act on the caller's own account, so
 *      a MISSING entry can never be mistaken for an intentional one. A request
 *      that matches no entry is denied — see lib/enforce-policy.js.
 *   3. Paths are absolute and include the `/api` mount prefix, because
 *      enforcement reads the full request URL rather than a mount-relative
 *      path.
 *
 *      COROLLARY: `/auth/*` IS NOT IN THIS TABLE AND MUST NOT BE ADDED.
 *      lib/enforce-policy.js is mounted on '/api' only, so it never sees an
 *      /auth path, and `test/route-policy.test.js` builds its bijection from
 *      the `/api` mounts in server.js — an /auth entry here would be dangling
 *      and would FAIL that test, not tighten anything. The public,
 *      unauthenticated, token-bearing endpoints are:
 *
 *        POST /auth/login
 *        POST /auth/logout
 *        GET  /auth/check
 *        POST /auth/invitation/accept          holds an invitation token
 *        POST /auth/email-change/confirm       holds an email-change token
 *        POST /auth/password-reset/request     public, takes an email address
 *        POST /auth/password-reset/confirm     holds a password-reset token
 *
 *      Each of them is public because the caller has no session and cannot get
 *      one first, each is rate limited in routes/auth.js, and each verifies its
 *      own single credential. They are listed here because "which endpoints
 *      are outside the policy table?" should have a written answer rather than
 *      being something the next reader has to derive from server.js.
 *   4. `audit: true` marks an action worth recording beyond ordinary request
 *      logging: it changes who can do what, spends money, or messages
 *      customers in bulk.
 *
 *      The enforcer does NOT write the row — it copies the flag onto
 *      `req.policy` and nothing else. The handler must call `logAudit` or
 *      `logAuditSafely` itself. That made the flag easy to get wrong:
 *      `POST /api/voice/backfill-recordings` carried it while its handler
 *      wrote nothing, so this table asserted coverage the code did not
 *      provide, and the next reader had no way to tell which entries were
 *      real. `test/route-policy.test.js` now fails when a flagged route's
 *      handler contains no audit call, so the flag means what it says.
 *      Set it only when you are also instrumenting the handler.
 *
 *      DELIBERATELY UNFLAGGED, AND WHY: `POST /api/users/me/email/cancel`
 *      abandons a pending request. Nothing about the account changes, the
 *      request that opened it is already recorded as
 *      `team.member.email_change_requested`, and the endpoint answers the same
 *      200 whether or not there was anything to cancel — so a row here would
 *      record the absence of an event as an event.
 *
 *      `GET /api/users/me/timezones` is unflagged because it is a read of a
 *      constant list. It touches no account and returns the same document to
 *      everybody.
 *
 * ROLE SUMMARY (grants live in scripts/rbac-migration.sql, not here)
 *   owner  — every permission.
 *   admin  — every permission except user.manage.owner.
 *   legacy — same as admin, deliberately, for the shared-password rollout.
 *   agent  — conversations, messages, contacts, calls, and their own device.
 *            No automation.cancel, analytics, catch-up, sync.run, user
 *            management, backfills, or audit access.
 */

/**
 * @typedef {Object} PolicyEntry
 * @property {string} method  Uppercase HTTP method.
 * @property {string} path    Full path, express-style params (`/:id`).
 * @property {string|null} permission  Required permission key, or null.
 * @property {boolean} [audit]
 */

/** @type {PolicyEntry[]} */
const ROUTE_POLICY = [
  // ── Realtime ──────────────────────────────────────────────────────────────
  { method: 'GET',    path: '/api/sse',                          permission: 'realtime.subscribe' },

  // ── Messaging ─────────────────────────────────────────────────────────────
  { method: 'POST',   path: '/api/send',                         permission: 'message.send' },
  { method: 'POST',   path: '/api/upload',                       permission: 'message.send' },
  { method: 'POST',   path: '/api/react',                        permission: 'message.send' },

  // ── Conversations ─────────────────────────────────────────────────────────
  { method: 'GET',    path: '/api/conversations',                permission: 'conversation.read' },
  { method: 'GET',    path: '/api/conversations/:phone',         permission: 'conversation.read' },

  // ── Conversation referrals ───────────────────────────────────────────────
  { method: 'GET',    path: '/api/referrals/recipients',         permission: 'referral.create' },
  { method: 'GET',    path: '/api/referrals',                    permission: 'referral.read' },
  { method: 'GET',    path: '/api/referrals/:id',                permission: 'referral.read' },
  { method: 'POST',   path: '/api/referrals',                    permission: 'referral.create', audit: true },
  { method: 'POST',   path: '/api/referrals/:id/claim',          permission: 'referral.act', audit: true },
  { method: 'POST',   path: '/api/referrals/:id/reassign',       permission: 'referral.act', audit: true },
  { method: 'POST',   path: '/api/referrals/:id/hand-back',      permission: 'referral.act', audit: true },
  { method: 'POST',   path: '/api/referrals/:id/resolve',        permission: 'referral.act', audit: true },

  // ── Contacts ──────────────────────────────────────────────────────────────
  { method: 'GET',    path: '/api/contacts',                     permission: 'contact.read' },
  { method: 'GET',    path: '/api/contacts/:phone',              permission: 'contact.read' },
  { method: 'POST',   path: '/api/contacts',                     permission: 'contact.write' },
  { method: 'PATCH',  path: '/api/contacts/:phone',              permission: 'contact.write' },

  // ── Automation activity ───────────────────────────────────────────────────
  { method: 'GET',    path: '/api/activity/stats',               permission: 'automation.read' },
  { method: 'GET',    path: '/api/activity/queue',               permission: 'automation.read' },
  { method: 'GET',    path: '/api/activity/recent',              permission: 'automation.read' },
  // Cancelling a queued automation suppresses a customer message. Admin only.
  { method: 'DELETE', path: '/api/activity/queue/:id',           permission: 'automation.cancel', audit: true },

  // ── Voice ─────────────────────────────────────────────────────────────────
  // /token additionally requires the native iOS client marker, enforced in the
  // handler. This permission gates *who*, the client check gates *what*.
  { method: 'GET',    path: '/api/voice/token',                  permission: 'voice.token' },
  { method: 'GET',    path: '/api/voice/logs',                   permission: 'call.read' },
  { method: 'GET',    path: '/api/voice/missed-count',           permission: 'call.read' },
  // Literal, and must be listed before GET /api/voice/logs/:id can shadow it.
  // Ordering is enforced by the compiler, not by this file's line order.
  { method: 'POST',   path: '/api/voice/logs/seen',              permission: 'call.read' },
  { method: 'GET',    path: '/api/voice/logs/:id',               permission: 'call.read' },
  { method: 'POST',   path: '/api/voice/logs',                   permission: 'call.log' },
  { method: 'GET',    path: '/api/voice/recordings/:id',         permission: 'call.recording.play' },
  { method: 'POST',   path: '/api/voice/recording/start',        permission: 'call.recording.control' },
  { method: 'POST',   path: '/api/voice/recording/stop',         permission: 'call.recording.control' },
  // Pulls every recording from the Telnyx account. This endpoint previously
  // sat behind session auth only, bypassing the /admin Bearer gate that the
  // identical /admin/backfill/recordings job uses. That was a real hole.
  { method: 'POST',   path: '/api/voice/backfill-recordings',    permission: 'admin.backfill', audit: true },

  // ── Intelligence ──────────────────────────────────────────────────────────
  { method: 'GET',    path: '/api/intelligence/campaigns/overview', permission: 'intelligence.manage' },
  { method: 'GET',    path: '/api/intelligence/campaigns/all',      permission: 'intelligence.manage' },
  { method: 'POST',   path: '/api/intelligence/campaigns/:id/dismiss', permission: 'intelligence.manage', audit: true },
  // Sends SMS to a segment of customers. Admin only.
  { method: 'POST',   path: '/api/intelligence/campaigns/:id/send',   permission: 'intelligence.send', audit: true },
  { method: 'POST',   path: '/api/intelligence/analyse/:phone',    permission: 'intelligence.read' },
  { method: 'GET',    path: '/api/intelligence/:phone',            permission: 'intelligence.read' },

  // ── Sync ──────────────────────────────────────────────────────────────────
  { method: 'GET',    path: '/api/sync/status',                  permission: 'sync.read' },
  { method: 'POST',   path: '/api/sync/ghl',                     permission: 'sync.run', audit: true },
  { method: 'POST',   path: '/api/sync/woocommerce',             permission: 'sync.run', audit: true },
  { method: 'POST',   path: '/api/sync/statuses',                permission: 'sync.run', audit: true },
  { method: 'POST',   path: '/api/sync/import',                  permission: 'sync.import', audit: true },
  { method: 'POST',   path: '/api/sync/seed-from-bridge',        permission: 'sync.import', audit: true },

  // ── Catch-up ──────────────────────────────────────────────────────────────
  // Both are Admin only: the preview reveals the whole unanswered backlog and
  // the send messages every customer in it.
  { method: 'GET',    path: '/api/catchup/preview',              permission: 'catchup.preview' },
  { method: 'POST',   path: '/api/catchup/send',                 permission: 'catchup.send', audit: true },

  // ── Browser web push ──────────────────────────────────────────────────────
  { method: 'GET',    path: '/api/push/vapid-key',               permission: 'device.register' },
  { method: 'POST',   path: '/api/push/subscribe',               permission: 'device.register' },
  { method: 'POST',   path: '/api/push/unsubscribe',             permission: 'device.register' },
  { method: 'POST',   path: '/api/push/check',                   permission: 'device.register' },
  { method: 'POST',   path: '/api/push/test',                    permission: 'device.test' },
  { method: 'GET',    path: '/api/push/status',                  permission: 'device.read' },

  // ── Native APNs ───────────────────────────────────────────────────────────
  { method: 'POST',   path: '/api/mobile-push/register',         permission: 'device.register' },
  { method: 'POST',   path: '/api/mobile-push/unregister',       permission: 'device.register' },
  { method: 'GET',    path: '/api/mobile-push/status',           permission: 'device.read' },
  { method: 'POST',   path: '/api/mobile-push/test',             permission: 'device.test' },

  // ── Analytics ─────────────────────────────────────────────────────────────
  { method: 'GET',    path: '/api/analytics/overview',           permission: 'analytics.read' },
  { method: 'GET',    path: '/api/analytics/attributions',       permission: 'analytics.read' },
  { method: 'GET',    path: '/api/analytics/campaigns/:id',      permission: 'analytics.read' },
  { method: 'GET',    path: '/api/analytics/campaigns/:id/attributions', permission: 'analytics.read' },

  // The on-device assistant has no server-side model endpoint. This read tells
  // an eligible named Owner/Admin whether the pilot is enabled. The handler
  // independently refuses Agent and legacy identities even if a per-user grant
  // is added accidentally; route policy still requires assistant.use first.
  { method: 'GET',    path: '/api/assistant/status',              permission: 'assistant.use' },
  // Reasoning, speech and the voice library. All `assistant.use`; the tools the
  // conversation may reach are gated separately and individually by
  // lib/assistant/tools.js, each against the permission its own route requires.
  { method: 'POST',   path: '/api/assistant/converse',            permission: 'assistant.use' },
  { method: 'POST',   path: '/api/assistant/speak',               permission: 'assistant.use' },
  { method: 'GET',    path: '/api/assistant/voices',              permission: 'assistant.use' },

  // Named, resumable conversations. `assistant.use` throughout, and the same
  // permission the assistant itself needs, because a thread is a record of
  // using the assistant and contains nothing a person with that permission
  // could not have asked for directly.
  //
  // THE PERMISSION IS NOT THE INTERESTING PART OF THE ACCESS CONTROL HERE, and
  // a reader should not be reassured by it. `assistant.use` is held by several
  // people; a thread belongs to ONE of them. The rule that matters is that
  // every query in lib/assistant/threads.js filters on the calling actor's own
  // user_id, so two Owners with identical permissions cannot read each other's
  // conversations. Somebody else's thread answers 404, exactly like one that
  // was never created.
  //
  // NONE OF THESE IS AUDITED, deliberately. Nothing about authority, money or a
  // customer changes. These are one operator's working notes, and "Sarah
  // renamed a chat" in the Activity Center would dilute a feed whose whole
  // value is that everything in it matters. Same reasoning as
  // PATCH /api/users/me/notifications. The DELETE is included in that: it
  // destroys only the person's own notes, and the compliance record of what
  // they actually DID lives in sms_audit_log, which has no write API and
  // revokes UPDATE and DELETE even from the service role.
  { method: 'GET',    path: '/api/assistant/threads',             permission: 'assistant.use' },
  { method: 'POST',   path: '/api/assistant/threads',             permission: 'assistant.use' },
  { method: 'GET',    path: '/api/assistant/threads/:id',         permission: 'assistant.use' },
  { method: 'PATCH',  path: '/api/assistant/threads/:id',         permission: 'assistant.use' },
  { method: 'DELETE', path: '/api/assistant/threads/:id',         permission: 'assistant.use' },

  // ── Campaigns ─────────────────────────────────────────────────────────────
  { method: 'GET',    path: '/api/campaigns',                    permission: 'campaigns.read' },
  { method: 'GET',    path: '/api/campaigns/review-count',       permission: 'campaigns.read' },
  // Where the revenue actually is, across the whole customer base. Literal, and
  // the compiler sorts it ahead of /api/campaigns/:id regardless of where it
  // sits in this table. `campaigns.read`: it counts customers and reports what
  // has already happened. It writes nothing, drafts nothing and sends nothing.
  { method: 'GET',    path: '/api/campaigns/opportunities',      permission: 'campaigns.read' },
  { method: 'POST',   path: '/api/campaigns/generate',           permission: 'campaigns.manage', audit: true },
  // Drafting aid only. Returns candidate wording an Admin picks and edits; it
  // writes no campaign, approves nothing and schedules nothing. Not audited
  // because it changes no state - see the handler comment in routes/campaigns.js.
  { method: 'POST',   path: '/api/campaigns/copy-suggestions',   permission: 'campaigns.manage' },
  { method: 'POST',   path: '/api/campaigns',                    permission: 'campaigns.manage', audit: true },
  { method: 'GET',    path: '/api/campaigns/:id',                permission: 'campaigns.read' },
  { method: 'PATCH',  path: '/api/campaigns/:id',                permission: 'campaigns.manage', audit: true },
  { method: 'GET',    path: '/api/campaigns/:id/recipients',     permission: 'campaigns.read' },
  { method: 'GET',    path: '/api/campaigns/:id/performance',    permission: 'campaigns.read' },
  { method: 'POST',   path: '/api/campaigns/:id/submit-review',  permission: 'campaigns.manage', audit: true },
  { method: 'POST',   path: '/api/campaigns/:id/reject',         permission: 'campaigns.approve', audit: true },
  { method: 'POST',   path: '/api/campaigns/:id/approve',        permission: 'campaigns.approve', audit: true },
  { method: 'POST',   path: '/api/campaigns/:id/schedule',       permission: 'campaigns.launch', audit: true },
  { method: 'POST',   path: '/api/campaigns/:id/cancel',         permission: 'campaigns.cancel', audit: true },
  { method: 'POST',   path: '/api/campaigns/:id/dry-run',        permission: 'campaigns.manage' },
  // Removing a campaign. `campaigns.manage`, not `campaigns.cancel`: cancel
  // stops a send that is going to happen, this changes what the record says
  // happened. The handler cannot choose to destroy — delete_sms_campaign
  // archives anything carrying approval or delivery evidence and has no force
  // path — so the destructive case is only ever an unapproved draft.
  { method: 'DELETE', path: '/api/campaigns/:id',                permission: 'campaigns.manage', audit: true },

  // ── Campaign segments ─────────────────────────────────────────────────────
  // Reading a segment is reading the deterministic engine's own output plus
  // the evidence behind each person. A Support Agent may look, because "why is
  // this customer being contacted?" is a question they get asked. Nobody
  // without campaigns.manage may change one.
  { method: 'GET',    path: '/api/segments',                     permission: 'campaigns.read' },
  // Literal, and the compiler sorts it ahead of /api/segments/:id regardless
  // of the order it appears here.
  { method: 'GET',    path: '/api/segments/catalogue',           permission: 'campaigns.read' },
  // Every segment one person is in. Reading, so `campaigns.read`, the same as
  // the per-segment answer below it: this shows the same evidence rows, only
  // gathered by person instead of by segment.
  { method: 'GET',    path: '/api/segments/members/:phone',      permission: 'campaigns.read' },
  { method: 'POST',   path: '/api/segments',                     permission: 'campaigns.manage', audit: true },
  { method: 'GET',    path: '/api/segments/:id',                 permission: 'campaigns.read' },
  { method: 'GET',    path: '/api/segments/:id/members/:phone',  permission: 'campaigns.read' },
  // The add-someone picker. `campaigns.manage`, not `campaigns.read`, and this
  // is the only segment GET that is not readable by a Support Agent: it exists
  // solely to stage an add or a force include, both of which an Agent is
  // refused. A list of people they can never act on is a route with no reader.
  // Who is IN a segment stays readable at GET /api/segments/:id.
  { method: 'GET',    path: '/api/segments/:id/candidates',      permission: 'campaigns.manage' },
  { method: 'POST',   path: '/api/segments/:id/members',         permission: 'campaigns.manage', audit: true },
  { method: 'DELETE', path: '/api/segments/:id/members/:phone',  permission: 'campaigns.manage', audit: true },
  // A force include or exclude overrules the arithmetic for a named person,
  // and an exclusion outlives every recompute until somebody revokes it.
  { method: 'POST',   path: '/api/segments/:id/overrides',       permission: 'campaigns.manage', audit: true },
  { method: 'DELETE', path: '/api/segments/:id/overrides/:phone', permission: 'campaigns.manage', audit: true },
  { method: 'POST',   path: '/api/segments/:id/recompute',       permission: 'campaigns.manage', audit: true },
  // Removing a segment. The handler cannot choose to destroy:
  // delete_sms_campaign_segment archives anything a campaign used, the engine
  // ran on, somebody overrode, or where somebody wrote down why a named person
  // is in it, and it has no force path. The destructive case is only ever a
  // hand-made list that records no decision about anybody.
  { method: 'DELETE', path: '/api/segments/:id',                 permission: 'campaigns.manage', audit: true },
  // The inverse of an archive. Reversible by design, so archiving is a real
  // alternative to deleting rather than a slower one.
  { method: 'POST',   path: '/api/segments/:id/restore',         permission: 'campaigns.manage', audit: true },

  // Describing a segment in words. All three are campaigns.manage: a Support
  // Agent may read a segment and the evidence behind one person's membership,
  // and may not build one.
  //
  // Only the last of the three writes anything, and only the last is audited.
  // Drafting and previewing produce no row, no member and no message; flagging
  // them would assert coverage their handlers do not provide, which is the
  // exact rot test/route-policy.test.js was written to stop.
  //
  // These are literal paths and the compiler sorts them ahead of
  // /api/segments/:id regardless of where they sit in this table.
  { method: 'POST',   path: '/api/segments/rules/draft',         permission: 'campaigns.manage' },
  { method: 'POST',   path: '/api/segments/rules/preview',       permission: 'campaigns.manage' },
  { method: 'POST',   path: '/api/segments/rules',               permission: 'campaigns.manage', audit: true },

  // ── Campaign proposals ────────────────────────────────────────────────────
  // Drafts of an argument for a campaign, generated from a detected cohort
  // opportunity. A proposal is never a campaign and accepting one only creates
  // an ordinary campaign DRAFT, which still needs submit, review, approval and
  // both live-send brakes.
  //
  // EVERY ENTRY IS campaigns.manage, INCLUDING THE READS. That is deliberate
  // and it differs from /api/segments, where reading is campaigns.read. A
  // segment is a list of people; a proposal is unapproved marketing copy with
  // an offer sketched beside it, and the obvious next thing a person does with
  // a message on a screen is try to send it. The same reasoning as the segment
  // candidate picker above.
  //
  // Drafting is NOT audited: with commit false it produces no row at all, and
  // with commit true it produces a proposal, which is a draft of a draft.
  // Flagging it would assert coverage the handler does not provide. The two
  // DECISIONS are audited, because both are a named person deciding something
  // about customer-facing work, and acceptance in particular is the moment a
  // campaign row comes into existence.
  { method: 'POST',   path: '/api/campaign-proposals/draft',     permission: 'campaigns.manage' },
  { method: 'GET',    path: '/api/campaign-proposals',           permission: 'campaigns.manage' },
  { method: 'GET',    path: '/api/campaign-proposals/:id',       permission: 'campaigns.manage' },
  { method: 'POST',   path: '/api/campaign-proposals/:id/accept', permission: 'campaigns.manage', audit: true },
  { method: 'POST',   path: '/api/campaign-proposals/:id/dismiss', permission: 'campaigns.manage', audit: true },


  // ── Team management ───────────────────────────────────────────────────────
  // The `permission: null` entries are the ONLY ones in the table, and they are
  // all `/api/users/me/...`: things every authenticated actor, including a
  // Support Agent, may do TO THEMSELVES AND ONLY TO THEMSELVES. Each handler
  // reads `req.actor.id` and never a path parameter, so none of them can be
  // pointed at another person.
  //
  //   GET  /me           read your own profile
  //   PATCH /me          your own display name and phone
  //   POST /me/password  set your own password. Also how a
  //                      must_change_password account escapes the
  //                      forced-rotation lock; see PASSWORD_CHANGE_EXEMPT.
  //   POST /me/email     ASK to move to a new address. Changes nothing on its
  //                      own — the address only moves once the link sent to it
  //                      is opened at POST /auth/email-change/confirm, which is
  //                      public and therefore not in this table.
  //   POST /me/email/cancel  abandon that request
  //   GET  /me/timezones the IANA picker list. A constant document, but it is
  //                      under /me because choosing your own display time zone
  //                      is open to every actor and every open endpoint in this
  //                      table must sit under /api/users/me. See the test.
  //   GET/PATCH /me/notifications
  //                      which alerts reach your own phone. Open for the same
  //                      reason: deciding that is not a permission anybody
  //                      grants anybody, and both handlers read req.actor.id
  //                      and never a path parameter.
  //
  // NEITHER NOTIFICATION ENDPOINT IS AUDITED, and that is deliberate. Nothing
  // about authority, money or a customer changes. The Activity Center records
  // who can do what and who messaged whom; "Sarah turned off release
  // announcements" is neither, and a row for it would dilute a feed whose whole
  // value is that everything in it matters. Same reasoning as
  // POST /api/users/me/email/cancel above.
  //
  // The shared legacy identity is refused by every one of them: two people
  // share it, and neither gets to rename or re-address what the other sees.
  { method: 'GET',    path: '/api/users/me',                     permission: null },
  { method: 'PATCH',  path: '/api/users/me',                     permission: null, audit: true },
  { method: 'POST',   path: '/api/users/me/password',            permission: null },
  { method: 'POST',   path: '/api/users/me/email',               permission: null, audit: true },
  { method: 'POST',   path: '/api/users/me/email/cancel',        permission: null },
  { method: 'POST',   path: '/api/users/me/onboarding',          permission: null },
  { method: 'GET',    path: '/api/users/me/timezones',           permission: null },
  { method: 'GET',    path: '/api/users/me/notifications',       permission: null },
  { method: 'PATCH',  path: '/api/users/me/notifications',       permission: null },

  { method: 'GET',    path: '/api/users',                        permission: 'user.read' },
  { method: 'POST',   path: '/api/users',                        permission: 'user.manage', audit: true },
  { method: 'PATCH',  path: '/api/users/:id',                    permission: 'user.manage', audit: true },
  { method: 'POST',   path: '/api/users/:id/deactivate',         permission: 'user.manage', audit: true },
  // Removal is a deactivation, never a delete, so that the Activity Center
  // keeps reading "Sarah cancelled Payment Reminder" rather than "Unknown".
  // This is its counterpart and writes `team.member.reactivated`.
  { method: 'POST',   path: '/api/users/:id/reactivate',         permission: 'user.manage', audit: true },
  { method: 'POST',   path: '/api/users/:id/reset-password',     permission: 'user.manage', audit: true },

  { method: 'GET',    path: '/api/invitations',                  permission: 'user.read' },
  { method: 'POST',   path: '/api/invitations',                  permission: 'user.manage', audit: true },
  { method: 'POST',   path: '/api/invitations/:id/revoke',       permission: 'user.manage', audit: true },
  // Re-mails an open invitation. Mints no token and extends no expiry, but it
  // does put a live credential back on the wire, so it is Admin-only and audited.
  { method: 'POST',   path: '/api/invitations/:id/resend',       permission: 'user.manage', audit: true },

  // The Activity Center. Read-only by construction — sms_audit_log has no
  // write API, and the table revokes UPDATE/DELETE even from the service role.
  // Admin-only: the feed names who did what, which is management information.
  { method: 'GET',    path: '/api/audit',                        permission: 'audit.read' },
  { method: 'GET',    path: '/api/audit/entity/:entityType/:entityId', permission: 'audit.read' },
  { method: 'GET',    path: '/api/audit/contact/:phone',         permission: 'audit.read' },
  { method: 'GET',    path: '/api/audit/actors',                 permission: 'audit.read' },
  { method: 'GET',    path: '/api/audit/summary',                permission: 'audit.read' }
];

/**
 * Paths exempt from the must_change_password lock. An account forced to rotate
 * its password must still be able to see who it is and set a new one,
 * otherwise the lock is a dead end.
 */
const PASSWORD_CHANGE_EXEMPT = Object.freeze([
  { method: 'GET',  path: '/api/users/me' },
  { method: 'POST', path: '/api/users/me/password' }
]);

/** Every distinct permission key referenced by the table above. */
function policyPermissionKeys() {
  return [...new Set(ROUTE_POLICY.map(entry => entry.permission).filter(Boolean))].sort();
}

module.exports = { ROUTE_POLICY, PASSWORD_CHANGE_EXEMPT, policyPermissionKeys };
