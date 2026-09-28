'use strict';

// Pure, client-injected compatibility seam for inbox history writes. It never
// imports a provider or initializes a database, and cannot resend a message.
const OPTIONAL_COLUMNS = ['media_urls', 'reply_to_message_id', 'reactions', 'sender_user_id', 'business_phone'];

async function insertSmsHistory(client, row, { returnID = false } = {}) {
  const payload = { ...row };
  for (let attempt = 0; attempt <= OPTIONAL_COLUMNS.length; attempt += 1) {
    let query = client.from('sms_messages').insert(payload);
    if (returnID) query = query.select('id').maybeSingle();
    const { data, error } = await query;
    if (!error) return data;
    const missing = String(error.message || '').match(/'([^']+)' column/i)?.[1];
    // Only schema-cache rejections are safe to retry: the statement did not
    // execute. Never retry uncertain network failures or a duplicate insert.
    if (error.code !== 'PGRST204' || !OPTIONAL_COLUMNS.includes(missing) ||
        !Object.prototype.hasOwnProperty.call(payload, missing)) {
      throw new Error(error.message);
    }
    delete payload[missing];
    console.warn(`[DB] sms_messages missing optional column ${missing}. Inserting without it; check additive messaging migrations.`);
  }
  throw new Error('Unable to store the message after removing absent optional columns.');
}

module.exports = { insertSmsHistory };
