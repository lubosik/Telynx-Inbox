'use strict';

// Phone keyboards and pasted marketing copy commonly contain typographic
// punctuation that looks ordinary to a person but changes how an SMS is
// encoded. These substitutions preserve the wording while producing the
// plain punctuation the campaign will actually review and send.
const TYPOGRAPHIC_EQUIVALENTS = Object.freeze({
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-',
  '\u2026': '...',
  '\u00A0': ' ', '\u2007': ' ', '\u202F': ' ', '\u2009': ' ',
  '\u00B4': "'", '\u0060': "'"
});

const TYPOGRAPHIC_PATTERN = /[\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u2012\u2013\u2014\u2015\u2026\u00A0\u2007\u202F\u2009\u00B4\u0060]/g;

function normaliseTypography(text) {
  return String(text).replace(
    TYPOGRAPHIC_PATTERN,
    character => TYPOGRAPHIC_EQUIVALENTS[character] || character
  );
}

function normaliseCampaignCopy(text) {
  return normaliseTypography(text)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

module.exports = { normaliseCampaignCopy, normaliseTypography };
