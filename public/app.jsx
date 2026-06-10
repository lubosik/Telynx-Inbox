const { useState, useEffect, useRef, useCallback } = React;

const TZ = 'America/New_York';

// Proper responsive hook — updates on resize, avoids stale window.innerWidth reads
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return isMobile;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(ts).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  const todayStr = new Date().toLocaleDateString('en-US', { timeZone: TZ });
  const msgStr = d.toLocaleDateString('en-US', { timeZone: TZ });
  if (todayStr === msgStr) return time;
  return `${time} · ${d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' })}`;
}

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
}

function getInitials(contact) {
  const name = contact?.name || contact?.phone;
  if (!name) return '??';
  const parts = name.split(' ').filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function charCount(text) {
  const chars = text.length;
  const segments = chars === 0 ? 1 : Math.ceil(chars / 160);
  return { chars, segments, isWarning: chars >= 140 && chars <= 160, isDanger: chars > 160 };
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
  return r.json();
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function ToastContainer({ toasts }) {
  return (
    <div className="toast-container">
      {toasts.map(t => <div key={t.id} className="toast">{t.msg}</div>)}
    </div>
  );
}

// ─── Login ───────────────────────────────────────────────────────────────────

function LoginScreen({ onLogin }) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api('POST', '/auth/login', { password: pw });
      onLogin();
    } catch { setError('Incorrect password'); }
    finally { setLoading(false); }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">VICI<small>// SMS</small></div>
        <div className="login-subtitle">Secure Inbox Access</div>
        <form onSubmit={handleSubmit}>
          <div className="input-wrap">
            <input
              type={show ? 'text' : 'password'}
              placeholder="Access code"
              value={pw}
              onChange={e => setPw(e.target.value)}
              autoFocus
            />
            <button type="button" className="eye-btn" onClick={() => setShow(s => !s)}>
              {show ? '◉' : '○'}
            </button>
          </div>
          <button className="btn-primary" type="submit" disabled={loading || !pw}>
            {loading ? <span className="spinner" style={{ borderTopColor: '#030712' }} /> : 'AUTHENTICATE'}
          </button>
          <div className="error-msg">{error}</div>
        </form>
      </div>
    </div>
  );
}

// ─── Order Card (inside modal) ────────────────────────────────────────────────

function OrderCard({ order }) {
  const smsDots = [
    { sent: order.order_sms_sent, title: 'Order confirmed SMS' },
    { sent: order.shipped_sms_sent, title: 'Shipped SMS' },
    { sent: order.delivery_sms_sent, title: 'Delivered SMS' }
  ];
  return (
    <div className="order-card">
      <div className="order-card-header">
        <span className="order-num">#{order.woo_order_id || '—'}</span>
        <span className={`order-badge ${order.status}`}>{order.status}</span>
        <span className="order-total">${parseFloat(order.total || 0).toFixed(2)}</span>
      </div>
      {(order.items || []).slice(0, 3).map((item, i) => (
        <div key={i} className="order-item">
          <span className="order-item-qty">×{item.quantity}</span>{item.name}
        </div>
      ))}
      {(order.items || []).length > 3 && (
        <div className="order-item" style={{ color: 'var(--text3)' }}>+{order.items.length - 3} more items</div>
      )}
      <div className="order-footer">
        <span className="order-date">{formatDate(order.created_at)}</span>
        {order.tracking_number && (
          <span className="tracking-line">📦 {order.carrier?.toUpperCase()} {order.tracking_number}</span>
        )}
        <div className="sms-dots" title={smsDots.map(d => d.title + ': ' + (d.sent ? '✓' : 'pending')).join('\n')}>
          {smsDots.map((d, i) => (
            <div key={i} className={`sms-dot ${d.sent ? 'sent' : 'unsent'}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Suggestion Card ──────────────────────────────────────────────────────────

function SuggestionCard({ s, onSend, onDismiss }) {
  const [sending, setSending] = useState(false);
  const [gone, setGone] = useState(false);
  if (gone) return null;
  return (
    <div className="suggestion-card">
      <div className="sug-type">{s.suggestion_type?.replace(/_/g, ' ')}</div>
      <div className="sug-reason">{s.suggestion_text}</div>
      <div className="sug-msg">{s.suggested_message}</div>
      <div className="sug-actions">
        <button className="btn-sug-send" disabled={sending} onClick={async () => {
          setSending(true);
          await onSend(s.id);
          setSending(false); setGone(true);
        }}>
          {sending ? <span className="spinner" style={{ borderTopColor: '#030712' }} /> : 'Send'}
        </button>
        <button className="btn-sug-dismiss" onClick={() => { onDismiss(s.id); setGone(true); }}>Dismiss</button>
      </div>
    </div>
  );
}

// ─── Contact Modal (3D popup) ─────────────────────────────────────────────────

function ContactModal({ phone, onClose, onGoToMessages, addToast }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('orders');
  const [analysing, setAnalysing] = useState(false);

  useEffect(() => {
    setProfile(null); setLoading(true); setTab('orders');
    api('GET', `/api/contacts/${encodeURIComponent(phone)}`)
      .then(setProfile)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [phone]);

  // Close on escape or backdrop click
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  async function reanalyse() {
    setAnalysing(true);
    try {
      await api('POST', `/api/intelligence/analyse/${encodeURIComponent(phone)}`);
      const d = await api('GET', `/api/contacts/${encodeURIComponent(phone)}`);
      setProfile(d);
      addToast('Analysis updated');
    } catch { addToast('Analysis failed'); }
    setAnalysing(false);
  }

  async function sendSuggestion(id) {
    await api('POST', `/api/intelligence/campaigns/${id}/send`);
    addToast('Message sent');
    const d = await api('GET', `/api/contacts/${encodeURIComponent(phone)}`);
    setProfile(d);
  }

  async function dismissSuggestion(id) {
    await api('POST', `/api/intelligence/campaigns/${id}/dismiss`);
  }

  const intel = profile?.intelligence;
  const suggestions = profile?.suggestions || [];
  const latestOrderStatus = profile?.orders?.[0]?.status || 'none';

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card">
        {/* Close button row */}
        <div className="modal-header">
          <div style={{ width: 30 }} />
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {loading && (
          <div style={{ textAlign: 'center', padding: '3rem' }}>
            <span className="spinner" style={{ width: '24px', height: '24px' }} />
          </div>
        )}

        {!loading && profile && (
          <>
            {/* Identity */}
            <div className="modal-identity">
              <div className="modal-avatar">{getInitials(profile)}</div>
              <div className="modal-info">
                <div className="modal-name">{profile.name || 'Unknown'}</div>
                <div className="modal-phone">{profile.phone}</div>
                {profile.email && <div className="modal-email">{profile.email}</div>}
                {(profile.city || profile.state) && (
                  <div className="modal-location">
                    {[profile.city, profile.state, profile.country].filter(Boolean).join(', ')}
                  </div>
                )}
              </div>
            </div>

            {/* Stats */}
            <div className="modal-stats">
              <div className="modal-stat">
                <div className="modal-stat-val">{profile.total_orders}</div>
                <div className="modal-stat-label">Orders</div>
              </div>
              <div className="modal-stat">
                <div className="modal-stat-val">${profile.total_spent?.toFixed(0) || '0'}</div>
                <div className="modal-stat-label">Spent</div>
              </div>
              <div className="modal-stat">
                <div className="modal-stat-val" style={{ fontSize: '0.75rem' }}>
                  {profile.orders?.[0] ? relativeTime(profile.orders[0].created_at) : '—'}
                </div>
                <div className="modal-stat-label">Last Order</div>
              </div>
            </div>

            {/* Tabs */}
            <div className="modal-tabs">
              <button className={`modal-tab${tab === 'orders' ? ' active' : ''}`} onClick={() => setTab('orders')}>
                Orders {profile.orders?.length > 0 && `(${profile.orders.length})`}
              </button>
              <button className={`modal-tab${tab === 'intel' ? ' active' : ''}`} onClick={() => setTab('intel')}>
                Intelligence
              </button>
            </div>

            {/* Tab body */}
            <div className="modal-body">
              {tab === 'orders' && (
                <>
                  {profile.orders.length === 0 ? (
                    <div className="orders-empty">
                      No orders found.<br />
                      <span style={{ color: 'var(--text3)', fontSize: '0.75rem' }}>Click ↻ WOO to sync WooCommerce orders.</span>
                    </div>
                  ) : (
                    profile.orders.map(order => <OrderCard key={order.id} order={order} />)
                  )}
                </>
              )}

              {tab === 'intel' && (
                <>
                  <div className="reanalyse-row">
                    <button className="reanalyse-btn" onClick={reanalyse} disabled={analysing}>
                      {analysing ? <span className="spinner" /> : '↺ Re-analyse'}
                    </button>
                    {intel?.last_analysed && (
                      <span className="last-analysed-txt">Last: {relativeTime(intel.last_analysed)}</span>
                    )}
                  </div>

                  {!intel ? (
                    <div className="intel-summary" style={{ color: 'var(--text3)' }}>
                      No analysis yet. Send this contact a message, then click re-analyse.
                    </div>
                  ) : (
                    <>
                      {intel.raw_summary && (
                        <div className="intel-section">
                          <div className="intel-label">AI Summary</div>
                          <div className="intel-summary">{intel.raw_summary}</div>
                        </div>
                      )}
                      {intel.sentiment && (
                        <div className="intel-section">
                          <div className="intel-label">Sentiment</div>
                          <span className={`sentiment-badge ${intel.sentiment}`}>{intel.sentiment}</span>
                        </div>
                      )}
                      {intel.inferred_interests?.length > 0 && (
                        <div className="intel-section">
                          <div className="intel-label">Interests</div>
                          {intel.inferred_interests.map((x, i) => <span key={i} className="tag-chip green">{x}</span>)}
                        </div>
                      )}
                      {intel.order_signals?.length > 0 && (
                        <div className="intel-section">
                          <div className="intel-label">Purchase Signals</div>
                          <ul className="signal-list">
                            {intel.order_signals.map((s, i) => <li key={i}>{s}</li>)}
                          </ul>
                        </div>
                      )}
                      {intel.restock_interests?.length > 0 && (
                        <div className="intel-section">
                          <div className="intel-label">Restock Watch</div>
                          {intel.restock_interests.map((x, i) => <span key={i} className="tag-chip orange">{x}</span>)}
                        </div>
                      )}
                    </>
                  )}

                  {suggestions.length > 0 && (
                    <div className="intel-section">
                      <div className="intel-label" style={{ marginBottom: '0.625rem' }}>Campaign Suggestions</div>
                      {suggestions.map(s => (
                        <SuggestionCard key={s.id} s={s} onSend={sendSuggestion} onDismiss={dismissSuggestion} />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer: go to messages */}
            <div className="modal-footer">
              <button className="btn-message" onClick={() => { onGoToMessages(profile.phone); onClose(); }}>
                Open Message Thread →
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Vici Pinned Card ─────────────────────────────────────────────────────────

function ViciModal({ onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card" style={{ maxWidth: 380 }}>
        <div className="modal-header">
          <span style={{
            fontSize: '0.6rem', fontFamily: 'var(--mono)', color: 'var(--accent)',
            letterSpacing: '0.1em', padding: '0.15rem 0.5rem',
            background: 'var(--accent-dim)', border: '1px solid rgba(0,245,160,0.2)', borderRadius: 4
          }}>PINNED · OUR NUMBER</span>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-identity">
          <div className="modal-avatar" style={{ background: 'var(--accent-dim)', fontSize: '1.25rem' }}>V</div>
          <div className="modal-info">
            <div className="modal-name">Vici Peptides</div>
            <div className="modal-phone" style={{ fontSize: '1rem', letterSpacing: '0.04em' }}>+1 (305) 404-3184</div>
            <a
              href="https://vicipeptides.com" target="_blank" rel="noopener noreferrer"
              style={{ fontSize: '0.75rem', color: 'var(--blue)', fontFamily: 'var(--mono)', textDecoration: 'none', display: 'block', marginTop: 4 }}
            >
              vicipeptides.com ↗
            </a>
          </div>
        </div>
        <div style={{
          padding: '0.875rem 1.25rem', borderTop: '1px solid var(--border)',
          color: 'var(--text3)', fontSize: '0.6875rem', fontFamily: 'var(--mono)'
        }}>
          // this is the number your customers text
        </div>
      </div>
    </div>
  );
}

function ViciPinnedCard({ onClick }) {
  return (
    <div className="contact-card vici-card" onClick={onClick}>
      <div className="card-avatar vici-avatar">V</div>
      <div className="card-name">Vici Peptides</div>
      <div className="card-phone">(305) 404-3184</div>
      <div className="card-meta">
        <span className="vici-pin-badge">📌 OUR NUMBER</span>
      </div>
    </div>
  );
}

// ─── Contacts View ────────────────────────────────────────────────────────────

function ContactsView({ contacts, onGoToMessages, addToast }) {
  const [search, setSearch] = useState('');
  const [modalPhone, setModalPhone] = useState(null);
  const [showVici, setShowVici] = useState(false);

  // Sort by most recent activity: max(last_seen, latest_order_date, lastMessage.created_at)
  // lastMessage covers manual outbound sends; last_seen covers live webhooks; latest_order_date covers new orders
  const sorted = [...contacts].sort((a, b) => {
    const aKey = Math.max(
      a.last_seen ? new Date(a.last_seen).getTime() : 0,
      a.latest_order_date ? new Date(a.latest_order_date).getTime() : 0,
      a.lastMessage?.created_at ? new Date(a.lastMessage.created_at).getTime() : 0
    );
    const bKey = Math.max(
      b.last_seen ? new Date(b.last_seen).getTime() : 0,
      b.latest_order_date ? new Date(b.latest_order_date).getTime() : 0,
      b.lastMessage?.created_at ? new Date(b.lastMessage.created_at).getTime() : 0
    );
    return bKey - aKey;
  });

  const filtered = sorted.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.phone.includes(q) || (c.name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q);
  });

  const totalUnread = contacts.reduce((sum, c) => sum + (c.unread_count || 0), 0);

  return (
    <div className="contacts-view">
      <div className="contacts-toolbar">
        <div className="contacts-search-wrap">
          <span className="contacts-search-icon">⌕</span>
          <input
            className="contacts-search"
            placeholder={`Search ${contacts.length} contacts…`}
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="contacts-grid-wrap">
        {contacts.length === 0 ? (
          <div className="contacts-empty">
            // NO CONTACTS YET<br />
            Click ↻ WOO in the header to sync your WooCommerce customers.
          </div>
        ) : (
          <>
            <div className="contacts-count">
              {filtered.length} of {contacts.length} contacts
              {totalUnread > 0 && ` · ${totalUnread} unread`}
            </div>
            <div className="contacts-grid">
              <ViciPinnedCard onClick={() => setShowVici(true)} />
              {filtered.map(c => (
                <ContactCard
                  key={c.phone}
                  contact={c}
                  onClick={() => setModalPhone(c.phone)}
                />
              ))}
            </div>
            {filtered.length === 0 && search && (
              <div className="contacts-empty">// NO MATCHES FOR "{search}"</div>
            )}
          </>
        )}
      </div>

      {showVici && <ViciModal onClose={() => setShowVici(false)} />}
      {modalPhone && (
        <ContactModal
          phone={modalPhone}
          onClose={() => setModalPhone(null)}
          onGoToMessages={(phone) => { onGoToMessages(phone); }}
          addToast={addToast}
        />
      )}
    </div>
  );
}

// ─── Contact Card (in grid) ───────────────────────────────────────────────────

function ContactCard({ contact, onClick }) {
  const latestStatus = contact.latest_order_status || 'none';
  const preview = contact.lastMessage
    ? (contact.lastMessage.direction === 'outbound' ? '↗ ' : '') + truncate(contact.lastMessage.body, 48)
    : null;

  return (
    <div className="contact-card" onClick={onClick}>
      <div className="card-avatar">
        {getInitials(contact)}
        <span className={`card-status-dot ${latestStatus}`} />
      </div>
      <div className="card-name">{contact.name || 'Unknown'}</div>
      <div className="card-phone">{contact.phone?.replace('+1', '')}</div>
      <div className="card-meta">
        {latestStatus !== 'none' && (
          <span className={`card-order-badge ${latestStatus}`} title="Most recent order status">
            Latest: {latestStatus}
          </span>
        )}
        {contact.unread_count > 0 && (
          <span className="card-unread">{contact.unread_count}</span>
        )}
      </div>
      {preview && <div className="card-preview">{preview}</div>}
    </div>
  );
}

// ─── Messages View ────────────────────────────────────────────────────────────

function MessagesView({
  conversations, activePhone, messages, onSelectContact,
  input, setInput, onSend, onKeyDown, sending, inputRef, messagesEndRef,
  mobileSub, setMobileSub, callState, voiceReady, onInitiateCall
}) {
  const [search, setSearch] = useState('');
  const isMobile = useIsMobile();

  // Sort: contacts with messages first (newest message → oldest),
  // then contacts with orders but no messages (newest order → oldest),
  // then contacts with no messages and no orders at the bottom
  const sorted = [...conversations].sort((a, b) => {
    const aMsg = a.lastMessage?.created_at;
    const bMsg = b.lastMessage?.created_at;
    if (aMsg && bMsg) return bMsg.localeCompare(aMsg);
    if (aMsg && !bMsg) return -1;
    if (!aMsg && bMsg) return 1;
    // Both have no messages — sort by most recent activity
    const aKey = Math.max(
      a.last_seen ? new Date(a.last_seen).getTime() : 0,
      a.latest_order_date ? new Date(a.latest_order_date).getTime() : 0
    );
    const bKey = Math.max(
      b.last_seen ? new Date(b.last_seen).getTime() : 0,
      b.latest_order_date ? new Date(b.latest_order_date).getTime() : 0
    );
    return bKey - aKey;
  });

  const filtered = sorted.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.phone.includes(q) || (c.name || '').toLowerCase().includes(q);
  });

  const activeMessages = activePhone ? (messages[activePhone] || []) : [];
  const activeContact = conversations.find(c => c.phone === activePhone);
  const cc = charCount(input);

  return (
    <div className="messages-view">
      {/* Conversation sidebar */}
      <div className={`conv-sidebar${isMobile && mobileSub === 'thread' ? ' hidden' : ''}`}>
        <div className="conv-search-wrap">
          <input
            className="conv-search"
            placeholder="Search messages…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        <div className="conv-list">
          {filtered.length === 0 && (
            <div className="conv-empty">
              {search ? `// no results` : `// no conversations`}
            </div>
          )}
          {filtered.map((c, idx) => {
            const prevHasMsg = idx > 0 && !!filtered[idx - 1].lastMessage;
            const thisHasMsg = !!c.lastMessage;
            const showDivider = prevHasMsg && !thisHasMsg;
            return (
              <React.Fragment key={c.phone}>
                {showDivider && (
                  <div style={{
                    padding: '0.5rem 1rem',
                    fontSize: '0.6rem',
                    color: 'var(--text3)',
                    letterSpacing: '0.1em',
                    fontFamily: 'var(--mono)',
                    borderBottom: '1px solid var(--border)',
                    background: 'var(--bg)'
                  }}>
                    // NO MESSAGES YET
                  </div>
                )}
                <ConvRow
                  contact={c}
                  active={c.phone === activePhone}
                  onClick={() => {
                    onSelectContact(c.phone);
                    if (isMobile) setMobileSub('thread');
                  }}
                />
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Thread */}
      <div className={`thread-panel${isMobile && mobileSub === 'list' ? ' hidden' : ''}`}>
        {!activePhone ? (
          <div className="no-thread">
            <div className="no-thread-icon">✉</div>
            <p>Select a conversation</p>
          </div>
        ) : (
          <>
            <div className="thread-header">
              <button className="back-btn" onClick={() => setMobileSub('list')}>←</button>
              <div className="thread-contact">
                <div className="thread-name">{activeContact?.name || activePhone}</div>
                {activeContact?.name && <div className="thread-phone">{activePhone}</div>}
              </div>
              {activePhone && (
                <button
                  onClick={() => onInitiateCall(activePhone, activeContact?.name || null)}
                  disabled={callState.status !== 'idle' || !voiceReady}
                  style={{
                    background: 'none',
                    border: `1px solid ${callState.status !== 'idle' || !voiceReady ? '#2a2a2a' : '#16a34a'}`,
                    borderRadius: 6, padding: '6px 12px',
                    color: callState.status !== 'idle' || !voiceReady ? '#9ca3af' : '#16a34a',
                    cursor: callState.status !== 'idle' || !voiceReady ? 'default' : 'pointer',
                    fontSize: 13, display: 'flex', alignItems: 'center', gap: 6,
                    marginLeft: 8, flexShrink: 0
                  }}
                  title="Call this customer"
                >
                  📞 Call
                </button>
              )}
            </div>

            <div className="messages-area">
              {activeMessages.length === 0 ? (
                <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text3)', fontFamily: 'var(--mono)', fontSize: '0.8125rem' }}>
                  // no messages yet
                </div>
              ) : (
                activeMessages.map((m, idx) => {
                  const prev = activeMessages[idx - 1];
                  const showDate = !prev ||
                    new Date(m.created_at).toDateString() !== new Date(prev.created_at).toDateString();
                  return (
                    <React.Fragment key={m.id || idx}>
                      {showDate && (
                        <div className="date-divider">
                          {new Date(m.created_at).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' })}
                        </div>
                      )}
                      <div className="msg-group">
                        <div className={`msg-bubble ${m.direction}`}>{m.body}</div>
                        <div className={`msg-meta ${m.direction}`}>
                          {formatTime(m.created_at)}
                          {m.direction === 'outbound' && m.status && (
                            <span style={{
                              marginLeft: '0.375rem',
                              color: m.status === 'delivered' ? 'var(--accent)' : m.status === 'failed' ? 'var(--red)' : 'var(--text3)'
                            }}>
                              {m.status === 'queued' ? '· sending' : m.status === 'sent' ? '· sent' : m.status === 'delivered' ? '· ✓' : '· ✗ failed'}
                            </span>
                          )}
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>

            <div className="compose-area">
              <div className="compose-row">
                <textarea
                  ref={inputRef}
                  className="compose-input"
                  placeholder="Type a message…"
                  value={input}
                  onChange={e => {
                    setInput(e.target.value);
                    e.target.style.height = 'auto';
                    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                  }}
                  onKeyDown={onKeyDown}
                  rows={1}
                />
                <button className="send-btn" onClick={onSend} disabled={!input.trim() || sending}>
                  {sending
                    ? <span className="spinner" style={{ width: '14px', height: '14px', borderTopColor: '#030712' }} />
                    : '↑'}
                </button>
              </div>
              <div className="compose-footer">
                <span className={`char-counter${cc.isWarning ? ' warning' : ''}${cc.isDanger ? ' danger' : ''}`}>
                  {cc.chars}/160
                </span>
                <span>{cc.segments} SMS</span>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Conversation Row ─────────────────────────────────────────────────────────

function smartTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now - d;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) {
    return d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (diffDays < 7) {
    return d.toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short' }) + ' ' +
      d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  }
  return d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' });
}

function ConvRow({ contact: c, active, onClick }) {
  const preview = c.lastMessage
    ? (c.lastMessage.direction === 'outbound' ? '↗ ' : '') + truncate(c.lastMessage.body, 40)
    : 'No messages yet';
  const orderStatus = c.latest_order_status || 'none';
  const timestamp = smartTime(c.lastMessage?.created_at || c.latest_order_date || c.last_seen);
  const isUnread = (c.unread_count || 0) > 0;

  return (
    <div className={`conv-row${active ? ' active' : ''}`} onClick={onClick}>
      <div className="conv-avatar" style={{ position: 'relative' }}>
        {getInitials(c)}
        <span className={`order-dot ${orderStatus}`} />
        {isUnread && (
          <span style={{
            position: 'absolute', top: -2, right: -2,
            width: 10, height: 10, borderRadius: '50%',
            background: '#3b82f6', border: '2px solid var(--bg)',
            display: 'block'
          }} />
        )}
      </div>
      <div className="conv-body">
        <div className="conv-name" style={{ fontWeight: isUnread ? 700 : undefined, color: isUnread ? 'var(--text)' : undefined }}>
          {c.name || c.phone}
        </div>
        <div className="conv-preview">{preview}</div>
      </div>
      <div className="conv-side">
        <span className="conv-time">{timestamp}</span>
        {isUnread && <span className="unread-pill">{c.unread_count > 99 ? '99+' : c.unread_count}</span>}
      </div>
    </div>
  );
}

// ─── Activity Tab Components ──────────────────────────────────────────────────

function flowBadgeStyle(flowType) {
  if (!flowType) return { bg: 'var(--surface2)', color: 'var(--text3)' };
  if (flowType.startsWith('failed'))    return { bg: 'rgba(248,113,113,0.12)', color: 'var(--red)' };
  if (flowType.startsWith('hold'))      return { bg: 'rgba(251,191,36,0.12)',   color: 'var(--yellow)' };
  if (flowType.startsWith('confirmed')) return { bg: 'rgba(0,245,160,0.08)',    color: 'var(--accent)' };
  if (flowType.startsWith('shipped') || flowType.startsWith('delivered'))
    return { bg: 'rgba(0,245,160,0.12)', color: 'var(--accent)' };
  return { bg: 'var(--surface2)', color: 'var(--text3)' };
}

function FlowBadge({ flowType }) {
  const { bg, color } = flowBadgeStyle(flowType);
  return (
    <span style={{
      background: bg, color, fontSize: '0.625rem', fontFamily: 'var(--mono)',
      padding: '2px 6px', borderRadius: 3, whiteSpace: 'nowrap', letterSpacing: '0.03em'
    }}>
      {flowType || 'unknown'}
    </span>
  );
}

function useCountdown(sendAt) {
  const [remaining, setRemaining] = useState('');
  useEffect(() => {
    const tick = () => {
      const diff = new Date(sendAt) - new Date();
      if (diff <= 0) { setRemaining('firing...'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      if (h > 0) setRemaining(`${h}h ${m}m`);
      else if (m > 0) setRemaining(`${m}m ${s}s`);
      else setRemaining(`${s}s`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [sendAt]);
  return remaining;
}

function QueueRow({ item, onCancel }) {
  const countdown = useCountdown(item.send_at);
  const displayName = item.contact_name || ('...' + (item.phone?.slice(-4) || ''));
  const preview = item.message_body
    ? (item.message_body.length > 70 ? item.message_body.slice(0, 70) + '...' : item.message_body)
    : '';

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: '0.625rem',
      padding: '0.75rem 1rem', borderBottom: '1px solid var(--border)',
      minHeight: 56
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text)', fontSize: '0.8125rem', fontWeight: 600 }}>{displayName}</span>
          <FlowBadge flowType={item.flow_type} />
          {item.order_id && (
            <span style={{ color: 'var(--text3)', fontSize: '0.65rem', fontFamily: 'var(--mono)' }}>#{item.order_id}</span>
          )}
        </div>
        <div style={{ color: 'var(--text3)', fontSize: '0.7rem', fontFamily: 'var(--mono)', lineHeight: 1.4 }}>{preview}</div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.375rem', flexShrink: 0, paddingTop: 2 }}>
        <span style={{ color: 'var(--yellow)', fontSize: '0.7rem', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{countdown}</span>
        <button
          onClick={() => onCancel(item)}
          style={{
            background: 'transparent', border: '1px solid rgba(248,113,113,0.4)', color: 'var(--red)',
            padding: '3px 9px', borderRadius: 5, fontSize: '0.65rem', cursor: 'pointer',
            fontFamily: 'var(--mono)', whiteSpace: 'nowrap'
          }}
        >
          cancel
        </button>
      </div>
    </div>
  );
}

function CancelModal({ target, onConfirm, onDismiss, cancelling }) {
  if (!target) return null;
  const displayName = target.contact_name || ('...' + (target.phone?.slice(-4) || ''));
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem'
    }} onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}>
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8,
        padding: '1.5rem', maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto'
      }}>
        <div style={{ color: 'var(--text)', fontSize: '1rem', fontWeight: 600, marginBottom: '1rem' }}>
          Cancel this message?
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--text)', fontWeight: 500 }}>{displayName}</span>
          <FlowBadge flowType={target.flow_type} />
          {target.order_id && <span style={{ color: 'var(--text2)', fontSize: '0.75rem', fontFamily: 'var(--mono)' }}>#{target.order_id}</span>}
        </div>
        <div style={{
          background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
          padding: '0.75rem', fontSize: '0.75rem', color: 'var(--text2)',
          fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', marginBottom: '0.75rem', lineHeight: 1.6
        }}>
          {target.message_body}
        </div>
        <div style={{ color: 'var(--text2)', fontSize: '0.75rem', marginBottom: '1.25rem' }}>
          Would send: {target.send_at ? new Date(target.send_at).toLocaleString('en-US', { timeZone: TZ }) : ''}
        </div>
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button
            onClick={onConfirm}
            disabled={cancelling}
            style={{
              flex: 1, background: '#ef4444', color: '#fff', border: 'none',
              padding: '0.625rem', borderRadius: 6, fontSize: '0.875rem', cursor: 'pointer', fontWeight: 500
            }}
          >
            {cancelling ? <span className="spinner" style={{ borderTopColor: '#fff' }} /> : 'Yes, cancel it'}
          </button>
          <button
            onClick={onDismiss}
            style={{
              flex: 1, background: 'var(--border)', color: 'var(--text2)', border: 'none',
              padding: '0.625rem', borderRadius: 6, fontSize: '0.875rem', cursor: 'pointer'
            }}
          >
            Keep it
          </button>
        </div>
      </div>
    </div>
  );
}

function RecentRow({ item }) {
  const [expanded, setExpanded] = useState(false);
  const displayName = item.contact_name || ('...' + (item.phone?.slice(-4) || ''));

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.625rem 1rem', cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text)', fontSize: '0.8125rem', fontWeight: 500 }}>{displayName}</span>
            <FlowBadge flowType={item.flow_type} />
            {item.order_id && (
              <span style={{ color: 'var(--text2)', fontSize: '0.7rem', fontFamily: 'var(--mono)' }}>#{item.order_id}</span>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
          <span style={{ color: 'var(--text2)', fontSize: '0.7rem', fontFamily: 'var(--mono)' }}>{relativeTime(item.sent_at)}</span>
          <span style={{ color: 'var(--text2)', fontSize: '0.75rem' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>
      {expanded && (
        <div style={{ padding: '0 1rem 0.75rem', borderTop: '1px solid var(--border)' }}>
          <div style={{
            background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6,
            padding: '0.625rem', fontSize: '0.75rem', color: 'var(--text2)',
            fontFamily: 'var(--mono)', whiteSpace: 'pre-wrap', lineHeight: 1.6, marginBottom: '0.375rem'
          }}>
            {item.message_body}
          </div>
          {item.telnyx_message_id && (
            <div style={{ color: 'var(--text2)', fontSize: '0.65rem', fontFamily: 'var(--mono)' }}>
              ID: {item.telnyx_message_id}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LiveFeed({ events }) {
  return (
    <div>
      {events.length === 0 ? (
        <div style={{ padding: '1.25rem', color: 'var(--text2)', fontSize: '0.75rem', fontFamily: 'var(--mono)', textAlign: 'center' }}>
          // waiting for events
        </div>
      ) : events.map((ev, i) => {
        const dotColor = ev.type === 'message_sent'    ? 'var(--accent)'
          : ev.type === 'queue_cancelled' ? 'var(--red)'
          : ev.type === 'new_message'     ? 'var(--blue)'
          : 'var(--yellow)';
        const name = ev.contact_name || (ev.phone ? '...' + ev.phone.slice(-4) : '');
        const label = ev.type === 'queue_added'     ? `queued ${ev.flow_type || ''} for ${name}`
          : ev.type === 'message_sent'   ? `sent ${ev.flow_type || ''} to ${name}`
          : ev.type === 'queue_cancelled' ? `cancelled ${ev.flow_type || ''} for ${name}`
          : ev.type === 'new_message'    ? `inbound SMS from ${name}`
          : ev.type;
        return (
          <div key={i} style={{
            display: 'flex', alignItems: 'center', gap: '0.5rem',
            padding: '0.5rem 1rem', borderBottom: '1px solid var(--border)',
            borderLeft: `3px solid ${dotColor}`
          }}>
            <span style={{ color: 'var(--text)', fontSize: '0.75rem', fontFamily: 'var(--mono)', flex: 1 }}>{label}</span>
            <span style={{ color: 'var(--text2)', fontSize: '0.65rem', fontFamily: 'var(--mono)', flexShrink: 0 }}>
              {relativeTime(ev.ts)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: '0.75rem 0.5rem', textAlign: 'center'
    }}>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color, fontFamily: 'var(--mono)', lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: '0.6rem', color: 'var(--text3)', marginTop: '0.3rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
    </div>
  );
}

const FLOW_FILTERS = [
  { value: 'all',                label: 'All' },
  { value: 'failed-msg1',        label: 'Failed 1' },
  { value: 'failed-msg2',        label: 'Failed 2' },
  { value: 'failed-msg3',        label: 'Failed 3' },
  { value: 'hold-msg1',          label: 'Hold 1' },
  { value: 'hold-msg2',          label: 'Hold 2' },
  { value: 'hold-msg3',          label: 'Hold 3' },
  { value: 'hold-failed-nudge',  label: 'Nudge' },
  { value: 'confirmed-new',      label: 'New' },
  { value: 'confirmed-returning',label: 'Return' },
  { value: 'shipped-msg1',       label: 'Shipped' },
  { value: 'delivered-msg1',     label: 'Delivered' },
];

function ActivityTab({ sseStatus }) {
  const [stats, setStats]           = useState({ pending: 0, sentToday: 0, failedToday: 0, cancelledToday: 0 });
  const [queue, setQueue]           = useState([]);
  const [recent, setRecent]         = useState([]);
  const [flowFilter, setFlowFilter] = useState('all');
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [loading, setLoading]       = useState(true);
  const [liveEvents, setLiveEvents] = useState([]);
  const [queuePage, setQueuePage]   = useState(1);
  const [queueHasMore, setQueueHasMore] = useState(false);
  const [recentPage, setRecentPage] = useState(1);
  const [recentHasMore, setRecentHasMore] = useState(false);
  const isMobile = useIsMobile();

  const currentFilter = useRef(flowFilter);
  currentFilter.current = flowFilter;

  async function loadAll(filter, qPage, rPage) {
    const f  = filter ?? flowFilter;
    const qp = qPage  ?? 1;
    const rp = rPage  ?? 1;
    try {
      const [s, q, r] = await Promise.all([
        api('GET', '/api/activity/stats'),
        api('GET', `/api/activity/queue?flow=${f}&page=${qp}`),
        api('GET', `/api/activity/recent?flow=${f}&page=${rp}`),
      ]);
      setStats(s);
      if (qp === 1) setQueue(q.items || []);
      else setQueue(prev => [...prev, ...(q.items || [])]);
      setQueueHasMore(q.hasMore || false);
      if (rp === 1) setRecent(r.items || []);
      else setRecent(prev => [...prev, ...(r.items || [])]);
      setRecentHasMore(r.hasMore || false);
    } catch (err) {
      console.error('[Activity] load error:', err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setQueuePage(1);
    setRecentPage(1);
    loadAll(flowFilter, 1, 1);
  }, [flowFilter]);

  useEffect(() => {
    function handleSSE(e) {
      const event = { ...e.detail, ts: new Date().toISOString() };
      const activityTypes = ['queue_added', 'queue_cancelled', 'message_sent', 'new_message'];
      if (activityTypes.includes(event.type)) {
        setLiveEvents(prev => [event, ...prev].slice(0, 20));
      }
      switch (event.type) {
        case 'queue_added':
          setQueue(prev => {
            if (prev.some(m => m.id === event.id)) return prev;
            const newItem = { id: event.id, order_id: event.order_id, phone: event.phone, flow_type: event.flow_type, send_at: event.send_at, message_body: '', contact_name: null };
            return [...prev, newItem].sort((a, b) => new Date(a.send_at) - new Date(b.send_at));
          });
          setStats(prev => ({ ...prev, pending: prev.pending + 1 }));
          break;
        case 'queue_cancelled':
          setQueue(prev => prev.filter(m => m.id !== event.id));
          setStats(prev => ({ ...prev, pending: Math.max(0, prev.pending - 1), cancelledToday: prev.cancelledToday + 1 }));
          break;
        case 'message_sent':
          setQueue(prev => prev.filter(m => m.id !== event.id));
          setStats(prev => ({ ...prev, pending: Math.max(0, prev.pending - 1), sentToday: prev.sentToday + 1 }));
          api('GET', `/api/activity/recent?flow=${currentFilter.current}&page=1`).then(r => setRecent(r.items || [])).catch(() => {});
          break;
        case 'stats_update':
          api('GET', '/api/activity/stats').then(setStats).catch(() => {});
          break;
      }
    }
    window.addEventListener('vici-sse', handleSSE);
    return () => window.removeEventListener('vici-sse', handleSSE);
  }, []);

  async function handleCancelConfirm() {
    if (!cancelTarget || cancelling) return;
    setCancelling(true);
    try {
      await api('DELETE', `/api/activity/queue/${cancelTarget.id}`);
      setQueue(prev => prev.filter(m => m.id !== cancelTarget.id));
      setStats(prev => ({ ...prev, pending: Math.max(0, prev.pending - 1), cancelledToday: prev.cancelledToday + 1 }));
    } catch (err) {
      console.error('[Activity] cancel error:', err.message);
    } finally {
      setCancelling(false);
      setCancelTarget(null);
    }
  }

  const sectionStyle = {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 10, overflow: 'hidden'
  };
  const sectionHdr = {
    padding: '0.625rem 1rem', borderBottom: '1px solid var(--border)',
    fontSize: '0.65rem', fontFamily: 'var(--mono)', color: 'var(--text3)',
    letterSpacing: '0.1em', textTransform: 'uppercase',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
  };
  const loadMoreBtn = {
    background: 'none', border: '1px solid var(--border)', color: 'var(--text3)',
    padding: '5px 16px', borderRadius: 5, cursor: 'pointer',
    fontSize: '0.7rem', fontFamily: 'var(--mono)'
  };

  return (
    // Outer shell — fills .main-content, clips to viewport bounds
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>

      {/* Scrollable content — the only scrolling layer */}
      <div style={{
        flex: 1, overflowY: 'auto', overflowX: 'hidden',
        WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain'
      }}>
        <div style={{
          padding: isMobile ? '0.75rem' : '1.25rem 1.5rem',
          maxWidth: 900, margin: '0 auto',
          display: 'flex', flexDirection: 'column', gap: '0.875rem',
          paddingBottom: isMobile ? '1.5rem' : '2rem'
        }}>

          {/* Stats — always 2×2 on mobile, 4-across on desktop */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)',
            gap: '0.5rem'
          }}>
            <StatCard label="Pending"         value={stats.pending}        color="var(--yellow)" />
            <StatCard label="Sent today"       value={stats.sentToday}      color="var(--accent)" />
            <StatCard label="Failed today"     value={stats.failedToday}    color="var(--red)" />
            <StatCard label="Cancelled today"  value={stats.cancelledToday} color="var(--text2)" />
          </div>

          {/* Flow filter pills */}
          <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: '4px', marginBottom: '-4px' }}>
            <div style={{ display: 'flex', gap: '0.375rem', minWidth: 'max-content', paddingBottom: '2px' }}>
              {FLOW_FILTERS.map(f => (
                <button
                  key={f.value}
                  onClick={() => setFlowFilter(f.value)}
                  style={{
                    padding: '5px 11px', borderRadius: 20, cursor: 'pointer',
                    fontSize: '0.675rem', fontFamily: 'var(--mono)', whiteSpace: 'nowrap',
                    fontWeight: 600, letterSpacing: '0.03em',
                    border: flowFilter === f.value ? '1px solid var(--accent)' : '1px solid var(--border)',
                    background: flowFilter === f.value ? 'var(--accent-dim)' : 'transparent',
                    color:      flowFilter === f.value ? 'var(--accent)'      : 'var(--text3)',
                  }}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {/* Queue */}
          <div style={sectionStyle}>
            <div style={sectionHdr}>
              <span>// queue ({queue.length}{queueHasMore ? '+' : ''})</span>
              <span style={{
                color: sseStatus === 'connected' ? 'var(--accent)' : 'var(--yellow)',
                fontSize: '0.6rem', fontFamily: 'var(--mono)'
              }}>
                {sseStatus === 'connected' ? '● live' : '○ ' + sseStatus}
              </span>
            </div>
            {loading ? (
              <div style={{ padding: '2rem', textAlign: 'center' }}><span className="spinner" /></div>
            ) : queue.length === 0 ? (
              <div style={{ padding: '1.5rem', color: 'var(--text3)', fontSize: '0.75rem', fontFamily: 'var(--mono)', textAlign: 'center' }}>
                // queue is empty
              </div>
            ) : (
              <>
                {queue.map(item => <QueueRow key={item.id} item={item} onCancel={setCancelTarget} />)}
                {queueHasMore && (
                  <div style={{ padding: '0.625rem', textAlign: 'center' }}>
                    <button style={loadMoreBtn} onClick={() => { const n = queuePage + 1; setQueuePage(n); loadAll(flowFilter, n, recentPage); }}>
                      load more
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Recent sends */}
          <div style={sectionStyle}>
            <div style={sectionHdr}><span>// recent sends</span></div>
            {loading ? (
              <div style={{ padding: '2rem', textAlign: 'center' }}><span className="spinner" /></div>
            ) : recent.length === 0 ? (
              <div style={{ padding: '1.5rem', color: 'var(--text3)', fontSize: '0.75rem', fontFamily: 'var(--mono)', textAlign: 'center' }}>
                // no messages sent yet
              </div>
            ) : (
              <>
                {recent.map(item => <RecentRow key={item.id} item={item} />)}
                {recentHasMore && (
                  <div style={{ padding: '0.625rem', textAlign: 'center' }}>
                    <button style={loadMoreBtn} onClick={() => { const n = recentPage + 1; setRecentPage(n); loadAll(flowFilter, queuePage, n); }}>
                      load more
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Live feed */}
          <div style={sectionStyle}>
            <div style={sectionHdr}>
              <span>// live feed</span>
              <span style={{ color: 'var(--text3)', fontSize: '0.6rem', fontFamily: 'var(--mono)' }}>
                {liveEvents.length} events
              </span>
            </div>
            <LiveFeed events={liveEvents} />
          </div>

        </div>
      </div>

      {/* Cancel modal renders outside the scroll area so it always covers full screen */}
      <CancelModal
        target={cancelTarget}
        onConfirm={handleCancelConfirm}
        onDismiss={() => setCancelTarget(null)}
        cancelling={cancelling}
      />
    </div>
  );
}

// ─── Voice Components ─────────────────────────────────────────────────────────

function CallConfirmModal({ target, onConfirm, onCancel }) {
  if (!target) return null;
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000
    }}>
      <div style={{
        background: '#1a1a1a', border: '1px solid #2a2a2a',
        borderRadius: 12, padding: 28, minWidth: 280, textAlign: 'center'
      }}>
        <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 8, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
          Calling
        </div>
        <div style={{ fontSize: 20, fontWeight: 600, color: '#fff', marginBottom: 4 }}>
          {target.name !== target.phone ? target.name : target.phone}
        </div>
        {target.name !== target.phone && (
          <div style={{ fontSize: 14, color: '#9ca3af', marginBottom: 24 }}>{target.phone}</div>
        )}
        {target.name === target.phone && <div style={{ marginBottom: 24 }} />}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
          <button onClick={onConfirm} style={{
            background: '#16a34a', border: 'none', borderRadius: 8,
            padding: '12px 24px', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer'
          }}>Call</button>
          <button onClick={onCancel} style={{
            background: 'none', border: '1px solid #2a2a2a', borderRadius: 8,
            padding: '12px 24px', color: '#9ca3af', fontSize: 14, cursor: 'pointer'
          }}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ActiveCallPanel({ callState, onAnswer, onHangup, onMute, onRecord, onSpeaker, isSpeaker, formatDuration }) {
  if (callState.status === 'idle') return null;
  const isInbound = callState.direction === 'inbound';
  const isRinging = callState.status === 'ringing';
  const isActive = callState.status === 'active';
  const isEnded = callState.status === 'ended';

  return (
    <div style={{
      position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
      background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 16,
      padding: '20px 28px', minWidth: 290, zIndex: 1500,
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)', textAlign: 'center'
    }}>
      <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 6, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
        {isRinging && isInbound ? 'Incoming call'
          : isRinging && !isInbound ? 'Calling...'
          : isActive ? 'On call'
          : 'Call ended'}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: '#fff', marginBottom: 2 }}>
        {callState.contactName || callState.contactPhone}
      </div>
      {callState.contactName && (
        <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 12 }}>{callState.contactPhone}</div>
      )}
      {isActive && (
        <div style={{ fontSize: 22, fontWeight: 700, color: '#16a34a', marginBottom: 16 }}>
          {formatDuration(callState.duration)}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        {isRinging && isInbound && (
          <>
            <button onClick={onAnswer} style={{ background: '#16a34a', border: 'none', borderRadius: '50%', width: 56, height: 56, color: '#fff', fontSize: 22, cursor: 'pointer' }}>📞</button>
            <button onClick={onHangup} style={{ background: '#ef4444', border: 'none', borderRadius: '50%', width: 56, height: 56, color: '#fff', fontSize: 22, cursor: 'pointer' }}>📵</button>
          </>
        )}
        {isActive && (
          <>
            <button onClick={onMute} style={{ background: callState.isMuted ? '#ef4444' : '#2a2a2a', border: 'none', borderRadius: '50%', width: 48, height: 48, color: '#fff', fontSize: 18, cursor: 'pointer' }} title={callState.isMuted ? 'Unmute' : 'Mute'}>
              {callState.isMuted ? '🔇' : '🎤'}
            </button>
            <button onClick={onSpeaker} style={{ background: isSpeaker ? '#2563eb' : '#2a2a2a', border: 'none', borderRadius: '50%', width: 48, height: 48, color: '#fff', fontSize: 18, cursor: 'pointer' }} title={isSpeaker ? 'Speaker on' : 'Speaker off'}>
              🔊
            </button>
            <button onClick={onRecord} style={{ background: callState.isRecording ? '#ef4444' : '#2a2a2a', border: 'none', borderRadius: '50%', width: 48, height: 48, color: '#fff', fontSize: 18, cursor: 'pointer' }} title={callState.isRecording ? 'Stop recording' : 'Start recording'}>
              {callState.isRecording ? '⏹' : '⏺'}
            </button>
            <button onClick={onHangup} style={{ background: '#ef4444', border: 'none', borderRadius: '50%', width: 48, height: 48, color: '#fff', fontSize: 22, cursor: 'pointer' }}>📵</button>
          </>
        )}
        {isRinging && !isInbound && (
          <button onClick={onHangup} style={{ background: '#ef4444', border: 'none', borderRadius: '50%', width: 56, height: 56, color: '#fff', fontSize: 22, cursor: 'pointer' }}>📵</button>
        )}
        {isEnded && (
          <div style={{ color: '#9ca3af', fontSize: 14, padding: '8px 0' }}>Call ended</div>
        )}
      </div>
    </div>
  );
}

function DialerSection({ dialNumber, setDialNumber, onCall, voiceReady }) {
  const KEYPAD = [['1','2','3'],['4','5','6'],['7','8','9'],['*','0','#']];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 24, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
      <div style={{ fontSize: 28, fontWeight: 300, color: '#fff', minHeight: 44, marginBottom: 24, letterSpacing: '0.08em', textAlign: 'center' }}>
        {dialNumber || <span style={{ color: '#9ca3af', fontSize: 16 }}>Enter a number</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 72px)', gap: 12, marginBottom: 24 }}>
        {KEYPAD.flat().map(key => (
          <button key={key} onClick={() => setDialNumber(prev => prev + key)} style={{
            width: 72, height: 72, borderRadius: '50%',
            background: '#1a1a1a', border: '1px solid #2a2a2a',
            color: '#fff', fontSize: 20, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>{key}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <button onClick={() => setDialNumber(prev => prev.slice(0, -1))} disabled={!dialNumber}
          style={{ width: 48, height: 48, borderRadius: '50%', background: 'none', border: 'none', color: '#9ca3af', fontSize: 20, cursor: 'pointer' }}>
          ⌫
        </button>
        <button onClick={() => dialNumber && onCall(dialNumber, null)} disabled={!dialNumber || !voiceReady}
          style={{
            width: 72, height: 72, borderRadius: '50%',
            background: (!dialNumber || !voiceReady) ? '#1a1a1a' : '#16a34a',
            border: 'none', color: '#fff', fontSize: 28,
            cursor: (!dialNumber || !voiceReady) ? 'default' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center'
          }}>
          📞
        </button>
        <button onClick={() => setDialNumber(prev => prev + '+')}
          style={{ width: 48, height: 48, borderRadius: '50%', background: 'none', border: '1px solid #2a2a2a', color: '#9ca3af', fontSize: 18, cursor: 'pointer', fontWeight: 700 }}>
          +
        </button>
      </div>
    </div>
  );
}

function CallLogsSection({ logs, onCall }) {
  const statusIcon = {
    completed: { icon: '↗', color: '#16a34a' },
    missed: { icon: '↙', color: '#ef4444' },
    initiated: { icon: '↗', color: '#9ca3af' },
    failed: { icon: '✕', color: '#ef4444' },
    declined: { icon: '✕', color: '#ef4444' },
    answered: { icon: '↔', color: '#3b82f6' }
  };

  if (!logs.length) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af', fontSize: 14 }}>
      No calls yet
    </div>
  );

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      {logs.map(log => {
        const icon = statusIcon[log.status] || { icon: '?', color: '#9ca3af' };
        const phone = log.contact_phone;
        const durStr = log.duration_seconds > 0
          ? `${Math.floor(log.duration_seconds/60).toString().padStart(2,'0')}:${(log.duration_seconds%60).toString().padStart(2,'0')}`
          : null;
        return (
          <div key={log.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: '1px solid #1a1a1a' }}>
            <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#1a1a1a', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, color: icon.color }}>
              {icon.icon}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, color: '#fff', marginBottom: 2 }}>{phone}</div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>
                {log.status}{durStr ? ` · ${durStr}` : ''} · {relativeTime(log.started_at)}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => onCall(phone, null)} style={{ background: 'none', border: '1px solid #2a2a2a', borderRadius: 6, padding: '6px 10px', color: '#16a34a', cursor: 'pointer', fontSize: 14 }} title="Call back">📞</button>
              {log.recording_url_mp3 && (
                <a href={log.recording_url_mp3} target="_blank" rel="noreferrer"
                  style={{ background: 'none', border: '1px solid #2a2a2a', borderRadius: 6, padding: '6px 10px', color: '#3b82f6', cursor: 'pointer', fontSize: 14, textDecoration: 'none', display: 'flex', alignItems: 'center' }}
                  title="Play recording">
                  ▶
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VoiceTab({ callLogs, dialNumber, setDialNumber, onCall, voiceReady, onRetryConnect }) {
  const [activeSection, setActiveSection] = useState('dialer');
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', borderBottom: '1px solid #2a2a2a', padding: '0 16px' }}>
        {['dialer', 'logs'].map(s => (
          <button key={s} onClick={() => setActiveSection(s)} style={{
            background: 'none', border: 'none', padding: '14px 16px',
            color: activeSection === s ? '#16a34a' : '#9ca3af',
            borderBottom: activeSection === s ? '2px solid #16a34a' : '2px solid transparent',
            cursor: 'pointer', fontSize: 13, textTransform: 'capitalize', letterSpacing: '0.06em'
          }}>
            {s === 'dialer' ? 'Dialer' : 'Call Log'}
          </button>
        ))}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: '#9ca3af' }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: voiceReady ? '#16a34a' : '#ef4444' }} />
          {voiceReady ? 'Connected' : 'Not connected'}
          {!voiceReady && (
            <button onClick={onRetryConnect} style={{
              background: '#1a1a1a', border: '1px solid #2a2a2a', borderRadius: 6,
              color: '#9ca3af', fontSize: 11, padding: '3px 8px', cursor: 'pointer'
            }}>
              Reconnect
            </button>
          )}
        </div>
      </div>
      {activeSection === 'dialer' && (
        <DialerSection dialNumber={dialNumber} setDialNumber={setDialNumber} onCall={onCall} voiceReady={voiceReady} />
      )}
      {activeSection === 'logs' && (
        <CallLogsSection logs={callLogs} onCall={onCall} />
      )}
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function App() {
  const [auth, setAuth] = useState({ checking: true, ok: false });
  const [conversations, setConversations] = useState([]);
  const [activePhone, setActivePhone] = useState(null);
  const [messages, setMessages] = useState({});
  const [input, setInput] = useState('');
  const [sseStatus, setSseStatus] = useState('connecting');
  const [sending, setSending] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [statusSyncing, setStatusSyncing] = useState(false);
  const [catchingUp, setCatchingUp] = useState(false);
  const [mainTab, setMainTab] = useState('contacts'); // 'contacts' | 'messages' | 'activity' | 'voice'
  const [mobileSub, setMobileSub] = useState('list'); // 'list' | 'thread'

  // ── Voice state ──────────────────────────────────────────────────────────────
  const [voiceReady, setVoiceReady] = useState(false);
  const [callState, setCallState] = useState({
    status: 'idle', direction: null, contactPhone: null,
    contactName: null, callControlId: null, duration: 0,
    isMuted: false, isRecording: false
  });
  const [callLogs, setCallLogs] = useState([]);
  const [dialNumber, setDialNumber] = useState('');
  const [confirmCall, setConfirmCall] = useState(null);
  const [isSpeaker, setIsSpeaker] = useState(false);
  const telnyxClientRef = useRef(null);
  const activeCallRef = useRef(null);
  const durationTimerRef = useRef(null);
  const callerNumberRef = useRef('+13054043184');
  const callStartRef = useRef(null);
  const callDirectionRef = useRef('outbound');

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const sseRef = useRef(null);
  const reconnectTimer = useRef(null);
  // Capture deep-link phone from URL on mount (?thread=+1xxx) — applied after conversations load
  const deepLinkPhone = useRef(new URLSearchParams(window.location.search).get('thread'));
  const deepLinkApplied = useRef(false);
  const reconnectDelay = useRef(1000);
  const pollTimer = useRef(null);

  function addToast(msg) {
    const id = Date.now();
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }

  useEffect(() => {
    api('GET', '/auth/check')
      .then(d => setAuth({ checking: false, ok: d.authenticated }))
      .catch(() => setAuth({ checking: false, ok: false }));
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const data = await api('GET', '/api/conversations');
      setConversations(data);
    } catch {}
  }, []);

  const loadThread = useCallback(async (phone) => {
    try {
      const data = await api('GET', `/api/conversations/${encodeURIComponent(phone)}`);
      setMessages(m => ({ ...m, [phone]: data }));
    } catch {}
  }, []);

  useEffect(() => {
    if (!auth.ok) return;
    loadConversations();
    requestNotificationPermission();
    connectSSE();
    initVoiceClient();
    loadCallLogs();
    pollTimer.current = setInterval(loadConversations, 30000);
    return () => {
      clearInterval(pollTimer.current);
      if (sseRef.current) sseRef.current.close();
      clearTimeout(reconnectTimer.current);
    };
  }, [auth.ok]);

  // Apply notification deep-link once conversations are available
  useEffect(() => {
    if (!auth.ok || conversations.length === 0 || deepLinkApplied.current || !deepLinkPhone.current) return;
    deepLinkApplied.current = true;
    goToMessages(deepLinkPhone.current);
    window.history.replaceState({}, '', '/');
  }, [auth.ok, conversations]);

  function connectSSE() {
    if (sseRef.current) sseRef.current.close();
    setSseStatus('connecting');
    const es = new EventSource('/api/sse', { withCredentials: true });
    sseRef.current = es;
    es.onopen = () => { setSseStatus('connected'); reconnectDelay.current = 1000; };
    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === 'connected') return;

        if (evt.type === 'status_update') {
          const { messageId, status, phone } = evt;
          setMessages(m => {
            if (!m[phone]) return m;
            return { ...m, [phone]: m[phone].map(msg => msg.telnyx_message_id === messageId ? { ...msg, status } : msg) };
          });
          return;
        }

        // Dispatch to Activity tab SSE listener
        window.dispatchEvent(new CustomEvent('vici-sse', { detail: evt }));

        if (evt.type === 'order_status_updated') {
          const { phone: updatedPhone, status: updatedStatus } = evt;
          const now = new Date().toISOString();
          setConversations(prev => prev.map(c =>
            c.phone === updatedPhone
              ? { ...c, latest_order_status: updatedStatus, last_seen: now }
              : c
          ));
          return;
        }

        if (evt.type === 'call_update') {
          if (evt.event === 'hangup') loadCallLogs();
          return;
        }

        if (evt.type === 'call_recording_saved') {
          loadCallLogs();
          return;
        }

        if (evt.type === 'new_message') {
          const { phone, body, direction } = evt;
          setConversations(prev => {
            const idx = prev.findIndex(c => c.phone === phone);
            const now = new Date().toISOString();
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = {
                ...updated[idx],
                last_seen: now,
                lastMessage: { body, direction, created_at: now },
                unread_count: (direction === 'inbound' && phone !== activePhone) ? (updated[idx].unread_count || 0) + 1 : updated[idx].unread_count
              };
              return [updated[idx], ...updated.filter((_, i) => i !== idx)];
            } else {
              loadConversations();
              return prev;
            }
          });
          setActivePhone(ap => {
            if (ap === phone) {
              setMessages(m => ({
                ...m,
                [phone]: [...(m[phone] || []), { id: Date.now(), contact_phone: phone, direction, body, created_at: new Date().toISOString(), status: 'delivered' }]
              }));
            }
            return ap;
          });
          if (direction === 'inbound' && isAppInBackground()) {
            const contact = conversations.find(c => c.phone === phone);
            showNotification(`New message from ${contact?.name || phone}`, body.slice(0, 80), phone);
          }
        }
      } catch {}
    };
    es.onerror = () => {
      setSseStatus('reconnecting');
      es.close();
      reconnectTimer.current = setTimeout(() => {
        reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
        connectSSE();
      }, reconnectDelay.current);
    };
  }

  function requestNotificationPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }

  function isAppInBackground() {
    return document.hidden || !document.hasFocus();
  }

  function showNotification(title, body, phoneTag) {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (!document.hidden && document.hasFocus()) return;

    const n = new Notification(title, {
      body,
      tag: phoneTag ? encodeURIComponent(phoneTag) : 'vici-sms',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      requireInteraction: false
    });

    setTimeout(() => { try { n.close(); } catch (_) {} }, 4000);

    n.onclick = () => {
      window.focus();
      if (phoneTag && phoneTag !== 'incoming-call') {
        setActivePhone(phoneTag);
        setMobileSub('thread');
      }
      n.close();
    };
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activePhone]);

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden || !('serviceWorker' in navigator)) return;
      navigator.serviceWorker.ready
        .then(reg => reg.getNotifications())
        .then(notifications => notifications.forEach(n => n.close()))
        .catch(() => {});
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (activePhone) loadThread(activePhone);
  }, [activePhone]);

  function selectContact(phone) {
    setActivePhone(phone);
    setConversations(prev => prev.map(c => c.phone === phone ? { ...c, unread_count: 0 } : c));
    setTimeout(() => inputRef.current?.focus(), 150);
  }

  // ── Voice functions ──────────────────────────────────────────────────────────

  async function initVoiceClient() {
    if (telnyxClientRef.current) return;
    try {
      const res = await fetch('/api/voice/token', { credentials: 'include' });
      if (!res.ok) throw new Error('Token fetch failed');
      const { login, password, callerNumber } = await res.json();
      if (callerNumber) callerNumberRef.current = callerNumber;

      const TelnyxRTC = window.TelnyxWebRTC?.TelnyxRTC || window.TelnyxRTC;
      if (!TelnyxRTC) throw new Error('Telnyx WebRTC SDK not loaded');

      const client = new TelnyxRTC({ login, password });
      client.remoteElement = 'telnyx-audio';

      client.on('telnyx.ready', () => { console.log('[VOICE] Client ready'); setVoiceReady(true); });
      client.on('telnyx.error', (err) => { console.error('[VOICE] Client error:', err); setVoiceReady(false); });
      client.on('telnyx.notification', (notification) => {
        if (notification.type !== 'callUpdate') return;
        handleCallStateChange(notification.call);
      });

      await client.connect();
      telnyxClientRef.current = client;
    } catch (err) {
      console.error('[VOICE] Init failed:', err.message);
    }
  }

  // Tear down existing client (if any) and reconnect — called manually from Voice tab
  // and on tab open when not connected. This handles mobile where the initial
  // auto-init may have failed silently (iOS Safari WebRTC needs a user gesture).
  async function retryVoiceConnect() {
    try {
      if (telnyxClientRef.current) {
        try { telnyxClientRef.current.disconnect(); } catch {}
        telnyxClientRef.current = null;
      }
      setVoiceReady(false);
    } catch {}
    await initVoiceClient();
  }

  function handleCallStateChange(call) {
    activeCallRef.current = call;
    const state = call.state;
    const phone = call.options?.remoteCallerNumber || call.options?.destinationNumber || 'Unknown';

    console.log('[VOICE] Call state:', state, 'phone: ...'+phone.slice(-4));

    switch (state) {
      case 'ringing':
        callDirectionRef.current = 'inbound';
        callStartRef.current = Date.now();
        setCallState({
          status: 'ringing', direction: 'inbound',
          contactPhone: phone, contactName: getContactName(phone),
          callControlId: call.id, duration: 0, isMuted: false, isRecording: false
        });
        if (isAppInBackground()) {
          showNotification('Incoming call', `${getContactName(phone) || phone} is calling`, 'incoming-call');
        }
        break;
      case 'active':
        if (!callStartRef.current) callStartRef.current = Date.now();
        setCallState(prev => ({ ...prev, status: 'active' }));
        startDurationTimer();
        break;
      case 'hangup':
      case 'destroy':
      case 'purge': {
        stopDurationTimer();
        const endedAt = new Date().toISOString();
        const startedAt = callStartRef.current
          ? new Date(callStartRef.current).toISOString()
          : endedAt;
        const durationSecs = callStartRef.current
          ? Math.floor((Date.now() - callStartRef.current) / 1000)
          : 0;
        callStartRef.current = null;

        // Save call log client-side — fallback if Telnyx webhook didn't fire
        const direction = callDirectionRef.current || 'outbound';
        const myNumber = callerNumberRef.current;
        api('POST', '/api/voice/logs', {
          call_control_id: call.id || `client-${Date.now()}`,
          direction,
          contact_phone: phone,
          from_number: direction === 'outbound' ? myNumber : phone,
          to_number: direction === 'outbound' ? phone : myNumber,
          duration_seconds: durationSecs,
          status: durationSecs > 0 ? 'completed' : (direction === 'inbound' ? 'missed' : 'failed'),
          started_at: startedAt,
          ended_at: endedAt
        }).catch(() => {});

        setCallState(prev => ({ ...prev, status: 'ended' }));
        setIsSpeaker(false);
        // Reset audio output to default when call ends
        try { const a = document.getElementById('telnyx-audio'); if (a?.setSinkId) a.setSinkId('default').catch(() => {}); } catch {}
        setTimeout(() => {
          setCallState({ status: 'idle', direction: null, contactPhone: null, contactName: null, callControlId: null, duration: 0, isMuted: false, isRecording: false });
          activeCallRef.current = null;
          loadCallLogs();
        }, 3000);
        break;
      }
    }
  }

  function startDurationTimer() {
    if (durationTimerRef.current) clearInterval(durationTimerRef.current);
    durationTimerRef.current = setInterval(() => {
      setCallState(prev => ({ ...prev, duration: prev.duration + 1 }));
    }, 1000);
  }

  function stopDurationTimer() {
    if (durationTimerRef.current) { clearInterval(durationTimerRef.current); durationTimerRef.current = null; }
  }

  function formatDuration(secs) {
    const m = Math.floor(secs / 60).toString().padStart(2, '0');
    const s = (secs % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function getContactName(phone) {
    return conversations.find(c => c.phone === phone)?.name || null;
  }

  function initiateCall(phone, name) {
    if (callState.status !== 'idle') { addToast('A call is already active'); return; }
    setConfirmCall({ phone, name: name || phone });
  }

  function confirmAndCall() {
    if (!confirmCall || !telnyxClientRef.current) return;
    const { phone } = confirmCall;
    setConfirmCall(null);
    callDirectionRef.current = 'outbound';
    callStartRef.current = Date.now();
    try {
      const call = telnyxClientRef.current.newCall({
        destinationNumber: phone,
        callerNumber: callerNumberRef.current
      });
      activeCallRef.current = call;
      setCallState({
        status: 'ringing', direction: 'outbound',
        contactPhone: phone, contactName: getContactName(phone),
        callControlId: null, duration: 0, isMuted: false, isRecording: false
      });
    } catch (err) {
      console.error('[VOICE] newCall failed:', err.message);
      addToast('Call failed. Please try again.');
    }
  }

  function answerCall() { activeCallRef.current?.answer(); }
  function hangupCall() { activeCallRef.current?.hangup(); }

  function toggleMute() {
    const call = activeCallRef.current;
    if (!call) return;
    if (callState.isMuted) { call.unmuteAudio(); } else { call.muteAudio(); }
    setCallState(prev => ({ ...prev, isMuted: !prev.isMuted }));
  }

  async function toggleRecording() {
    if (!callState.callControlId) return;
    const endpoint = callState.isRecording ? 'stop' : 'start';
    await fetch(`/api/voice/recording/${endpoint}`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ call_control_id: callState.callControlId })
    });
    setCallState(prev => ({ ...prev, isRecording: !prev.isRecording }));
  }

  async function toggleSpeaker() {
    const audio = document.getElementById('telnyx-audio');
    if (!audio || typeof audio.setSinkId !== 'function') {
      addToast('Speaker toggle not supported in this browser');
      return;
    }
    try {
      if (isSpeaker) {
        await audio.setSinkId('default');
        setIsSpeaker(false);
      } else {
        // Enumerate output devices to find a non-default speaker
        const devices = await navigator.mediaDevices.enumerateDevices();
        const outputs = devices.filter(d => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== '');
        const target = outputs.length > 0 ? outputs[0].deviceId : 'communications';
        await audio.setSinkId(target);
        setIsSpeaker(true);
      }
    } catch (err) {
      addToast('Speaker switch failed: ' + err.message);
    }
  }

  async function loadCallLogs(phone) {
    try {
      const url = phone ? `/api/voice/logs?phone=${encodeURIComponent(phone)}` : '/api/voice/logs';
      const data = await fetch(url, { credentials: 'include' }).then(r => r.json());
      setCallLogs(Array.isArray(data) ? data : []);
    } catch {}
  }

  // Called from ContactModal "Open Message Thread" button
  function goToMessages(phone) {
    selectContact(phone);
    setMainTab('messages');
    setMobileSub('thread');
  }

  async function handleSend() {
    if (!input.trim() || !activePhone || sending) return;
    const msg = input.trim();
    setInput('');
    setSending(true);
    try {
      await api('POST', '/api/send', { to: activePhone, message: msg });
    } catch (err) {
      addToast('Send failed: ' + err.message);
      setInput(msg);
    } finally { setSending(false); }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  }

  async function handleLogout() {
    await api('POST', '/auth/logout').catch(() => {});
    setAuth({ checking: false, ok: false });
  }

  async function runCatchup() {
    try {
      const preview = await api('GET', '/api/catchup/preview');
      if (preview.total_to_send === 0) {
        addToast('No catch-up messages to send — everyone is up to date');
        return;
      }
      const confirmed = window.confirm(
        `Send catch-up SMS to:\n• ${preview.processing.count} processing orders (order confirmed)\n• ${preview.shipped.count} shipped orders (tracking)\n\nTotal: ${preview.total_to_send} messages\n\nProceed?`
      );
      if (!confirmed) return;
      setCatchingUp(true);
      addToast(`Sending ${preview.total_to_send} catch-up messages…`);
      const result = await api('POST', '/api/catchup/send');
      addToast(`Done — ${result.sent} sent, ${result.failed} failed`);
      loadConversations();
    } catch (e) {
      addToast('Catch-up error: ' + e.message);
    } finally {
      setCatchingUp(false);
    }
  }

  async function syncWoo() {
    setSyncing(true);
    try {
      await api('POST', '/api/sync/woocommerce');
      addToast('WooCommerce sync started — may take 1-2 min');
      setTimeout(() => { loadConversations(); setSyncing(false); }, 5000);
    } catch (e) {
      addToast('WooCommerce sync: ' + e.message);
      setSyncing(false);
    }
  }

  async function syncStatuses() {
    setStatusSyncing(true);
    try {
      await api('POST', '/api/sync/statuses');
      addToast('Status sync started — contacts updating in real-time…');
      setTimeout(() => { loadConversations(); setStatusSyncing(false); }, 8000);
    } catch (e) {
      addToast('Status sync: ' + e.message);
      setStatusSyncing(false);
    }
  }

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
  const isMobile = useIsMobile();

  // ── Push notifications ─────────────────────────────────────────────────────
  const [pushState, setPushState] = useState('loading'); // loading | unsupported | denied | prompt | subscribed
  const [pushLoading, setPushLoading] = useState(false);

  useEffect(() => {
    if (!auth.ok) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushState('unsupported'); return;
    }
    if (Notification.permission === 'denied') { setPushState('denied'); return; }

    navigator.serviceWorker.register('/sw.js', { scope: '/' }).then(async reg => {
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        // Re-POST on every load to restore the row if it was pruned server-side.
        try {
          const saveResp = await fetch('/api/push/subscribe', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(existing.toJSON())
          });
          if (!saveResp.ok) throw new Error('subscribe POST failed: ' + saveResp.status);

          // Verify the endpoint is genuinely active in the DB.
          // If a prior 410 caused the server to delete it, the re-POST above would have
          // re-inserted it — but the endpoint itself may be permanently expired at APNs.
          // Ask the server to confirm, then force a fresh subscription if stale.
          const checkResp = await fetch('/api/push/check', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: existing.endpoint })
          });
          const checkData = checkResp.ok ? await checkResp.json() : { active: false };

          if (!checkData.active) {
            // The DB row doesn't exist even after re-POST — subscription endpoint is
            // permanently dead (APNs rejected it). Unsubscribe the browser and get fresh.
            await existing.unsubscribe();
            const { publicKey } = await api('GET', '/api/push/vapid-key');
            const fresh = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicKey)
            });
            await api('POST', '/api/push/subscribe', fresh.toJSON());
          }

          setPushState('subscribed');
        } catch (err) {
          console.error('Push init error:', err.message);
          setPushState('prompt');
        }
      } else if (Notification.permission === 'granted') {
        // Permission was granted before but browser subscription is gone — auto-resubscribe.
        try {
          const { publicKey } = await api('GET', '/api/push/vapid-key');
          const sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey)
          });
          await api('POST', '/api/push/subscribe', sub.toJSON());
          setPushState('subscribed');
        } catch {
          setPushState('prompt');
        }
      } else {
        setPushState('prompt');
      }
    }).catch(() => setPushState('unsupported'));
  }, [auth.ok]);

  async function togglePush() {
    if (pushLoading) return;
    if (pushState === 'subscribed') {
      // Unsubscribe
      setPushLoading(true);
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await fetch('/api/push/unsubscribe', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) });
          await sub.unsubscribe();
        }
        setPushState('prompt');
        addToast('Push notifications off');
      } catch (e) { addToast('Error: ' + e.message); }
      finally { setPushLoading(false); }
      return;
    }
    // Subscribe
    setPushLoading(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') { setPushState('denied'); addToast('Notification permission denied'); return; }
      const { publicKey } = await api('GET', '/api/push/vapid-key');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      await api('POST', '/api/push/subscribe', sub.toJSON());
      setPushState('subscribed');
      addToast('Push notifications enabled');
    } catch (e) { addToast('Push error: ' + e.message); }
    finally { setPushLoading(false); }
  }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  const pushIcon = pushLoading ? '…'
    : pushState === 'subscribed' ? '🔔'
    : pushState === 'denied' ? '🔕'
    : '🔔';
  const pushTitle = pushState === 'subscribed' ? 'Notifications ON — click to disable'
    : pushState === 'denied' ? 'Notifications blocked — allow in browser settings'
    : pushState === 'unsupported' ? 'Push notifications not supported'
    : 'Enable push notifications';

  if (auth.checking) {
    return (
      <div className="loading-screen">
        <span className="spinner" style={{ width: '28px', height: '28px' }} />
        <span>INITIALISING</span>
      </div>
    );
  }
  if (!auth.ok) return <LoginScreen onLogin={() => setAuth({ checking: false, ok: true })} />;

  return (
    <div className="app">
      <ToastContainer toasts={toasts} />

      {/* ── Header ── */}
      <div className="header">
        <div className="header-logo">VICI<small>// SMS</small></div>

        {/* Desktop tab navigation */}
        <div className="header-tabs">
          <button
            className={`header-tab${mainTab === 'contacts' ? ' active' : ''}`}
            onClick={() => setMainTab('contacts')}
          >
            CONTACTS
          </button>
          <button
            className={`header-tab${mainTab === 'messages' ? ' active' : ''}`}
            onClick={() => setMainTab('messages')}
          >
            MESSAGES {totalUnread > 0 && `(${totalUnread})`}
          </button>
          <button
            className={`header-tab${mainTab === 'activity' ? ' active' : ''}`}
            onClick={() => setMainTab('activity')}
          >
            ACTIVITY
          </button>
          <button
            className={`header-tab${mainTab === 'voice' ? ' active' : ''}`}
            onClick={() => { setMainTab('voice'); if (!voiceReady) initVoiceClient(); }}
          >
            VOICE
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: voiceReady ? '#16a34a' : '#9ca3af',
              display: 'inline-block', marginLeft: 5, verticalAlign: 'middle'
            }} />
          </button>
        </div>

        <div className="header-spacer" />

        <div className="conn-pill">
          <div className={`conn-dot ${sseStatus}`} />
          <span>{sseStatus}</span>
        </div>

        <div className="header-actions">
          <button
            className={`hdr-btn hdr-btn-push${pushState === 'subscribed' ? ' active' : ''}`}
            onClick={togglePush}
            disabled={pushLoading || pushState === 'unsupported' || pushState === 'denied'}
            title={pushTitle}
            style={{ opacity: pushState === 'unsupported' || pushState === 'denied' ? 0.45 : 1 }}
          >
            {pushIcon}
          </button>
          {pushState === 'subscribed' && (
            <button
              className="hdr-btn"
              title="Send a test push notification to this device"
              onClick={async () => {
                try {
                  await api('POST', '/api/push/test', {});
                  addToast('Test push sent — should arrive in 1-2s');
                } catch (e) {
                  addToast('Test push failed: ' + e.message);
                }
              }}
            >
              ✉︎ TEST
            </button>
          )}
          <button className="hdr-btn" disabled={statusSyncing} onClick={syncStatuses} title="Update all order statuses from WooCommerce — no messages sent">
            {statusSyncing ? '…' : '↻ STATUS'}
          </button>
          <button className="hdr-btn" disabled={syncing} onClick={syncWoo} title="Sync WooCommerce orders + contacts">
            {syncing ? '…' : '↻ WOO'}
          </button>
          <button className="hdr-btn hdr-btn-catchup" disabled={catchingUp} onClick={runCatchup} title="Send catch-up SMS to processing/shipped orders that never got automated messages">
            {catchingUp ? '…' : '✉ CATCHUP'}
          </button>
          <button className="hdr-btn" onClick={handleLogout}>EXIT</button>
        </div>
      </div>

      {/* ── Main content ── */}
      <div className="main-content">
        {mainTab === 'contacts' && (
          <ContactsView
            contacts={conversations}
            onGoToMessages={goToMessages}
            addToast={addToast}
          />
        )}
        {mainTab === 'messages' && (
          <MessagesView
            conversations={conversations}
            activePhone={activePhone}
            messages={messages}
            onSelectContact={selectContact}
            input={input}
            setInput={setInput}
            onSend={handleSend}
            onKeyDown={handleKeyDown}
            sending={sending}
            inputRef={inputRef}
            messagesEndRef={messagesEndRef}
            mobileSub={mobileSub}
            setMobileSub={setMobileSub}
            callState={callState}
            voiceReady={voiceReady}
            onInitiateCall={initiateCall}
          />
        )}
        {mainTab === 'activity' && (
          <ActivityTab sseStatus={sseStatus} />
        )}
        {mainTab === 'voice' && (
          <VoiceTab
            callLogs={callLogs}
            dialNumber={dialNumber}
            setDialNumber={setDialNumber}
            onCall={initiateCall}
            voiceReady={voiceReady}
            onRetryConnect={retryVoiceConnect}
          />
        )}
      </div>

      <CallConfirmModal
        target={confirmCall}
        onConfirm={confirmAndCall}
        onCancel={() => setConfirmCall(null)}
      />

      <ActiveCallPanel
        callState={callState}
        onAnswer={answerCall}
        onHangup={hangupCall}
        onMute={toggleMute}
        onRecord={toggleRecording}
        onSpeaker={toggleSpeaker}
        isSpeaker={isSpeaker}
        formatDuration={formatDuration}
      />

      {/* ── Mobile bottom nav ── */}
      {isMobile && (
        <nav className="bottom-nav">
          <div className="bottom-nav-inner">
            <button
              className={`bnav-btn${mainTab === 'contacts' ? ' active' : ''}`}
              onClick={() => setMainTab('contacts')}
            >
              <span className="bnav-icon">◎</span>
              Contacts
            </button>
            <button
              className={`bnav-btn${mainTab === 'messages' ? ' active' : ''}`}
              onClick={() => { setMainTab('messages'); if (activePhone) setMobileSub('list'); }}
            >
              <span className="bnav-icon">✉</span>
              Messages
              {totalUnread > 0 && <span className="bnav-badge">{totalUnread}</span>}
            </button>
            <button
              className={`bnav-btn${mainTab === 'activity' ? ' active' : ''}`}
              onClick={() => setMainTab('activity')}
            >
              <span className="bnav-icon">⚡</span>
              Activity
            </button>
            <button
              className={`bnav-btn${mainTab === 'voice' ? ' active' : ''}`}
              onClick={() => { setMainTab('voice'); if (!voiceReady) initVoiceClient(); }}
            >
              <span className="bnav-icon">📞</span>
              Voice
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: voiceReady ? '#16a34a' : '#9ca3af', display: 'inline-block', marginLeft: 4 }} />
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
