-- Run this once in Supabase SQL Editor to enable SMS opt-out tracking
ALTER TABLE sms_contacts ADD COLUMN IF NOT EXISTS opted_out BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_sms_contacts_opted_out ON sms_contacts(opted_out) WHERE opted_out = TRUE;
