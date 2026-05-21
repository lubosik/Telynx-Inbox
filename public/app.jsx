const { useState, useEffect, useRef, useCallback } = React;

const TZ = 'America/New_York';

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

// ─── Contacts View ────────────────────────────────────────────────────────────

function ContactsView({ contacts, onGoToMessages, addToast }) {
  const [search, setSearch] = useState('');
  const [modalPhone, setModalPhone] = useState(null);

  const filtered = contacts.filter(c => {
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
          <span className={`card-order-badge ${latestStatus}`}>{latestStatus}</span>
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
  mobileSub, setMobileSub
}) {
  const [search, setSearch] = useState('');
  const isMobile = window.innerWidth <= 768;

  const filtered = conversations.filter(c => {
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
          {filtered.map(c => (
            <ConvRow
              key={c.phone}
              contact={c}
              active={c.phone === activePhone}
              onClick={() => {
                onSelectContact(c.phone);
                if (isMobile) setMobileSub('thread');
              }}
            />
          ))}
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

function ConvRow({ contact: c, active, onClick }) {
  const preview = c.lastMessage
    ? (c.lastMessage.direction === 'outbound' ? '↗ ' : '') + truncate(c.lastMessage.body, 40)
    : 'No messages';
  const orderStatus = c.latest_order_status || 'none';
  return (
    <div className={`conv-row${active ? ' active' : ''}`} onClick={onClick}>
      <div className="conv-avatar">
        {getInitials(c)}
        <span className={`order-dot ${orderStatus}`} />
      </div>
      <div className="conv-body">
        <div className="conv-name">{c.name || c.phone}</div>
        <div className="conv-preview">{preview}</div>
      </div>
      <div className="conv-side">
        <span className="conv-time">{relativeTime(c.last_seen)}</span>
        {c.unread_count > 0 && <span className="unread-pill">{c.unread_count}</span>}
      </div>
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
  const [mainTab, setMainTab] = useState('contacts'); // 'contacts' | 'messages'
  const [mobileSub, setMobileSub] = useState('list'); // 'list' | 'thread'

  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const sseRef = useRef(null);
  const reconnectTimer = useRef(null);
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
    pollTimer.current = setInterval(loadConversations, 30000);
    return () => {
      clearInterval(pollTimer.current);
      if (sseRef.current) sseRef.current.close();
      clearTimeout(reconnectTimer.current);
    };
  }, [auth.ok]);

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
                unread_count: direction === 'inbound' ? (updated[idx].unread_count || 0) + 1 : updated[idx].unread_count
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
          if (direction === 'inbound' && document.hidden) {
            const contact = conversations.find(c => c.phone === phone);
            fireNotification(contact?.name || phone, body);
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

  function fireNotification(title, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/icons/icon-192.png' });
    }
  }

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activePhone]);

  useEffect(() => {
    if (activePhone) loadThread(activePhone);
  }, [activePhone]);

  function selectContact(phone) {
    setActivePhone(phone);
    setConversations(prev => prev.map(c => c.phone === phone ? { ...c, unread_count: 0 } : c));
    setTimeout(() => inputRef.current?.focus(), 150);
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

  const totalUnread = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
  const isMobile = window.innerWidth <= 768;

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
        </div>

        <div className="header-spacer" />

        <div className="conn-pill">
          <div className={`conn-dot ${sseStatus}`} />
          <span>{sseStatus}</span>
        </div>

        <div className="header-actions">
          <button className="hdr-btn" disabled={syncing} onClick={syncWoo} title="Sync WooCommerce orders + contacts">
            {syncing ? '…' : '↻ WOO'}
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
          />
        )}
      </div>

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
          </div>
        </nav>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
