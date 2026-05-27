-- ShipStation tracking table: one row per shipment (not per order).
-- Stores every SHIP_NOTIFY event and tracks whether SMS has been sent.
-- Run in Supabase SQL editor at:
-- https://supabase.com/dashboard/project/cckzshsvchhsfsnbycoj/sql/new

CREATE TABLE IF NOT EXISTS shipstation_tracking (
  id              BIGSERIAL PRIMARY KEY,
  woo_order_id    TEXT,
  shipstation_shipment_id TEXT UNIQUE NOT NULL,
  shipstation_order_id    TEXT,
  tracking_number TEXT,
  carrier         TEXT,
  customer_phone  TEXT,
  customer_name   TEXT,
  shipment_status TEXT DEFAULT 'label_created',  -- null/label_created | shipped | delivered
  voided          BOOLEAN DEFAULT FALSE,
  shipped_sms_sent   BOOLEAN DEFAULT FALSE,
  delivery_sms_sent  BOOLEAN DEFAULT FALSE,
  label_created_at   TIMESTAMPTZ DEFAULT NOW(),
  shipped_at         TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ,
  last_polled        TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ss_shipment_id
  ON shipstation_tracking(shipstation_shipment_id);

CREATE INDEX IF NOT EXISTS idx_ss_woo_order
  ON shipstation_tracking(woo_order_id);

-- Index used by the polling job: find all records needing a status check
CREATE INDEX IF NOT EXISTS idx_ss_pending_poll
  ON shipstation_tracking(shipped_sms_sent, voided)
  WHERE shipped_sms_sent = FALSE AND voided = FALSE;

-- SMS deduplication log — prevents any flow from double-sending
-- Unique key: (order_id, flow_type) — one SMS per flow per order, ever.
CREATE TABLE IF NOT EXISTS sms_sent_log (
  id              BIGSERIAL PRIMARY KEY,
  order_id        TEXT NOT NULL,
  flow_type       TEXT NOT NULL,    -- 'shipped-msg1' | 'delivery-review'
  phone           TEXT NOT NULL,
  message_body    TEXT,
  telnyx_message_id TEXT,
  sent_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sms_sent_dedup
  ON sms_sent_log(order_id, flow_type);

ALTER TABLE shipstation_tracking DISABLE ROW LEVEL SECURITY;
ALTER TABLE sms_sent_log         DISABLE ROW LEVEL SECURITY;
