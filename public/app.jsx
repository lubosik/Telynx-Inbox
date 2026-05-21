const { useState, useEffect, useRef, useCallback } = React;

const TZ = 'America/New_York';
const IS_MOBILE = () => window.innerWidth <= 768;

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric' });
}

function getInitials(c) {
  if (c.name) {
    const parts = c.name.split(' ').filter(Boolean);
    return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : c.name.slice(0, 2).toUpperCase();
  }
  return c.phone ? c.phone.slice(-4) : '??';
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

function getLatestOrderStatus(contact) {
  // contact may have an order status from conversations list enrichment
  return contact.latest_order_status || 'none';
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
    } catch {
      setError('Incorrect password');
    } finally { setLoading(false); }
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">VICI<span style={{fontSize:'0.625rem',letterSpacing:'0.08em',color:'var(--text3)',marginLeft:'0.5rem'}}>// SMS</span></div>
        <div className="login-subtitle">Inbox Access Required</div>
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
            {loading ? <span className="spinner" style={{borderTopColor:'#030712'}} /> : 'AUTHENTICATE'}
          </button>
          <div className="error-msg">{error}</div>
        </form>
      </div>
    </div>
  );
}

// ─── Contact Row ─────────────────────────────────────────────────────────────

function ContactRow({ c, active, onClick }) {
  const preview = c.lastMessage
    ? (c.lastMessage.direction === 'outbound' ? '↗ ' : '') + truncate(c.lastMessage.body, 42)
    : 'No messages yet';

  const orderStatus = getLatestOrderStatus(c);

  return (
    <div className={`conv-item${active ? ' active' : ''}`} onClick={onClick}>
      <div className="conv-avatar">
        {getInitials(c)}
        <span className={`order-status-dot ${orderStatus}`} title={orderStatus !== 'none' ? `Latest order: ${orderStatus}` : ''} />
      </div>
      <div className="conv-body">
        <div className="conv-name-row">
          <div className="conv-name">{c.name || 'Unknown'}</div>
          <div className="conv-phone">{c.phone?.replace('+1', '')}</div>
        </div>
        <div className="conv-preview">{preview}</div>
      </div>
      <div className="conv-side">
        <span className="conv-time">{relativeTime(c.last_seen)}</span>
        {c.unread_count > 0 && <span className="unread-badge">{c.unread_count}</span>}
      </div>
    </div>
  );
}

// ─── Order Card ───────────────────────────────────────────────────────────────

function OrderCard({ order }) {
  const smsStates = [
    { sent: order.order_sms_sent, label: 'Order SMS' },
    { sent: order.shipped_sms_sent, label: 'Shipped SMS' },
    { sent: order.delivery_sms_sent, label: 'Delivery SMS' }
  ];

  return (
    <div className="order-card">
      <div className="order-header">
        <span className="order-num">#{order.woo_order_id || '—'}</span>
        <span className={`order-badge ${order.status}`}>{order.status}</span>
        <span className="order-total">${parseFloat(order.total || 0).toFixed(2)}</span>
      </div>

      <div className="order-items">
        {(order.items || []).slice(0, 3).map((item, i) => (
          <div key={i} className="order-item">
            <span className="order-item-qty">×{item.quantity}</span>
            {item.name}
          </div>
        ))}
        {(order.items || []).length > 3 && (
          <div className="order-item" style={{color:'var(--text3)'}}>+{order.items.length - 3} more items</div>
        )}
      </div>

      <div className="order-footer">
        <span className="order-date">{formatDate(order.created_at)}</span>
        {order.tracking_number && (
          <span className="tracking-info">
            📦 {order.carrier?.toUpperCase()} · {order.tracking_number}
          </span>
        )}
        <div className="sms-sent-indicators" title={smsStates.map(s => `${s.label}: ${s.sent ? 'sent' : 'pending'}`).join('\n')}>
          {smsStates.map((s, i) => (
            <div key={i} className={`sms-dot ${s.sent ? 'sent' : 'pending'}`} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Suggestion Card ──────────────────────────────────────────────────────────

function SuggestionCard({ s, onSend, onDismiss }) {
  const [sending, setSending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="suggestion-card">
      <div className="sug-type-badge">{s.suggestion_type?.replace(/_/g, ' ')}</div>
      <div className="sug-reason">{s.suggestion_text}</div>
      <div className="sug-msg">{s.suggested_message}</div>
      <div className="sug-actions">
        <button className="btn-send-now" disabled={sending} onClick={async () => {
          setSending(true);
          await onSend(s.id);
          setSending(false);
          setDismissed(true);
        }}>
          {sending ? <span className="spinner" style={{borderTopColor:'#030712'}} /> : 'Send'}
        </button>
        <button className="btn-dismiss" onClick={() => { onDismiss(s.id); setDismissed(true); }}>Dismiss</button>
      </div>
    </div>
  );
}

// ─── Profile Panel ────────────────────────────────────────────────────────────

function ProfilePanel({ phone, open, onClose, addToast }) {
  const [tab, setTab] = useState('orders');
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analysing, setAnalysing] = useState(false);

  useEffect(() => {
    if (!phone || !open) return;
    setProfile(null);
    setLoading(true);
    api('GET', `/api/contacts/${encodeURIComponent(phone)}`)
      .then(setProfile)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [phone, open]);

  async function reanalyse() {
    setAnalysing(true);
    try {
      await api('POST', `/api/intelligence/analyse/${encodeURIComponent(phone)}`);
      const d = await api('GET', `/api/contacts/${encodeURIComponent(phone)}`);
      setProfile(d);
      addToast('Analysis complete');
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

  const isMobile = IS_MOBILE();
  const panelClass = isMobile
    ? `profile-panel${open ? ' open' : ' closed'}`
    : `profile-panel${open ? '' : ' closed'}`;

  const intel = profile?.intelligence;
  const suggestions = profile?.suggestions || [];

  return (
    <div className={panelClass}>
      <div className="profile-top">
        <div className="profile-close">
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {loading && (
          <div style={{textAlign:'center', padding:'1rem'}}>
            <span className="spinner" />
          </div>
        )}

        {!loading && profile && (
          <div className="profile-avatar-wrap">
            <div className="profile-avatar">{getInitials(profile)}</div>
            <div className="profile-info">
              <div className="profile-name">{profile.name || 'Unknown'}</div>
              <div className="profile-phone">{profile.phone}</div>
              {profile.email && <div className="profile-email">{profile.email}</div>}
              {(profile.city || profile.state) && (
                <div className="profile-location">
                  {[profile.city, profile.state, profile.country].filter(Boolean).join(', ')}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {profile && (
        <div className="profile-stats">
          <div className="stat-card">
            <div className="stat-value">{profile.total_orders}</div>
            <div className="stat-label">Orders</div>
          </div>
          <div className="stat-card">
            <div className="stat-value">${profile.total_spent?.toFixed(0)}</div>
            <div className="stat-label">Spent</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{fontSize:'0.6875rem'}}>
              {profile.orders?.[0] ? relativeTime(profile.orders[0].created_at) : '—'}
            </div>
            <div className="stat-label">Last Order</div>
          </div>
        </div>
      )}

      <div className="profile-tabs">
        <button className={`profile-tab${tab === 'orders' ? ' active' : ''}`} onClick={() => setTab('orders')}>Orders</button>
        <button className={`profile-tab${tab === 'intel' ? ' active' : ''}`} onClick={() => setTab('intel')}>Intel</button>
      </div>

      <div className="profile-body">
        {tab === 'orders' && (
          <>
            {!profile && !loading && (
              <div className="orders-empty">No profile data</div>
            )}
            {profile && profile.orders.length === 0 && (
              <div className="orders-empty">No orders on record.<br />Run WooCommerce sync to backfill.</div>
            )}
            {(profile?.orders || []).map(order => (
              <OrderCard key={order.id} order={order} />
            ))}
          </>
        )}

        {tab === 'intel' && (
          <>
            <div className="reanalyse-row">
              <button className="reanalyse-btn" onClick={reanalyse} disabled={analysing}>
                {analysing ? <span className="spinner" /> : '↺ Re-analyse'}
              </button>
              {intel?.last_analysed && (
                <span className="last-analysed">Last: {relativeTime(intel.last_analysed)}</span>
              )}
            </div>

            {!intel ? (
              <div className="intel-section">
                <div className="intel-summary" style={{color:'var(--text3)'}}>
                  No analysis yet. Send a message or click re-analyse.
                </div>
              </div>
            ) : (
              <>
                {intel.raw_summary && (
                  <div className="intel-section">
                    <div className="intel-section-label">Summary</div>
                    <div className="intel-summary">{intel.raw_summary}</div>
                  </div>
                )}
                {intel.sentiment && (
                  <div className="intel-section">
                    <div className="intel-section-label">Sentiment</div>
                    <span className={`sentiment-badge ${intel.sentiment}`}>{intel.sentiment}</span>
                  </div>
                )}
                {intel.inferred_interests?.length > 0 && (
                  <div className="intel-section">
                    <div className="intel-section-label">Interests</div>
                    {intel.inferred_interests.map((i, idx) => (
                      <span key={idx} className="tag-chip green">{i}</span>
                    ))}
                  </div>
                )}
                {intel.order_signals?.length > 0 && (
                  <div className="intel-section">
                    <div className="intel-section-label">Purchase Signals</div>
                    <ul className="signal-list">
                      {intel.order_signals.map((s, idx) => <li key={idx}>{s}</li>)}
                    </ul>
                  </div>
                )}
                {intel.restock_interests?.length > 0 && (
                  <div className="intel-section">
                    <div className="intel-section-label">Restock Watch</div>
                    {intel.restock_interests.map((i, idx) => (
                      <span key={idx} className="tag-chip orange">{i}</span>
                    ))}
                  </div>
                )}
              </>
            )}

            {suggestions.length > 0 && (
              <div className="intel-section">
                <div className="intel-section-label">Campaign Suggestions</div>
                {suggestions.map(s => (
                  <SuggestionCard key={s.id} s={s} onSend={sendSuggestion} onDismiss={dismissSuggestion} />
                ))}
              </div>
            )}
          </>
        )}
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
  const [profileOpen, setProfileOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // all | unread | orders
  const [syncing, setSyncing] = useState(false);
  const [mobileView, setMobileView] = useState('contacts'); // contacts | thread | profile

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
            return {
              ...m,
              [phone]: m[phone].map(msg =>
                msg.telnyx_message_id === messageId ? { ...msg, status } : msg
              )
            };
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
                [phone]: [...(m[phone] || []), {
                  id: Date.now(),
                  contact_phone: phone,
                  direction,
                  body,
                  created_at: new Date().toISOString(),
                  status: 'delivered'
                }]
              }));
            }
            return ap;
          });

          if (direction === 'inbound' && document.hidden) {
            fireNotification(phone, body);
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

  function fireNotification(phone, body) {
    if ('Notification' in window && Notification.permission === 'granted') {
      const contact = conversations.find(c => c.phone === phone);
      const title = `${contact?.name || phone}`;
      const n = new Notification(title, { body, icon: '/icons/icon-192.png' });
      n.onclick = () => { window.focus(); selectContact(phone); };
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
    setMobileView('thread');
    setProfileOpen(false);
    setConversations(prev => prev.map(c => c.phone === phone ? { ...c, unread_count: 0 } : c));
    setTimeout(() => inputRef.current?.focus(), 150);
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

  async function syncWooCommerce() {
    setSyncing(true);
    try {
      await api('POST', '/api/sync/woocommerce');
      addToast('WooCommerce sync started — may take a minute');
      setTimeout(() => { loadConversations(); setSyncing(false); }, 4000);
    } catch (e) {
      addToast('Sync error: ' + e.message);
      setSyncing(false);
    }
  }

  async function syncGHL() {
    setSyncing(true);
    try {
      await api('POST', '/api/sync/seed-from-bridge');
      await api('POST', '/api/sync/ghl');
      addToast('GHL sync started');
      setTimeout(() => { loadConversations(); setSyncing(false); }, 3000);
    } catch (e) {
      addToast('GHL sync: ' + e.message);
      setSyncing(false);
    }
  }

  const cc = charCount(input);
  const activeContact = conversations.find(c => c.phone === activePhone);
  const activeMessages = activePhone ? (messages[activePhone] || []) : [];

  const filtered = conversations.filter(c => {
    if (search) {
      const q = search.toLowerCase();
      if (!c.phone.includes(q) && !(c.name || '').toLowerCase().includes(q)) return false;
    }
    if (filter === 'unread') return (c.unread_count || 0) > 0;
    if (filter === 'orders') return c.latest_order_status && c.latest_order_status !== 'none';
    return true;
  });

  if (auth.checking) {
    return (
      <div className="loading-screen">
        <span className="spinner" style={{width:'24px',height:'24px'}} />
        <span>INITIALISING</span>
      </div>
    );
  }

  if (!auth.ok) {
    return <LoginScreen onLogin={() => setAuth({ checking: false, ok: true })} />;
  }

  const isMobile = IS_MOBILE();

  return (
    <div className="app">
      <ToastContainer toasts={toasts} />

      {/* Header */}
      <div className="header">
        <div className="header-logo">
          VICI <span>// INBOX</span>
        </div>
        <div className="conn-indicator">
          <div className={`conn-dot ${sseStatus}`} />
          <span>{sseStatus}</span>
        </div>
        <div className="header-actions">
          <button className="hdr-btn" disabled={syncing} onClick={syncWooCommerce} title="Sync WooCommerce orders">
            {syncing ? '…' : '↻ WOO'}
          </button>
          <button className="hdr-btn" disabled={syncing} onClick={syncGHL} title="Sync GHL history">
            {syncing ? '…' : '↻ GHL'}
          </button>
          <button className="hdr-btn" onClick={handleLogout}>EXIT</button>
        </div>
      </div>

      {/* Main layout */}
      <div className="layout">

        {/* Sidebar */}
        <div className={`sidebar${isMobile && mobileView !== 'contacts' ? ' hidden' : ''}`}>
          <div className="sidebar-top">
            <div className="search-wrap">
              <span className="search-icon">⌕</span>
              <input
                className="search-input"
                placeholder="Search contacts…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <div className="filter-tabs">
              {[
                { key: 'all', label: 'ALL' },
                { key: 'unread', label: 'UNREAD' },
                { key: 'orders', label: 'ORDERS' }
              ].map(f => (
                <button
                  key={f.key}
                  className={`filter-tab${filter === f.key ? ' active' : ''}`}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          <div className="conv-list">
            {filtered.length === 0 && (
              <div className="conv-empty">{search ? '// NO MATCHES' : '// NO CONTACTS'}</div>
            )}
            {filtered.map(c => (
              <ContactRow
                key={c.phone}
                c={c}
                active={c.phone === activePhone}
                onClick={() => selectContact(c.phone)}
              />
            ))}
          </div>
        </div>

        {/* Thread panel */}
        <div className={`thread-panel${isMobile && mobileView !== 'thread' ? ' hidden' : ''}`}>
          {!activePhone ? (
            <div className="no-thread">
              <div className="no-thread-icon">⌨</div>
              <p>Select a contact to view messages</p>
            </div>
          ) : (
            <>
              <div className="thread-header">
                <button className="back-btn" onClick={() => { setMobileView('contacts'); setProfileOpen(false); }}>←</button>
                <div className="thread-info">
                  <div className="thread-name">{activeContact?.name || activePhone}</div>
                  {activeContact?.name && <div className="thread-phone">{activePhone}</div>}
                </div>
                <div className="thread-actions">
                  <button
                    className={`profile-btn${profileOpen ? ' active' : ''}`}
                    onClick={() => {
                      if (isMobile) setMobileView('profile');
                      setProfileOpen(o => !o);
                    }}
                  >
                    Profile
                  </button>
                </div>
              </div>

              <div className="messages-area">
                {activeMessages.length === 0 ? (
                  <div style={{flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'var(--text3)', fontFamily:'var(--mono)', fontSize:'0.8125rem'}}>
                    // no messages
                  </div>
                ) : (
                  activeMessages.map((m, idx) => {
                    const prevMsg = activeMessages[idx - 1];
                    const showDate = !prevMsg ||
                      new Date(m.created_at).toDateString() !== new Date(prevMsg.created_at).toDateString();
                    return (
                      <React.Fragment key={m.id || idx}>
                        {showDate && (
                          <div className="date-divider">
                            {new Date(m.created_at).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'long', month: 'short', day: 'numeric' })}
                          </div>
                        )}
                        <div className="msg-group">
                          <div className={`msg-bubble ${m.direction}`}>{m.body}</div>
                          <div className={`msg-meta ${m.direction}`}>
                            {formatTime(m.created_at)}
                            {m.direction === 'outbound' && m.status && (
                              <span style={{
                                marginLeft: '0.375rem',
                                color: m.status === 'delivered' ? 'var(--accent)'
                                     : m.status === 'failed' ? 'var(--red)'
                                     : 'var(--text3)'
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
                    onKeyDown={handleKeyDown}
                    rows={1}
                  />
                  <button className="send-btn" onClick={handleSend} disabled={!input.trim() || sending}>
                    {sending ? <span className="spinner" style={{width:'14px',height:'14px',borderTopColor:'#030712'}} /> : '↑'}
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

        {/* Profile panel */}
        <ProfilePanel
          phone={activePhone}
          open={profileOpen}
          onClose={() => {
            setProfileOpen(false);
            if (isMobile) setMobileView('thread');
          }}
          addToast={addToast}
        />
      </div>

      {/* Mobile bottom nav */}
      {isMobile && (
        <nav className="bottom-nav">
          <div className="bottom-nav-inner">
            <button
              className={`bnav-btn${mobileView === 'contacts' ? ' active' : ''}`}
              onClick={() => setMobileView('contacts')}
            >
              <span className="bnav-icon">☰</span>
              Contacts
            </button>
            <button
              className={`bnav-btn${mobileView === 'thread' ? ' active' : ''}`}
              onClick={() => activePhone && setMobileView('thread')}
              disabled={!activePhone}
            >
              <span className="bnav-icon">✉</span>
              Messages
            </button>
            <button
              className={`bnav-btn${mobileView === 'profile' ? ' active' : ''}`}
              onClick={() => { if (activePhone) { setProfileOpen(true); setMobileView('profile'); } }}
              disabled={!activePhone}
            >
              <span className="bnav-icon">◎</span>
              Profile
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
