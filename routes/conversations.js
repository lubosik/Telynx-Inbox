const router = require('express').Router();
const { supabase } = require('../db');
const { reconcileRecentMessageStatuses } = require('../lib/message-status');
const { fetchAllRows } = require('../lib/fetch-all-rows');
const { buildCustomerFacts } = require('../lib/campaigns/segment-facts');
const { normalisePhone } = require('../lib/phone');
const { classifyVIPCustomer, VIP_SEGMENT_KEY } = require('../lib/vip-customers');

let warnedVIPRead = false;

/**
 * Manual VIP additions reuse the existing automatic-segment override ledger.
 * A missing seed migration must never take the inbox down, so automatic VIP
 * classification continues from authoritative order facts and the optional
 * manual layer degrades to empty with one warning.
 */
async function readVIPManualMembership() {
  try {
    const { data: segment, error } = await supabase.from('sms_campaign_segments')
      .select('id').eq('workspace_id', 'vici').eq('segment_key', VIP_SEGMENT_KEY)
      .is('archived_at', null).maybeSingle();
    if (error) throw error;
    if (!segment) return { segmentID: null, manuallyIncluded: new Set() };
    const members = await fetchAllRows(
      supabase,
      'sms_campaign_segment_members',
      'contact_phone,membership_source',
      {
        filter: query => query.eq('workspace_id', 'vici').eq('segment_id', segment.id),
        orderBy: 'contact_phone',
        ascending: true
      }
    );
    return {
      segmentID: segment.id,
      manuallyIncluded: new Set(members
        .filter(row => row.membership_source === 'forced_include')
        .map(row => normalisePhone(row.contact_phone))
        .filter(Boolean))
    };
  } catch (error) {
    if (!warnedVIPRead) {
      warnedVIPRead = true;
      console.warn(`[VIP] Manual membership is unavailable; automatic VIP view remains active (${error.code || 'read_failed'}).`);
    }
    return { segmentID: null, manuallyIncluded: new Set() };
  }
}

router.get('/', async (req, res) => {
  try {
    // Every read here is paged, and none filters by a list of phone numbers.
    //
    // This route previously passed all contact phones into `.in()`, which puts
    // them in the URL. At 907 contacts that is an ~11,800-character filter,
    // which overflows Node's HTTP header limit and fails the request after a
    // ~10 second stall. The error was swallowed, so every lastMessage came back
    // null and the inbox showed phone numbers where message previews belong,
    // while the 25-second response made the app give up with "cancelled".
    //
    // Reading whole tables in pages is both correct and faster: every message
    // belongs to a contact, so filtering by contact bought nothing.
    const [contacts, allMessages, allOrders, vipMembership] = await Promise.all([
      fetchAllRows(supabase, 'sms_contacts', '*', { orderBy: 'id', ascending: true }),
      fetchAllRows(supabase, 'sms_messages',
        'id,contact_phone,body,direction,created_at,media_urls', { thenBy: 'id' }),
      fetchAllRows(supabase, 'sms_orders',
        'id,contact_phone,status,created_at,woo_order_id,total', { thenBy: 'id' }),
      readVIPManualMembership()
    ]);

    if (!contacts.length) return res.json([]);

    // Sorted newest-first, so the first entry seen per phone is the latest.
    const latestMessage = {};
    for (const m of allMessages) {
      if (!latestMessage[m.contact_phone]) latestMessage[m.contact_phone] = m;
    }

    const latestOrder = {};
    for (const o of allOrders) {
      if (!latestOrder[o.contact_phone]) latestOrder[o.contact_phone] = o;
    }

    // One canonical customer record feeds both tabs. The VIP view is a lens on
    // the inbox, not a duplicate contact table, so opening a thread and replying
    // behaves exactly as it does from All Customers.
    const facts = buildCustomerFacts({ contacts, orders: allOrders }, { now: new Date() }).facts;
    const factsByPhone = new Map(facts.map(fact => [fact.contactPhone, fact]));

    const enriched = contacts.map(c => {
      const phone = normalisePhone(c.phone);
      const fact = factsByPhone.get(phone) || { orderCount: 0, lifetimeSpend: 0 };
      const vip = classifyVIPCustomer(fact, {
        manuallyIncluded: vipMembership.manuallyIncluded.has(phone),
        segmentID: vipMembership.segmentID
      });
      return {
        ...c,
        ...vip,
        lastMessage: latestMessage[c.phone] || null,
        latest_order_status: latestOrder[c.phone]?.status || null,
        latest_order_date: latestOrder[c.phone]?.created_at || null,
        latest_order_id: latestOrder[c.phone]?.woo_order_id || null
      };
    });

    res.json(enriched);
  } catch (err) {
    console.error('Conversations load error:', err.message);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

router.get('/:phone', async (req, res) => {
  try {
    const phone = decodeURIComponent(req.params.phone);
    const { data: messages, error } = await supabase
      .from('sms_messages')
      .select('*')
      .eq('contact_phone', phone)
      .order('created_at', { ascending: true });
    if (error) throw error;

    const reconciled = await reconcileRecentMessageStatuses(supabase, messages || []);

    await supabase.from('sms_contacts')
      .update({ unread_count: 0 })
      .eq('phone', phone);

    res.json(reconciled);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load thread' });
  }
});

module.exports = router;
