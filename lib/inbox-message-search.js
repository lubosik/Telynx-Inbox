'use strict';

// SQL narrows the scan; this second literal check guarantees that a search for
// a phrase, %, _, or a digit sequence means exactly what the operator typed.
function literalIlikePattern(term) {
  return `%${term.replace(/[\\%_]/g, '\\$&')}%`;
}

function latestConversationMatches(rows, term) {
  const needle = term.toLocaleLowerCase();
  const seen = new Set();
  const matches = [];
  for (const row of rows) {
    if (!row.body?.toLocaleLowerCase().includes(needle)) continue;
    if (seen.has(row.contact_phone)) continue;
    seen.add(row.contact_phone);
    matches.push(row);
  }
  return matches;
}

module.exports = { literalIlikePattern, latestConversationMatches };
