'use strict';
/**
 * lib/fetch-all-rows.js — read every row of a table, in pages.
 *
 * Two Supabase behaviours have bitten this codebase, and both are silent:
 *
 *   1. PostgREST caps a response at 1000 rows. It does not error, it just
 *      returns fewer rows than you asked for, so a query that looks correct
 *      quietly goes blind past row 1000.
 *
 *   2. `.in('col', [...])` puts every value in the URL. At 907 contacts that
 *      is an 11,801-character filter, which overflows Node's HTTP header limit
 *      (UND_ERR_HEADERS_OVERFLOW) and fails the request outright — after a
 *      ~10 second stall.
 *
 * Both were live in routes/conversations.js. The second took the inbox down:
 * every lastMessage came back null, so the app fell back to showing phone
 * numbers instead of message previews, and the 25-second response made the
 * client give up with "Inbox error: cancelled".
 *
 * The fix for both is the same: never filter by a large array, and always page
 * explicitly rather than trusting the default limit.
 */

const PAGE_SIZE = 1000;

/**
 * Values per `.in()` request. 200 phone numbers is roughly 2.6 KB of URL,
 * comfortably inside every limit in the path. The failure was at 907.
 */
const IN_CHUNK_SIZE = 200;

/**
 * Fetch every row of a table, one page at a time.
 *
 * @param {object} supabase
 * @param {string} table
 * @param {string} columns    PostgREST select list
 * @param {object} [opts]
 * @param {string} [opts.orderBy]    column to sort by
 * @param {boolean} [opts.ascending]
 * @param {number} [opts.maxRows]    hard ceiling, so a runaway table cannot
 *                                   page forever and exhaust memory
 * @param {(query: object) => object} [opts.filter]
 *   Applied to every page before ordering. Without it, paging a table you only
 *   want part of means reading the whole table and discarding most of it, which
 *   is the shape that made callers reach for an unpaged `.eq()` instead and
 *   silently stop at row 1000. Return the query; do not add ordering inside it,
 *   or the sort keys end up in the wrong order.
 * @param {string} [opts.thenBy]
 *   A unique tiebreak column, applied after `orderBy`.
 *
 *   PAGING WITHOUT ONE IS UNSOUND, not merely untidy. `.range()` asks the
 *   database for rows 1000 to 1999 of a sort, and if two rows compare equal
 *   under `orderBy` their relative order is not defined between one request and
 *   the next. A row can therefore appear on both pages, or on neither. Pass the
 *   primary key whenever the sort column is not itself unique.
 * @returns {Promise<Array>}
 */
async function fetchAllRows(supabase, table, columns, opts = {}) {
  const {
    orderBy = 'created_at',
    ascending = false,
    maxRows = 100000,
    filter = null,
    thenBy = null
  } = opts;
  const rows = [];

  for (let from = 0; from < maxRows; from += PAGE_SIZE) {
    let query = supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (filter) query = filter(query);
    if (orderBy) query = query.order(orderBy, { ascending });
    if (thenBy) query = query.order(thenBy, { ascending });

    const { data, error } = await query;
    // Surface it. The bug this file exists to prevent was a swallowed error
    // that turned into null data and a wrong-looking screen.
    if (error) throw new Error(`${table} page at ${from} failed: ${error.message}`);

    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }

  console.warn(`[fetch-all-rows] ${table} hit the ${maxRows}-row ceiling — results are truncated.`);
  return rows;
}

/**
 * Run a `.in(column, values)` query safely, in chunks.
 *
 * `.in()` serialises every value into the URL, so a long list overflows the
 * HTTP header limit and the request fails outright — the failure that took the
 * inbox down. Chunking keeps each URL short regardless of how many values are
 * passed, so callers no longer have to reason about how big their array might
 * get.
 *
 * @param {object} supabase
 * @param {string} table
 * @param {string} columns
 * @param {string} column   the column to match on
 * @param {Array} values    any length; deduped here
 * @param {number} [chunkSize]
 * @returns {Promise<Array>}
 */
async function selectIn(supabase, table, columns, column, values, chunkSize = IN_CHUNK_SIZE) {
  const unique = [...new Set(values)].filter(v => v !== null && v !== undefined);
  if (!unique.length) return [];

  const rows = [];
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const { data, error } = await supabase.from(table).select(columns).in(column, chunk);
    if (error) throw new Error(`${table}.${column} chunk at ${i} failed: ${error.message}`);
    rows.push(...(data || []));
  }
  return rows;
}

module.exports = { fetchAllRows, selectIn, PAGE_SIZE, IN_CHUNK_SIZE };
