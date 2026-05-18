const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

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

module.exports = { supabase, verifyConnection };
