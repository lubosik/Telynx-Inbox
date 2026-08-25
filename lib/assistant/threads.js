'use strict';
/**
 * lib/assistant/threads.js: named, resumable assistant conversations.
 *
 * ONE PERSON PER THREAD, ENFORCED IN EVERY QUERY AND NOT ONCE AT THE DOOR
 *   These rows hold business figures and one operator's working notes. Every
 *   function here takes a `userId` and puts it in the WHERE clause, including
 *   the ones that already had a thread id in hand. Verifying ownership once and
 *   then trusting the id afterwards is how a second query grows a hole later:
 *   the id is supplied by the client, so it is an assertion, not a fact.
 *
 *   Messages are read by `thread_id` only, which is safe for exactly one
 *   reason: the thread they belong to was loaded with the user filter first,
 *   in the same call, and a miss returns not-found before any message query is
 *   built. `loadOwnedThread` is that step and nothing may skip it.
 *
 * NOT FOUND, NEVER FORBIDDEN
 *   Somebody else's thread answers 404, the same as a thread that was never
 *   created. A 403 would confirm the id exists, which is a slow way of letting
 *   an account enumerate another account's conversations.
 *
 * THE THREE SUPABASE RULES THIS FILE OBEYS
 *   A query builder is a thenable with no `.catch()`, so every call is a
 *   try/catch around the await followed by a check of `error`. An unpaged read
 *   silently caps at 1000 rows, so the one read that has no natural bound goes
 *   through fetchAllRows. `.in()` overflows the URL, so there is not one in
 *   this file; nothing here filters by a list.
 */

const { fetchAllRows } = require('../fetch-all-rows');
const {
  COMPACTION_THRESHOLD,
  RECENT_TURNS_KEPT,
  foldCount,
  shouldCompact,
  summarise
} = require('./compaction');

const THREADS_TABLE = 'sms_assistant_threads';
const MESSAGES_TABLE = 'sms_assistant_messages';
const WORKSPACE_ID = 'vici';

const THREAD_COLUMNS =
  'id, title, summary, summarised_message_count, last_message_at, archived_at, created_at, updated_at';
const MESSAGE_COLUMNS = 'id, role, content, tools_used, created_at';

/** Matches the CHECK in scripts/assistant-threads-migration.sql. */
const MAX_TITLE_LENGTH = 120;
const MAX_CONTENT_LENGTH = 8000;

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;

/**
 * A ceiling on how many live threads one account may hold.
 *
 * Not a storage concern. A "new chat" button is one tap, so without a limit a
 * stuck client or a leaning finger can write rows until the list screen is
 * useless, and the person it happens to is the only person who can see it.
 * Refusing at a number no real working week reaches is cheaper than a cleanup.
 */
const MAX_THREADS_PER_USER = 200;

/** The most live turns ever sent to the model, compacted thread or not. */
const MAX_CONTEXT_TURNS = COMPACTION_THRESHOLD + 2;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Errors this module raises, carrying the code the route turns into a status.
 * A thrown error rather than a returned envelope, so a caller that forgets to
 * check cannot carry on with an undefined thread.
 */
class ThreadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ThreadError';
    this.code = code;
  }
}

const notFound = () => new ThreadError('THREAD_NOT_FOUND', 'That conversation does not exist.');

/**
 * Run a query builder and return its rows.
 *
 * The whole point of this wrapper is the shape: `await` inside a try/catch, and
 * `error` checked separately afterwards. PostgREST reports a failure in
 * `error` and never as a rejection, and the builder has no `.catch()` to hang
 * handling off, so anything else either swallows real failures or throws a
 * TypeError before the request is sent.
 */
async function run(builder, what) {
  let result;
  try {
    result = await builder;
  } catch (error) {
    throw new ThreadError('THREAD_STORE_FAILED', `${what} failed: ${error?.message || 'unknown'}`);
  }
  if (result?.error) {
    throw new ThreadError('THREAD_STORE_FAILED', `${what} failed: ${result.error.message}`);
  }
  return result;
}

/** The actor's own id, as PostgREST wants it, or a refusal. */
function requireUserId(userId) {
  const value = String(userId ?? '').trim();
  if (!/^\d+$/.test(value)) {
    throw new ThreadError('THREAD_ACTOR_REQUIRED', 'A named account is required.');
  }
  return value;
}

/**
 * A malformed id is not-found, not a database error.
 *
 * PostgREST answers 22P02 for a value that is not a uuid, which would surface
 * as a 500 and read like a broken server rather than like a bad id from a
 * client. Checked here so the shape of a wrong id and a stranger's id is the
 * same answer.
 */
function requireThreadId(threadId) {
  const value = String(threadId ?? '').trim();
  if (!UUID_PATTERN.test(value)) throw notFound();
  return value;
}

function cleanTitle(raw) {
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, MAX_TITLE_LENGTH) : null;
}

/**
 * A thread's name, taken from the question that started it.
 *
 * Cut at a word boundary when there is one to cut at, because a title sliced
 * mid word looks like a rendering fault rather than a summary. Never
 * overwritten once set: see `recordExchange`.
 */
function deriveTitle(question) {
  const text = String(question ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 24 ? cut.slice(0, lastSpace) : cut).trim();
}

function normaliseToolsUsed(toolsUsed) {
  if (!Array.isArray(toolsUsed)) return [];
  return toolsUsed
    .filter(name => typeof name === 'string' && name.trim())
    .map(name => name.trim().slice(0, 80))
    .slice(0, 20);
}

function publicThread(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || null,
    lastMessageAt: row.last_message_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    hasSummary: Boolean(row.summary)
  };
}

function publicMessage(row) {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    toolsUsed: Array.isArray(row.tools_used) ? row.tools_used : [],
    createdAt: row.created_at || null
  };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The gate every other function goes through. Returns the raw row, scoped to
 * the caller, or throws not-found.
 */
async function loadOwnedThread(client, userId, threadId) {
  const owner = requireUserId(userId);
  const id = requireThreadId(threadId);
  const result = await run(
    client
      .from(THREADS_TABLE)
      .select(THREAD_COLUMNS)
      .eq('workspace_id', WORKSPACE_ID)
      .eq('user_id', owner)
      .eq('id', id)
      .maybeSingle(),
    'reading a conversation'
  );
  if (!result.data) throw notFound();
  return result.data;
}

/**
 * One person's live threads, newest activity first.
 *
 * Bounded rather than paged, and that is a deliberate difference from the
 * message read below. `MAX_THREADS_PER_USER` is 200, so the ceiling here is
 * below the 1000 row cap by construction and a page can never be silently
 * truncated. There is nothing beyond the limit to go blind to.
 */
async function listThreads({ client, userId, limit = DEFAULT_LIST_LIMIT }) {
  const owner = requireUserId(userId);
  const size = Math.min(Math.max(Number.parseInt(limit, 10) || DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

  const result = await run(
    client
      .from(THREADS_TABLE)
      .select(THREAD_COLUMNS)
      .eq('workspace_id', WORKSPACE_ID)
      .eq('user_id', owner)
      .is('archived_at', null)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(size),
    'listing conversations'
  );

  const rows = result.data || [];
  if (!rows.length) return [];

  // The first line of each thread, for the list. One question per thread, so
  // this is bounded by the page size above and cannot grow with history.
  const previews = new Map();
  for (const row of rows) {
    const preview = await run(
      client
        .from(MESSAGES_TABLE)
        .select('content')
        .eq('thread_id', row.id)
        .eq('role', 'user')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle(),
      'reading a conversation preview'
    );
    if (preview.data?.content) previews.set(row.id, preview.data.content.slice(0, 160));
  }

  return rows.map(row => ({ ...publicThread(row), preview: previews.get(row.id) || null }));
}

/**
 * Every message in one thread, in order.
 *
 * The one read here with no natural ceiling: a thread compacts its CONTEXT but
 * never deletes a message, so this table grows for as long as the conversation
 * is used. It goes through fetchAllRows with a filter and an id tiebreak, so it
 * pages rather than stopping at 1000, and the pages cannot overlap or skip.
 */
async function readAllMessages(client, threadId) {
  const rows = await fetchAllRows(client, MESSAGES_TABLE, MESSAGE_COLUMNS, {
    filter: query => query.eq('thread_id', threadId),
    orderBy: 'created_at',
    ascending: true,
    thenBy: 'id',
    maxRows: 20000
  });
  return rows.map(publicMessage);
}

async function getThread({ client, userId, threadId }) {
  const row = await loadOwnedThread(client, userId, threadId);
  const messages = await readAllMessages(client, row.id);
  return { thread: publicThread(row), messages };
}

async function countMessages(client, threadId) {
  const result = await run(
    client
      .from(MESSAGES_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('thread_id', threadId),
    'counting a conversation'
  );
  return Number(result.count || 0);
}

/**
 * A window of a thread's messages by position in its total order.
 *
 * `.range()` is sound here only because the order is total: created_at with id
 * as the tiebreak. Without the tiebreak two rows written in the same
 * microsecond could swap between one request and the next, and the compaction
 * boundary is a count of the oldest messages, so a wobble there would fold a
 * turn twice or lose one.
 */
async function readMessageWindow(client, threadId, from, count) {
  if (count <= 0) return [];
  const result = await run(
    client
      .from(MESSAGES_TABLE)
      .select(MESSAGE_COLUMNS)
      .eq('thread_id', threadId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + count - 1),
    'reading conversation turns'
  );
  return (result.data || []).map(publicMessage);
}

/**
 * What converse sends to the model for an existing thread: the summary of
 * everything already folded away, plus the turns since.
 *
 * READ FROM THE DATABASE, NEVER FROM THE REQUEST. The client used to post its
 * own history back, which meant the transcript the model reasoned over was
 * whatever the caller said it was. A caller could rewrite what it had
 * previously been told, including putting words in the assistant's mouth, and
 * the answer would be grounded in a conversation that never happened.
 */
async function loadContext({ client, userId, threadId }) {
  const row = await loadOwnedThread(client, userId, threadId);
  const total = await countMessages(client, row.id);
  const summarised = Math.min(Number(row.summarised_message_count || 0), total);
  const liveCount = Math.min(total - summarised, MAX_CONTEXT_TURNS);
  const from = total - liveCount;
  const messages = await readMessageWindow(client, row.id, from, liveCount);

  return {
    thread: row,
    summary: row.summary || null,
    turns: messages.map(message => ({ role: message.role, content: message.content })),
    totalMessages: total,
    summarisedMessageCount: summarised
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────

async function createThread({ client, userId, title = null }) {
  const owner = requireUserId(userId);

  const existing = await run(
    client
      .from(THREADS_TABLE)
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', WORKSPACE_ID)
      .eq('user_id', owner)
      .is('archived_at', null),
    'counting conversations'
  );
  if (Number(existing.count || 0) >= MAX_THREADS_PER_USER) {
    throw new ThreadError(
      'THREAD_LIMIT_REACHED',
      `You have ${MAX_THREADS_PER_USER} conversations open. Delete one to start another.`
    );
  }

  const result = await run(
    client
      .from(THREADS_TABLE)
      .insert({ workspace_id: WORKSPACE_ID, user_id: owner, title: cleanTitle(title) })
      .select(THREAD_COLUMNS)
      .maybeSingle(),
    'creating a conversation'
  );
  if (!result.data) throw new ThreadError('THREAD_STORE_FAILED', 'The conversation was not created.');
  return { ...publicThread(result.data), preview: null };
}

async function renameThread({ client, userId, threadId, title }) {
  const row = await loadOwnedThread(client, userId, threadId);
  const cleaned = cleanTitle(title);
  if (!cleaned) throw new ThreadError('THREAD_TITLE_REQUIRED', 'A name is required.');

  const result = await run(
    client
      .from(THREADS_TABLE)
      .update({ title: cleaned })
      .eq('workspace_id', WORKSPACE_ID)
      .eq('user_id', requireUserId(userId))
      .eq('id', row.id)
      .select(THREAD_COLUMNS)
      .maybeSingle(),
    'renaming a conversation'
  );
  if (!result.data) throw notFound();
  return publicThread(result.data);
}

/**
 * A real delete, not an archive.
 *
 * The messages go with it through ON DELETE CASCADE. An operator who deletes a
 * conversation containing their own notes about the business is entitled to
 * have it gone, and a soft delete that still returns rows to any query without
 * the filter would make "deleted" a claim rather than a fact. Nothing in this
 * table is a compliance record; that is what sms_audit_log is for, and it is
 * append only precisely so that the two cannot be confused.
 */
async function deleteThread({ client, userId, threadId }) {
  const row = await loadOwnedThread(client, userId, threadId);
  const result = await run(
    client
      .from(THREADS_TABLE)
      .delete()
      .eq('workspace_id', WORKSPACE_ID)
      .eq('user_id', requireUserId(userId))
      .eq('id', row.id)
      .select('id')
      .maybeSingle(),
    'deleting a conversation'
  );
  if (!result.data) throw notFound();
  return { id: row.id };
}

/**
 * Append both halves of one exchange and move the thread to the top of the list.
 *
 * The two rows go in one insert with explicit timestamps, rather than two
 * inserts leaning on the default. Postgres `now()` is transaction start time,
 * so a single statement would stamp both rows identically and leave their order
 * to the uuid tiebreak, which is random. An assistant turn sorting above the
 * question it answers would corrupt every later read of the thread, including
 * the compaction boundary.
 *
 * THE TIMESTAMP IS DERIVED FROM THE THREAD, NOT JUST FROM THE CLOCK.
 *   Taking `new Date()` and adding a millisecond orders the two halves of ONE
 *   exchange and nothing more. Two exchanges landing in the same millisecond
 *   would interleave: the second question carries the same stamp as the first
 *   question, while the first answer is a millisecond later, so the thread
 *   reads back as two questions followed by two answers. A test writing twelve
 *   exchanges in a loop found exactly that.
 *
 *   It is not only a test artifact. Wall clocks are not monotonic, Railway runs
 *   two instances during a rolling deploy, and either of those can hand back a
 *   time at or behind the last one. Starting from the thread's own
 *   `last_message_at` makes the sequence strictly increasing per thread
 *   whatever the clock does.
 */
async function recordExchange({ client, userId, threadId, question, reply, toolsUsed = [] }) {
  // Refused here rather than by the database.
  //
  // `content` carries CHECK (char_length BETWEEN 1 AND 8000), so an empty
  // question or reply violates a constraint and surfaces as
  // THREAD_STORE_FAILED, which reads as "your conversations could not be
  // reached" when the truth is that there was nothing to save. Found by passing
  // the wrong argument name and watching a Postgres constraint message come
  // back instead of a sentence.
  const askedText = String(question ?? '').trim();
  const replyText = String(reply ?? '').trim();
  if (!askedText || !replyText) {
    throw new ThreadError('THREAD_EXCHANGE_EMPTY', 'An exchange needs both a question and an answer to be saved.');
  }

  const row = await loadOwnedThread(client, userId, threadId);
  const previousMs = row.last_message_at ? new Date(row.last_message_at).getTime() : 0;
  const baseMs = Math.max(Date.now(), (Number.isFinite(previousMs) ? previousMs : 0) + 2);
  const askedAt = new Date(baseMs);
  const answeredAt = new Date(baseMs + 1);

  await run(
    client.from(MESSAGES_TABLE).insert([
      {
        thread_id: row.id,
        role: 'user',
        content: askedText.slice(0, MAX_CONTENT_LENGTH),
        tools_used: [],
        created_at: askedAt.toISOString()
      },
      {
        thread_id: row.id,
        role: 'assistant',
        content: replyText.slice(0, MAX_CONTENT_LENGTH),
        tools_used: normaliseToolsUsed(toolsUsed),
        created_at: answeredAt.toISOString()
      }
    ]),
    'saving a conversation turn'
  );

  await run(
    client
      .from(THREADS_TABLE)
      .update({ last_message_at: answeredAt.toISOString() })
      .eq('workspace_id', WORKSPACE_ID)
      .eq('user_id', requireUserId(userId))
      .eq('id', row.id),
    'updating a conversation'
  );

  // Named from the question that started it, once, and only while it has no
  // name. `.is('title', null)` is the guard rather than the `if` above it: the
  // read happened before the insert, so a rename that landed in between would
  // otherwise be overwritten by the first thing the operator asked.
  if (!row.title) {
    const derived = deriveTitle(question);
    if (derived) {
      await run(
        client
          .from(THREADS_TABLE)
          .update({ title: derived })
          .eq('workspace_id', WORKSPACE_ID)
          .eq('user_id', requireUserId(userId))
          .eq('id', row.id)
          .is('title', null),
        'naming a conversation'
      );
    }
  }

  return { threadId: row.id };
}

/**
 * Fold the older half of a long thread into its summary.
 *
 * Runs after the operator already has their answer, so its cost is never in
 * the path of a question. Every failure returns `{ compacted: false }` and
 * writes nothing: an advanced boundary with no summary behind it would hide
 * turns from the model with nothing standing in for them, which loses the
 * conversation rather than shortening it.
 */
async function compactThreadIfNeeded({ client, userId, threadId, env = process.env, fetchImpl = global.fetch }) {
  const row = await loadOwnedThread(client, userId, threadId);
  const total = await countMessages(client, row.id);
  const alreadySummarised = Math.min(Number(row.summarised_message_count || 0), total);

  if (!shouldCompact(total, alreadySummarised)) return { compacted: false, reason: 'below_threshold' };

  const fold = foldCount(total, alreadySummarised, RECENT_TURNS_KEPT);
  if (fold <= 0) return { compacted: false, reason: 'nothing_to_fold' };

  const messages = await readMessageWindow(client, row.id, alreadySummarised, fold);
  if (messages.length !== fold) {
    // The thread changed underneath this read. Do nothing rather than fold a
    // window that no longer matches the count the boundary is about to record.
    return { compacted: false, reason: 'thread_moved' };
  }

  const summary = await summarise({
    existingSummary: row.summary || null,
    messages,
    env,
    fetchImpl
  });
  if (!summary) return { compacted: false, reason: 'summary_unavailable' };

  const nextCount = alreadySummarised + fold;
  const result = await run(
    client
      .from(THREADS_TABLE)
      .update({ summary, summarised_message_count: nextCount })
      .eq('workspace_id', WORKSPACE_ID)
      .eq('user_id', requireUserId(userId))
      .eq('id', row.id)
      // The boundary only ever moves forward. Two questions answered at once
      // would otherwise both fold from the same starting point, and the second
      // write would rewind the count over turns the first had already covered.
      .eq('summarised_message_count', alreadySummarised)
      .select('id')
      .maybeSingle(),
    'compacting a conversation'
  );
  if (!result.data) return { compacted: false, reason: 'boundary_moved' };

  return { compacted: true, summarisedMessageCount: nextCount, foldedMessages: fold };
}

module.exports = {
  MAX_CONTEXT_TURNS,
  MAX_LIST_LIMIT,
  MAX_THREADS_PER_USER,
  MAX_TITLE_LENGTH,
  MESSAGES_TABLE,
  THREADS_TABLE,
  ThreadError,
  compactThreadIfNeeded,
  createThread,
  deleteThread,
  deriveTitle,
  getThread,
  listThreads,
  loadContext,
  loadOwnedThread,
  recordExchange,
  renameThread
};
