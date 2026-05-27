/**
 * Migration runner — creates shipstation_tracking and sms_sent_log tables.
 * Usage: node scripts/run-migration.js
 *
 * Requires: DATABASE_URL env var or SUPABASE_DB_URL
 * Format:   postgresql://postgres:[password]@db.cckzshsvchhsfsnbycoj.supabase.co:5432/postgres
 *
 * If you don't have the URL, paste the SQL from scripts/shipstation-tracking-migration.sql
 * into the Supabase SQL editor at:
 * https://supabase.com/dashboard/project/cckzshsvchhsfsnbycoj/sql/new
 */

require('dotenv').config();
const { Client } = require('pg');

const dbUrl = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;

if (!dbUrl) {
  console.error('ERROR: No DATABASE_URL or SUPABASE_DB_URL in .env');
  console.error('');
  console.error('Option A: Add DATABASE_URL to .env');
  console.error('  Format: postgresql://postgres.[project-ref]:[password]@aws-0-us-east-1.pooler.supabase.com:6543/postgres');
  console.error('');
  console.error('Option B: Run the SQL manually in Supabase dashboard:');
  console.error('  https://supabase.com/dashboard/project/cckzshsvchhsfsnbycoj/sql/new');
  console.error('  Paste the contents of: scripts/shipstation-tracking-migration.sql');
  process.exit(1);
}

const SQL = `
CREATE TABLE IF NOT EXISTS shipstation_tracking (
  id                      BIGSERIAL PRIMARY KEY,
  woo_order_id            TEXT,
  shipstation_shipment_id TEXT UNIQUE NOT NULL,
  shipstation_order_id    TEXT,
  tracking_number         TEXT,
  carrier                 TEXT,
  customer_phone          TEXT,
  customer_name           TEXT,
  shipment_status         TEXT DEFAULT 'label_created',
  voided                  BOOLEAN DEFAULT FALSE,
  shipped_sms_sent        BOOLEAN DEFAULT FALSE,
  delivery_sms_sent       BOOLEAN DEFAULT FALSE,
  label_created_at        TIMESTAMPTZ DEFAULT NOW(),
  shipped_at              TIMESTAMPTZ,
  delivered_at            TIMESTAMPTZ,
  last_polled             TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_shipment_id
  ON shipstation_tracking(shipstation_shipment_id);

CREATE INDEX IF NOT EXISTS idx_ss_woo_order
  ON shipstation_tracking(woo_order_id);

CREATE INDEX IF NOT EXISTS idx_ss_pending_poll
  ON shipstation_tracking(shipped_sms_sent, voided)
  WHERE shipped_sms_sent = FALSE AND voided = FALSE;

CREATE TABLE IF NOT EXISTS sms_sent_log (
  id                BIGSERIAL PRIMARY KEY,
  order_id          TEXT NOT NULL,
  flow_type         TEXT NOT NULL,
  phone             TEXT NOT NULL,
  message_body      TEXT,
  telnyx_message_id TEXT,
  sent_at           TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_sent_dedup
  ON sms_sent_log(order_id, flow_type);

ALTER TABLE shipstation_tracking DISABLE ROW LEVEL SECURITY;
ALTER TABLE sms_sent_log         DISABLE ROW LEVEL SECURITY;
`;

async function run() {
  const client = new Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    await client.connect();
    console.log('Connected to database');
    await client.query(SQL);
    console.log('Migration complete: shipstation_tracking + sms_sent_log created');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
