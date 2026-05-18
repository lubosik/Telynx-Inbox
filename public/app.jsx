const { useState, useEffect, useRef, useCallback } = React;

// --- Helpers ---
const TZ = 'America/New_York';

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
  const msgStr  = d.toLocaleDateString('en-US', { timeZone: TZ });
  if (todayStr === msgStr) return time;
  return `${time} · ${d.toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' })}`;
}

function getAvatar(c) {
  if (c.name) {
    const parts = c.name.split(' ').filter(Boolean);
    return parts.length >= 2 ? (parts[0][0] + parts[1][0]).toUpperCase() : c.name.slice(0, 2).toUpperCase();
  }
  return c.phone ? c.phone.slice(-4) : '??';
}

function charCount(text) {
  const chars = text.length;
  const segments = chars === 0 ? 1 : Math.ceil(chars / 160);
  return {
    chars,
    segments,
    isWarning: chars >= 140 && chars <= 160,
    isDanger: chars > 160
  };
}

function truncate(str, n) {
  if (!str) return '';
  return str.length > n ? str.slice(0, n) + '…' : str;
}

// --- API ---
async function api(method, path, body) {
  const opts = { method, credentials: 'include', headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const r = await fetch(path, opts);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.statusText); }
  return r.json();
}

// --- Toast ---
function ToastContainer({ toasts }) {
  return (
    <div className="toast-container">
      {toasts.map(t => <div key={t.id} className="toast">{t.msg}</div>)}
    </div>
  );
}

// --- Login Screen ---
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
        <div className="login-logo">VICI</div>
        <div className="login-subtitle">SMS Inbox</div>
        <form onSubmit={handleSubmit}>
          <div className="input-wrap">
            <input
              type={show ? 'text' : 'password'}
              placeholder="Password"
              value={pw}
              onChange={e => setPw(e.target.value)}
              autoFocus
            />
            <button type="button" className="eye-btn" onClick={() => setShow(s => !s)}>
              {show ? '🙈' : '👁'}
            </button>
          </div>
          <button className="btn-primary" type="submit" disabled={loading || !pw}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
          <div className="error-msg">{error}</div>
        </form>
      </div>
    </div>
  );
}

// --- Conversation Item ---
function ConvItem({ c, active, onClick }) {
  const preview = c.lastMessage
    ? (c.lastMessage.direction === 'outbound' ? '↗ ' : '') + truncate(c.lastMessage.body, 38)
    : 'No messages';
  return (
    <div className={`conv-item${active ? ' active' : ''}`} onClick={onClick}>
      <div className="conv-avatar">{getAvatar(c)}</div>
      <div className="conv-info">
        <div className="conv-name">{c.name || c.phone}</div>
        <div className="conv-preview">{preview}</div>
      </div>
      <div className="conv-meta">
        <span className="conv-time">{relativeTime(c.last_seen)}</span>
        {c.unread_count > 0 && <span className="unread-dot" />}
      </div>
    </div>
  );
}

// --- Suggestion Card ---
function SuggestionCard({ s, onSend, onDismiss }) {
  const [sending, setSending] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div className="suggestion-card">
      <span className={`suggestion-type-badge ${s.suggestion_type}`}>{s.suggestion_type?.replace(/_/g, ' ')}</span>
      <div className="suggestion-reason">{s.suggestion_text}</div>
      <div className="suggestion-msg">{s.suggested_message}</div>
      <div className="suggestion-actions">
        <button className="btn-send-now" disabled={sending} onClick={async () => {
          setSending(true);
          await onSend(s.id);
          setSending(false);
          setDismissed(true);
        }}>
          {sending ? <span className="spinner" /> : 'Send Now'}
        </button>
        <button className="btn-dismiss" onClick={() => { onDismiss(s.id); setDismissed(true); }}>Dismiss</button>
      </div>
    </div>
  );
}

// --- Intelligence Panel ---
function IntelligencePanel({ phone, open, onClose, addToast }) {
  const [tab, setTab] = useState('profile');
  const [data, setData] = useState(null);
  const [overview, setOverview] = useState(null);
  const [analysing, setAnalysing] = useState(false);

  useEffect(() => {
    if (!phone || !open) return;
    setData(null);
    api('GET', `/api/intelligence/${encodeURIComponent(phone)}`).then(setData).catch(() => {});
  }, [phone, open]);

  async function loadOverview() {
    const o = await api('GET', '/api/intelligence/campaigns/overview').catch(() => null);
    setOverview(o);
  }

  useEffect(() => {
    if (tab === 'campaigns') loadOverview();
  }, [tab]);

  async function reanalyse() {
    setAnalysing(true);
    try {
      await api('POST', `/api/intelligence/analyse/${encodeURIComponent(phone)}`);
      const d = await api('GET', `/api/intelligence/${encodeURIComponent(phone)}`);
      setData(d);
      addToast('Analysis complete');
    } catch { addToast('Analysis failed'); }
    setAnalysing(false);
  }

  async function sendSuggestion(id) {
    await api('POST', `/api/intelligence/campaigns/${id}/send`);
    addToast('Message sent');
    const d = await api('GET', `/api/intelligence/${encodeURIComponent(phone)}`);
    setData(d);
  }

  async function dismissSuggestion(id) {
    await api('POST', `/api/intelligence/campaigns/${id}/dismiss`);
  }

  const p = data?.profile;
  const suggestions = data?.suggestions || [];

  return (
    <div className={`intelligence-panel${open ? ' open' : ''}`}>
      <div className="intel-header-bar">
        <div className="intel-title">{phone}</div>
        <button className="intel-close" onClick={onClose}>✕</button>
      </div>
      <div className="intel-tabs">
        <button className={`intel-tab${tab === 'profile' ? ' active' : ''}`} onClick={() => setTab('profile')}>Profile</button>
        <button className={`intel-tab${tab === 'campaigns' ? ' active' : ''}`} onClick={() => setTab('campaigns')}>Campaigns</button>
      </div>
      <div className="intel-body">
        {tab === 'profile' && (
          <>
            <div className="intel-actions">
              <button className="reanalyse-btn" onClick={reanalyse} disabled={analysing}>
                {analysing ? <span className="spinner" /> : '↺ Re-analyse'}
              </button>
              {p?.last_analysed && (
                <span className="last-analysed">Last: {relativeTime(p.last_analysed)}</span>
              )}
            </div>
            {!p ? (
              <div className="intel-section"><div className="intel-summary" style={{color:'var(--text3)'}}>No profile yet. Send a message first, then re-analyse.</div></div>
            ) : (
              <>
                {p.raw_summary && (
                  <div className="intel-section">
                    <h3>Summary</h3>
                    <div className="intel-summary">{p.raw_summary}</div>
                  </div>
                )}
                {p.inferred_interests?.length > 0 && (
                  <div className="intel-section">
                    <h3>Interests</h3>
                    {p.inferred_interests.map((i, idx) => (
                      <span key={idx} className="tag-chip green">{i}</span>
                    ))}
                  </div>
                )}
                {p.order_signals?.length > 0 && (
                  <div className="intel-section">
                    <h3>Order Signals</h3>
                    <ul className="signal-list">
                      {p.order_signals.map((s, idx) => <li key={idx}>{s}</li>)}
                    </ul>
                  </div>
                )}
                {p.restock_interests?.length > 0 && (
                  <div className="intel-section">
                    <h3>Restock Watch</h3>
                    {p.restock_interests.map((i, idx) => (
                      <span key={idx} className="tag-chip orange">{i}</span>
                    ))}
                  </div>
                )}
                {p.sentiment && (
                  <div className="intel-section">
                    <h3>Sentiment</h3>
                    <span className={`sentiment-badge ${p.sentiment}`}>{p.sentiment}</span>
                  </div>
                )}
              </>
            )}
            {suggestions.length > 0 && (
              <div className="intel-section">
                <h3>Campaign Suggestions</h3>
                {suggestions.map(s => (
                  <SuggestionCard key={s.id} s={s} onSend={sendSuggestion} onDismiss={dismissSuggestion} />
                ))}
              </div>
            )}
          </>
        )}
        {tab === 'campaigns' && (
          <div className="intel-section">
            {!overview ? (
              <div style={{color:'var(--text3)',textAlign:'center',padding:'2rem'}}><span className="spinner" /></div>
            ) : (
              <>
                <div className="overview-stat">
                  <span className="overview-stat-label">Contacts with signals</span>
                  <span className="overview-stat-val">{overview.total_contacts}</span>
                </div>
                <div className="overview-stat">
                  <span className="overview-stat-label">Total suggestions</span>
                  <span className="overview-stat-val">{overview.total_suggestions}</span>
                </div>
                {Object.entries(overview.by_type || {}).map(([type, data]) => (
                  <div key={type} className="by-type-item">
                    <span className="by-type-name">{type.replace(/_/g, ' ')}</span>
                    <span className="by-type-count">{data.count}</span>
                  </div>
                ))}
                {overview.overall_insight && (
                  <div style={{marginTop:'1rem'}}>
                    <h3 style={{fontSize:'0.75rem',color:'var(--text3)',textTransform:'uppercase',letterSpacing:'0.08em',marginBottom:'0.625rem'}}>AI Insight</h3>
                    <div className="overview-insight">{overview.overall_insight}</div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Main App ---
function App() {
  const [auth, setAuth] = useState({ checking: true, ok: false });
  const [conversations, setConversations] = useState([]);
  const [activePhone, setActivePhone] = useState(null);
  const [messages, setMessages] = useState({});
  const [input, setInput] = useState('');
  const [sseStatus, setSseStatus] = useState('connecting');
  const [isMobileThread, setIsMobileThread] = useState(false);
  const [intelOpen, setIntelOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const sseRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectDelay = useRef(1000);
  const pollTimer = useRef(null);

  function addToast(msg) {
    const id = Date.now();
    setToasts(t => [...t, { id, msg }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
  }

  // Check auth on mount
  useEffect(() => {
    api('GET', '/auth/check').then(d => setAuth({ checking: false, ok: d.authenticated }))
      .catch(() => setAuth({ checking: false, ok: false }));
  }, []);

  // Load conversations
  const loadConversations = useCallback(async () => {
    try {
      const data = await api('GET', '/api/conversations');
      setConversations(data);
    } catch {}
  }, []);

  // Load thread
  const loadThread = useCallback(async (phone) => {
    try {
      const data = await api('GET', `/api/conversations/${encodeURIComponent(phone)}`);
      setMessages(m => ({ ...m, [phone]: data }));
    } catch {}
  }, []);

  // On auth ok, load data + setup SSE
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
          // Update conversations
          setConversations(prev => {
            const idx = prev.findIndex(c => c.phone === phone);
            const now = new Date().toISOString();
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], last_seen: now, lastMessage: { body, direction, created_at: now }, unread_count: direction === 'inbound' ? (updated[idx].unread_count || 0) + 1 : updated[idx].unread_count };
              return [updated[idx], ...updated.filter((_, i) => i !== idx)];
            } else {
              loadConversations();
              return prev;
            }
          });
          // Update thread if open
          setActivePhone(ap => {
            if (ap === phone) {
              setMessages(m => ({
                ...m,
                [phone]: [...(m[phone] || []), { id: Date.now(), contact_phone: phone, direction, body, created_at: new Date().toISOString(), status: 'delivered' }]
              }));
            }
            return ap;
          });
          // Notification
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
      const n = new Notification(`New message from ${phone}`, { body, icon: '/icons/icon-192.png' });
      n.onclick = () => { window.focus(); selectContact(phone); };
    }
  }

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, activePhone]);

  // Load thread when contact selected
  useEffect(() => {
    if (activePhone) loadThread(activePhone);
  }, [activePhone]);

  function selectContact(phone) {
    setActivePhone(phone);
    setIsMobileThread(true);
    setIntelOpen(false);
    setConversations(prev => prev.map(c => c.phone === phone ? { ...c, unread_count: 0 } : c));
    setTimeout(() => inputRef.current?.focus(), 100);
  }

  async function handleSend() {
    if (!input.trim() || !activePhone || sending) return;
    const msg = input.trim();
    setInput('');
    setSending(true);
    try {
      await api('POST', '/api/send', { to: activePhone, message: msg });
    } catch (err) {
      addToast('Failed to send: ' + err.message);
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

  const cc = charCount(input);
  const filtered = conversations.filter(c =>
    !search || c.phone.includes(search) || (c.name || '').toLowerCase().includes(search.toLowerCase())
  );
  const activeMessages = activePhone ? (messages[activePhone] || []) : [];

  if (auth.checking) {
    return <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:'100%',color:'var(--text3)'}}>Loading…</div>;
  }

  if (!auth.ok) {
    return <LoginScreen onLogin={() => setAuth({ checking: false, ok: true })} />;
  }

  const isMobile = window.innerWidth <= 768;

  return (
    <div className="app">
      <ToastContainer toasts={toasts} />
      <div className="header">
        <span className="header-title">Vici SMS</span>
        <span className={`conn-dot ${sseStatus}`} title={sseStatus} />
        {activePhone && (
          <button className={`header-btn${intelOpen ? ' active' : ''}`} onClick={() => setIntelOpen(o => !o)}>
            Intelligence
          </button>
        )}
        <button className="header-btn" disabled={syncing} onClick={async () => {
          setSyncing(true);
          try {
            await api('POST', '/api/sync/seed-from-bridge');
            const r = await api('POST', '/api/sync/ghl');
            addToast(r.error ? 'GHL sync: ' + r.error : 'Sync started — refreshing in 3s');
            setTimeout(() => { loadConversations(); setSyncing(false); }, 3000);
          } catch (e) {
            addToast('Sync: ' + e.message);
            setSyncing(false);
          }
        }}>
          {syncing ? '⏳ Syncing…' : '↻ Sync History'}
        </button>
        <button className="header-btn" onClick={handleLogout}>Logout</button>
      </div>
      <div className="layout">
        <div className={`sidebar${isMobileThread && isMobile ? ' hidden' : ''}`}>
          <div className="search-box">
            <input
              className="search-input"
              placeholder="Search conversations…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="conv-list">
            {filtered.length === 0 && (
              <div className="conv-empty">{search ? 'No matches' : 'No conversations yet'}</div>
            )}
            {filtered.map(c => (
              <ConvItem
                key={c.phone}
                c={c}
                active={c.phone === activePhone}
                onClick={() => selectContact(c.phone)}
              />
            ))}
          </div>
        </div>

        <div className={`thread-panel${isMobile && !isMobileThread ? ' hidden' : ''}`}>
          {!activePhone ? (
            <div className="no-thread">
              <div className="icon">💬</div>
              <p>Select a conversation</p>
            </div>
          ) : (
            <>
              <div className="thread-header">
                <button className="back-btn" onClick={() => { setIsMobileThread(false); setIntelOpen(false); }}>←</button>
                <div className="thread-name">
                  {conversations.find(c => c.phone === activePhone)?.name || activePhone}
                </div>
                <button className="intel-btn" onClick={() => setIntelOpen(o => !o)}>🧠 Intel</button>
              </div>
              <div className="messages-area">
                {activeMessages.length === 0 ? (
                  <div className="empty-state">
                    <div className="icon">🔒</div>
                    <p>No messages yet</p>
                  </div>
                ) : (
                  activeMessages.map((m, idx) => (
                    <div key={m.id || idx} className="msg-group">
                      <div className={`msg-bubble ${m.direction}`}>{m.body}</div>
                      <div className={`msg-meta ${m.direction}`}>
                        {formatTime(m.created_at)}
                        {m.direction === 'outbound' && m.status && (
                          <span className="msg-status" style={{
                            color: m.status === 'delivered' ? 'rgba(255,255,255,0.9)'
                                 : m.status === 'failed'    ? '#fca5a5'
                                 : 'rgba(255,255,255,0.55)'
                          }}>
                            {' · '}{m.status === 'queued' ? 'Sending…' : m.status === 'sent' ? 'Sent' : m.status === 'delivered' ? '✓ Delivered' : '✗ Failed'}
                          </span>
                        )}
                      </div>
                    </div>
                  ))
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
                    onChange={e => { setInput(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'; }}
                    onKeyDown={handleKeyDown}
                    rows={1}
                  />
                  <button className="send-btn" onClick={handleSend} disabled={!input.trim() || sending}>
                    {sending ? <span className="spinner" style={{borderColor:'rgba(255,255,255,0.3)',borderTopColor:'white'}} /> : '↑'}
                  </button>
                </div>
                <div className="compose-footer">
                  <span className={`char-counter${cc.isWarning ? ' warning' : ''}${cc.isDanger ? ' danger' : ''}`}>
                    {cc.chars} / 160
                  </span>
                  <span>{cc.segments} SMS</span>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <IntelligencePanel
        phone={activePhone}
        open={intelOpen}
        onClose={() => setIntelOpen(false)}
        addToast={addToast}
      />
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
