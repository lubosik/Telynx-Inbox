const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const { insertSmsHistory } = require('./lib/sms-history');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false }, realtime: { transport: ws } }
);

async function verifyConnection() {
  const { error } = await supabase
    .from('sms_contacts')
    .select('id')
    .limit(1);
  if (error) {
    console.error('Supabase connection failed:', error.message);
    process.exit(1);
  }
  console.log('Supabase connected OK');
}

// Insert into sms_messages, tolerating a not-yet-migrated schema: if the DB
// doesn't have the MMS/reply columns yet (PGRST204 unknown column), retry
// without them so plain text messages never break on deploy ordering.
async function insertSmsMessage(row) {
  return insertSmsHistory(supabase, row, { returnID: true });
}

module.exports = { supabase, verifyConnection, insertSmsMessage };
