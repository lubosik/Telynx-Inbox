'use strict';

/**
 * Read every Woo customer and reconcile their stable WordPress identity with
 * the additive LUKO identity map. This never creates sms_contacts and never
 * creates consent. Without --apply it is a read-only, aggregate-only audit.
 */
const { createClient } = require('@supabase/supabase-js');
const { normalisePhone } = require('../lib/phone');

const apply = process.argv.includes('--apply');
const workspace = process.env.LUKO_WP_STORE_ID || 'vici';
const wcURL = process.env.WC_URL || 'https://vicipeptides.com/wp-json/wc/v3';

function authHeaders() {
  const value = Buffer.from(`${process.env.WC_CONSUMER_KEY || ''}:${process.env.WC_CONSUMER_SECRET || ''}`).toString('base64');
  return { Authorization: `Basic ${value}` };
}

function customerPhone(customer) {
  const metadata = new Map((customer?.meta_data || []).map(row => [String(row?.key || ''), row?.value]));
  return normalisePhone(customer?.billing?.phone
    || metadata.get('eael_custom_profile_field_phone_number')
    || metadata.get('phone_number'));
}

async function wooCustomers() {
  const rows = [];
  for (let page = 1; page <= 1000; page++) {
    const url = new URL(`${wcURL}/customers`);
    url.searchParams.set('per_page', '100');
    url.searchParams.set('page', String(page));
    url.searchParams.set('orderby', 'id');
    url.searchParams.set('order', 'asc');
    const response = await fetch(url, { headers: authHeaders(), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`WooCommerce customer audit failed with HTTP ${response.status}.`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('WooCommerce returned an invalid customer page.');
    rows.push(...batch);
    const pages = Number(response.headers.get('x-wp-totalpages')) || page;
    if (page >= pages || batch.length === 0) break;
  }
  return rows;
}

async function paged(client, table, columns) {
  const rows = [];
  for (let start = 0; start < 100000; start += 1000) {
    const { data, error } = await client.from(table).select(columns).range(start, start + 999);
    if (error) {
      if (['42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code)) return null;
      throw error;
    }
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

async function main() {
  for (const name of ['WC_CONSUMER_KEY', 'WC_CONSUMER_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY']) {
    if (!process.env[name]) throw new Error(`${name} is required.`);
  }
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });
  const [customers, contacts, consentEvents, mappings] = await Promise.all([
    wooCustomers(), paged(client, 'sms_contacts', 'phone,email,woo_customer_id'),
    paged(client, 'sms_consent_events', 'id,contact_phone,event_type,purpose,brand_id,source,evidence_ref,occurred_at'),
    paged(client, 'luko_customer_identities', 'wordpress_user_id,customer_email,contact_phone')
  ]);
  const contactPhones = new Set((contacts || []).map(row => normalisePhone(row.phone)).filter(Boolean));
  const contactsByWooID = new Map();
  for (const row of contacts || []) {
    if (row.woo_customer_id == null) continue;
    const key = String(row.woo_customer_id);
    const phones = contactsByWooID.get(key) || new Set();
    const phone = normalisePhone(row.phone);
    if (phone) phones.add(phone);
    contactsByWooID.set(key, phones);
  }
  const latestConsent = new Map();
  for (const row of consentEvents || []) {
    const phone = normalisePhone(row.contact_phone);
    if (!phone) continue;
    const prior = latestConsent.get(phone);
    const currentKey = `${row.occurred_at || ''}:${String(row.id || '').padStart(20, '0')}`;
    if (!prior || currentKey > prior.key) latestConsent.set(phone, { key: currentKey, type: row.event_type,
      purpose: row.purpose, brand: row.brand_id, source: row.source, evidence: row.evidence_ref });
  }

  const stats = { wooCustomers: customers.length, phoneAvailable: 0, existingLukoContact: 0,
    existingValidConsent: 0, noConsent: 0, alreadyMapped: mappings?.length || 0,
    externalCustomerMappings: 0, ambiguousExternalMappings: 0,
    identitiesWritten: 0, identityFailures: 0 };
  const prepared = customers.map(customer => {
    const phone = customerPhone(customer);
    const externallyMapped = contactsByWooID.get(String(customer.id)) || new Set();
    if (externallyMapped.size === 1) stats.externalCustomerMappings++;
    if (externallyMapped.size > 1) stats.ambiguousExternalMappings++;
    const resolvedPhone = externallyMapped.size === 1 ? [...externallyMapped][0] : phone;
    if (phone) {
      stats.phoneAvailable++;
      if (contactPhones.has(phone)) stats.existingLukoContact++;
      const consent = latestConsent.get(resolvedPhone);
      if (consent?.type === 'opt_in' && consent.purpose === 'promotional_sms' && consent.brand === workspace
          && consent.source && consent.evidence) stats.existingValidConsent++;
      else stats.noConsent++;
    }
    return { id: String(customer.id), email: String(customer.email || '').trim().toLowerCase() || null, phone };
  });

  if (apply) {
    if (mappings === null) throw new Error('Growth identity migration is not applied. Run it before --apply.');
    for (const customer of prepared) {
      const { data, error } = await client.rpc('resolve_luko_cart_customer_identity', {
        p_workspace: workspace, p_wordpress_user_id: customer.id,
        p_email: customer.email, p_phone: customer.phone
      });
      if (error || !data?.identity_id) stats.identityFailures++;
      else stats.identitiesWritten++;
    }
  }

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry_run', ...stats }, null, 2));
  if (stats.identityFailures) process.exitCode = 1;
}

main().catch(error => {
  console.error(`[VICI IDENTITY RECONCILIATION] ${error.message}`);
  process.exitCode = 1;
});
