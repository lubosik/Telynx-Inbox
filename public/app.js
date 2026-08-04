const {
  useState,
  useEffect,
  useRef,
  useCallback
} = React;
const TZ = 'America/New_York';

// Proper responsive hook — updates on resize, avoids stale window.innerWidth reads
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const handler = e => setIsMobile(e.matches);
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
  return new Date(ts).toLocaleDateString('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric'
  });
}
function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const time = d.toLocaleTimeString('en-US', {
    timeZone: TZ,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });
  const todayStr = new Date().toLocaleDateString('en-US', {
    timeZone: TZ
  });
  const msgStr = d.toLocaleDateString('en-US', {
    timeZone: TZ
  });
  if (todayStr === msgStr) return time;
  return `${time} · ${d.toLocaleDateString('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric'
  })}`;
}
function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
}
function messageStatusMeta(status) {
  switch ((status || '').toLowerCase()) {
    case 'queued':
    case 'sending':
      return {
        label: '· queued',
        title: 'Accepted by Telnyx and waiting to be sent',
        color: 'var(--text3)'
      };
    case 'sent':
    case 'delivery_unconfirmed':
      return {
        label: '· sent',
        title: 'Sent to the carrier; delivery is not yet confirmed',
        color: 'var(--text3)'
      };
    case 'delivered':
      return {
        label: '· delivered',
        title: 'Carrier confirmed delivery. SMS does not provide read receipts.',
        color: 'var(--accent)'
      };
    case 'failed':
    case 'sending_failed':
    case 'delivery_failed':
      return {
        label: '· failed',
        title: 'The message was not delivered',
        color: 'var(--red)'
      };
    case 'unavailable':
    case 'status_unavailable':
      return {
        label: '· status unavailable',
        title: 'Telnyx no longer has a retrievable delivery record',
        color: 'var(--text3)'
      };
    default:
      return {
        label: `· ${status}`,
        title: 'Message delivery status',
        color: 'var(--text3)'
      };
  }
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
function normalisePhoneFrontend(raw) {
  if (!raw) return null;
  if (raw.startsWith('+')) return raw.replace(/[^\d+]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  if (digits.length >= 11) return '+' + digits;
  return null;
}

// ─── MMS / reactions / replies ───────────────────────────────────────────────

const TAPBACK_EMOJI = {
  loved: '❤️',
  liked: '👍',
  disliked: '👎',
  laughed: '😂',
  emphasized: '‼️',
  questioned: '❓'
};

// Raw tapback rows ("Loved \"...\"") are stored for audit but rendered as a
// reaction badge on the target message, not as a bubble of their own.
const TAPBACK_TEXT_RE = /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned|Removed a|Removed an) /;
function isTapbackRow(m) {
  return !!m.reply_to_message_id && TAPBACK_TEXT_RE.test((m.body || '').trim()) && !(Array.isArray(m.media_urls) && m.media_urls.length);
}
function messagePreviewText(m, n = 60) {
  if (!m) return '';
  const body = (m.body || '').trim();
  if (body) return truncate(body, n);
  if (Array.isArray(m.media_urls) && m.media_urls.length) {
    return m.media_urls.length > 1 ? `📷 ${m.media_urls.length} Pictures` : '📷 Picture';
  }
  return '';
}

// Downscale + re-encode an image client-side so it fits carrier MMS limits
// (~600KB safe max). HEIC from iPhone camera roll is converted to JPEG by the
// browser at pick time; anything the browser can't decode rejects cleanly.
// Small GIFs pass through untouched so animation survives.
function downscaleImage(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('Could not read file'));
    fr.onload = () => {
      if (file.type === 'image/gif' && file.size <= 550 * 1024) {
        const base64 = String(fr.result).split(',')[1];
        return resolve({
          base64,
          contentType: 'image/gif',
          previewUrl: fr.result,
          size: file.size
        });
      }
      const img = new Image();
      img.onerror = () => reject(new Error('Unsupported image format'));
      img.onload = () => {
        const MAX = 1600;
        const scale = Math.min(1, MAX / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        let quality = 0.82;
        let dataUrl = canvas.toDataURL('image/jpeg', quality);
        while (dataUrl.length * 0.75 > 550 * 1024 && quality > 0.4) {
          quality -= 0.12;
          dataUrl = canvas.toDataURL('image/jpeg', quality);
        }
        const base64 = dataUrl.split(',')[1];
        resolve({
          base64,
          contentType: 'image/jpeg',
          previewUrl: dataUrl,
          size: Math.round(base64.length * 0.75)
        });
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// ─── API ─────────────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    credentials: 'include',
    headers: {}
  };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || r.statusText);
  }
  return r.json();
}

// ─── Toast ───────────────────────────────────────────────────────────────────

function ToastContainer({
  toasts
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "toast-container"
  }, toasts.map(t => /*#__PURE__*/React.createElement("div", {
    key: t.id,
    className: "toast"
  }, t.msg)));
}

// ─── Login ───────────────────────────────────────────────────────────────────

function LoginScreen({
  onLogin
}) {
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      await api('POST', '/auth/login', {
        password: pw
      });
      onLogin();
    } catch {
      setError('Incorrect password');
    } finally {
      setLoading(false);
    }
  }
  return /*#__PURE__*/React.createElement("div", {
    className: "login-screen"
  }, /*#__PURE__*/React.createElement("div", {
    className: "login-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "login-logo"
  }, "VICI", /*#__PURE__*/React.createElement("small", null, "// SMS")), /*#__PURE__*/React.createElement("div", {
    className: "login-subtitle"
  }, "Secure Inbox Access"), /*#__PURE__*/React.createElement("form", {
    onSubmit: handleSubmit
  }, /*#__PURE__*/React.createElement("div", {
    className: "input-wrap"
  }, /*#__PURE__*/React.createElement("input", {
    type: show ? 'text' : 'password',
    placeholder: "Access code",
    value: pw,
    onChange: e => setPw(e.target.value),
    autoFocus: true
  }), /*#__PURE__*/React.createElement("button", {
    type: "button",
    className: "eye-btn",
    onClick: () => setShow(s => !s)
  }, show ? '◉' : '○')), /*#__PURE__*/React.createElement("button", {
    className: "btn-primary",
    type: "submit",
    disabled: loading || !pw
  }, loading ? /*#__PURE__*/React.createElement("span", {
    className: "spinner",
    style: {
      borderTopColor: '#030712'
    }
  }) : 'AUTHENTICATE'), /*#__PURE__*/React.createElement("div", {
    className: "error-msg"
  }, error))));
}

// ─── Order Card (inside modal) ────────────────────────────────────────────────

function OrderCard({
  order
}) {
  const smsDots = [{
    sent: order.order_sms_sent,
    title: 'Order confirmed SMS'
  }, {
    sent: order.shipped_sms_sent,
    title: 'Shipped SMS'
  }, {
    sent: order.delivery_sms_sent,
    title: 'Delivered SMS'
  }];
  return /*#__PURE__*/React.createElement("div", {
    className: "order-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "order-card-header"
  }, /*#__PURE__*/React.createElement("span", {
    className: "order-num"
  }, "#", order.woo_order_id || '—'), /*#__PURE__*/React.createElement("span", {
    className: `order-badge ${order.status}`
  }, order.status), /*#__PURE__*/React.createElement("span", {
    className: "order-total"
  }, "$", parseFloat(order.total || 0).toFixed(2))), (order.items || []).slice(0, 3).map((item, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: "order-item"
  }, /*#__PURE__*/React.createElement("span", {
    className: "order-item-qty"
  }, "\xD7", item.quantity), item.name)), (order.items || []).length > 3 && /*#__PURE__*/React.createElement("div", {
    className: "order-item",
    style: {
      color: 'var(--text3)'
    }
  }, "+", order.items.length - 3, " more items"), /*#__PURE__*/React.createElement("div", {
    className: "order-footer"
  }, /*#__PURE__*/React.createElement("span", {
    className: "order-date"
  }, formatDate(order.created_at)), order.tracking_number && /*#__PURE__*/React.createElement("span", {
    className: "tracking-line"
  }, "\uD83D\uDCE6 ", order.carrier?.toUpperCase(), " ", order.tracking_number), /*#__PURE__*/React.createElement("div", {
    className: "sms-dots",
    title: smsDots.map(d => d.title + ': ' + (d.sent ? '✓' : 'pending')).join('\n')
  }, smsDots.map((d, i) => /*#__PURE__*/React.createElement("div", {
    key: i,
    className: `sms-dot ${d.sent ? 'sent' : 'unsent'}`
  })))));
}

// ─── Suggestion Card ──────────────────────────────────────────────────────────

function SuggestionCard({
  s,
  onSend,
  onDismiss
}) {
  const [sending, setSending] = useState(false);
  const [gone, setGone] = useState(false);
  if (gone) return null;
  return /*#__PURE__*/React.createElement("div", {
    className: "suggestion-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "sug-type"
  }, s.suggestion_type?.replace(/_/g, ' ')), /*#__PURE__*/React.createElement("div", {
    className: "sug-reason"
  }, s.suggestion_text), /*#__PURE__*/React.createElement("div", {
    className: "sug-msg"
  }, s.suggested_message), /*#__PURE__*/React.createElement("div", {
    className: "sug-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-sug-send",
    disabled: sending,
    onClick: async () => {
      setSending(true);
      await onSend(s.id);
      setSending(false);
      setGone(true);
    }
  }, sending ? /*#__PURE__*/React.createElement("span", {
    className: "spinner",
    style: {
      borderTopColor: '#030712'
    }
  }) : 'Send'), /*#__PURE__*/React.createElement("button", {
    className: "btn-sug-dismiss",
    onClick: () => {
      onDismiss(s.id);
      setGone(true);
    }
  }, "Dismiss")));
}

// ─── Contact Modal (3D popup) ─────────────────────────────────────────────────

function ContactModal({
  phone,
  onClose,
  onGoToMessages,
  addToast
}) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('orders');
  const [analysing, setAnalysing] = useState(false);
  useEffect(() => {
    setProfile(null);
    setLoading(true);
    setTab('orders');
    api('GET', `/api/contacts/${encodeURIComponent(phone)}`).then(setProfile).catch(() => {}).finally(() => setLoading(false));
  }, [phone]);

  // Close on escape or backdrop click
  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape') onClose();
    };
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
    } catch {
      addToast('Analysis failed');
    }
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
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-overlay",
    onClick: e => {
      if (e.target === e.currentTarget) onClose();
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-card"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 30
    }
  }), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onClose
  }, "\u2715")), loading && /*#__PURE__*/React.createElement("div", {
    style: {
      textAlign: 'center',
      padding: '3rem'
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "spinner",
    style: {
      width: '24px',
      height: '24px'
    }
  })), !loading && profile && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "modal-identity"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-avatar"
  }, getInitials(profile)), /*#__PURE__*/React.createElement("div", {
    className: "modal-info"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-name"
  }, profile.name || 'Unknown'), /*#__PURE__*/React.createElement("div", {
    className: "modal-phone"
  }, profile.phone), profile.email && /*#__PURE__*/React.createElement("div", {
    className: "modal-email"
  }, profile.email), (profile.city || profile.state) && /*#__PURE__*/React.createElement("div", {
    className: "modal-location"
  }, [profile.city, profile.state, profile.country].filter(Boolean).join(', ')))), /*#__PURE__*/React.createElement("div", {
    className: "modal-stats"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-stat-val"
  }, profile.total_orders), /*#__PURE__*/React.createElement("div", {
    className: "modal-stat-label"
  }, "Orders")), /*#__PURE__*/React.createElement("div", {
    className: "modal-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-stat-val"
  }, "$", profile.total_spent?.toFixed(0) || '0'), /*#__PURE__*/React.createElement("div", {
    className: "modal-stat-label"
  }, "Spent")), /*#__PURE__*/React.createElement("div", {
    className: "modal-stat"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-stat-val",
    style: {
      fontSize: '0.75rem'
    }
  }, profile.orders?.[0] ? relativeTime(profile.orders[0].created_at) : '—'), /*#__PURE__*/React.createElement("div", {
    className: "modal-stat-label"
  }, "Last Order"))), /*#__PURE__*/React.createElement("div", {
    className: "modal-tabs"
  }, /*#__PURE__*/React.createElement("button", {
    className: `modal-tab${tab === 'orders' ? ' active' : ''}`,
    onClick: () => setTab('orders')
  }, "Orders ", profile.orders?.length > 0 && `(${profile.orders.length})`), /*#__PURE__*/React.createElement("button", {
    className: `modal-tab${tab === 'intel' ? ' active' : ''}`,
    onClick: () => setTab('intel')
  }, "Intelligence")), /*#__PURE__*/React.createElement("div", {
    className: "modal-body"
  }, tab === 'orders' && /*#__PURE__*/React.createElement(React.Fragment, null, profile.orders.length === 0 ? /*#__PURE__*/React.createElement("div", {
    className: "orders-empty"
  }, "No orders found.", /*#__PURE__*/React.createElement("br", null), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text3)',
      fontSize: '0.75rem'
    }
  }, "Click \u21BB WOO to sync WooCommerce orders.")) : profile.orders.map(order => /*#__PURE__*/React.createElement(OrderCard, {
    key: order.id,
    order: order
  }))), tab === 'intel' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "reanalyse-row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "reanalyse-btn",
    onClick: reanalyse,
    disabled: analysing
  }, analysing ? /*#__PURE__*/React.createElement("span", {
    className: "spinner"
  }) : '↺ Re-analyse'), intel?.last_analysed && /*#__PURE__*/React.createElement("span", {
    className: "last-analysed-txt"
  }, "Last: ", relativeTime(intel.last_analysed))), !intel ? /*#__PURE__*/React.createElement("div", {
    className: "intel-summary",
    style: {
      color: 'var(--text3)'
    }
  }, "No analysis yet. Send this contact a message, then click re-analyse.") : /*#__PURE__*/React.createElement(React.Fragment, null, intel.raw_summary && /*#__PURE__*/React.createElement("div", {
    className: "intel-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "intel-label"
  }, "AI Summary"), /*#__PURE__*/React.createElement("div", {
    className: "intel-summary"
  }, intel.raw_summary)), intel.sentiment && /*#__PURE__*/React.createElement("div", {
    className: "intel-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "intel-label"
  }, "Sentiment"), /*#__PURE__*/React.createElement("span", {
    className: `sentiment-badge ${intel.sentiment}`
  }, intel.sentiment)), intel.inferred_interests?.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "intel-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "intel-label"
  }, "Interests"), intel.inferred_interests.map((x, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "tag-chip green"
  }, x))), intel.order_signals?.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "intel-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "intel-label"
  }, "Purchase Signals"), /*#__PURE__*/React.createElement("ul", {
    className: "signal-list"
  }, intel.order_signals.map((s, i) => /*#__PURE__*/React.createElement("li", {
    key: i
  }, s)))), intel.restock_interests?.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "intel-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "intel-label"
  }, "Restock Watch"), intel.restock_interests.map((x, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    className: "tag-chip orange"
  }, x)))), suggestions.length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "intel-section"
  }, /*#__PURE__*/React.createElement("div", {
    className: "intel-label",
    style: {
      marginBottom: '0.625rem'
    }
  }, "Campaign Suggestions"), suggestions.map(s => /*#__PURE__*/React.createElement(SuggestionCard, {
    key: s.id,
    s: s,
    onSend: sendSuggestion,
    onDismiss: dismissSuggestion
  }))))), /*#__PURE__*/React.createElement("div", {
    className: "modal-footer"
  }, /*#__PURE__*/React.createElement("button", {
    className: "btn-message",
    onClick: () => {
      onGoToMessages(profile.phone);
      onClose();
    }
  }, "Open Message Thread \u2192")))));
}

// ─── Vici Pinned Card ─────────────────────────────────────────────────────────

function ViciModal({
  onClose
}) {
  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
  return /*#__PURE__*/React.createElement("div", {
    className: "modal-overlay",
    onClick: e => {
      if (e.target === e.currentTarget) onClose();
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-card",
    style: {
      maxWidth: 380
    }
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-header"
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: '0.6rem',
      fontFamily: 'var(--mono)',
      color: 'var(--accent)',
      letterSpacing: '0.1em',
      padding: '0.15rem 0.5rem',
      background: 'var(--accent-dim)',
      border: '1px solid rgba(0,245,160,0.2)',
      borderRadius: 4
    }
  }, "PINNED \xB7 OUR NUMBER"), /*#__PURE__*/React.createElement("button", {
    className: "modal-close",
    onClick: onClose
  }, "\u2715")), /*#__PURE__*/React.createElement("div", {
    className: "modal-identity"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-avatar",
    style: {
      background: 'var(--accent-dim)',
      fontSize: '1.25rem'
    }
  }, "V"), /*#__PURE__*/React.createElement("div", {
    className: "modal-info"
  }, /*#__PURE__*/React.createElement("div", {
    className: "modal-name"
  }, "Vici Peptides"), /*#__PURE__*/React.createElement("div", {
    className: "modal-phone",
    style: {
      fontSize: '1rem',
      letterSpacing: '0.04em'
    }
  }, "+1 (305) 404-3184"), /*#__PURE__*/React.createElement("a", {
    href: "https://vicipeptides.com",
    target: "_blank",
    rel: "noopener noreferrer",
    style: {
      fontSize: '0.75rem',
      color: 'var(--blue)',
      fontFamily: 'var(--mono)',
      textDecoration: 'none',
      display: 'block',
      marginTop: 4
    }
  }, "vicipeptides.com \u2197"))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0.875rem 1.25rem',
      borderTop: '1px solid var(--border)',
      color: 'var(--text3)',
      fontSize: '0.6875rem',
      fontFamily: 'var(--mono)'
    }
  }, "// this is the number your customers text")));
}
function ViciPinnedCard({
  onClick
}) {
  return /*#__PURE__*/React.createElement("div", {
    className: "contact-card vici-card",
    onClick: onClick
  }, /*#__PURE__*/React.createElement("div", {
    className: "card-avatar vici-avatar"
  }, "V"), /*#__PURE__*/React.createElement("div", {
    className: "card-name"
  }, "Vici Peptides"), /*#__PURE__*/React.createElement("div", {
    className: "card-phone"
  }, "(305) 404-3184"), /*#__PURE__*/React.createElement("div", {
    className: "card-meta"
  }, /*#__PURE__*/React.createElement("span", {
    className: "vici-pin-badge"
  }, "\uD83D\uDCCC OUR NUMBER")));
}

// ─── Contacts View ────────────────────────────────────────────────────────────

function ContactsView({
  conversations,
  onGoToMessages,
  onCall,
  addToast,
  onRefresh,
  prefillPhone,
  onClearPrefill
}) {
  const isMobile = useIsMobile();
  const [search, setSearch] = useState('');
  const [selectedContact, setSelectedContact] = useState(null);
  const [isCreating, setIsCreating] = useState(false);
  const [newContact, setNewContact] = useState({
    first_name: '',
    last_name: '',
    phone: '',
    email: '',
    notes: ''
  });
  const [createError, setCreateError] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showViciModal, setShowViciModal] = useState(false);

  // Pre-fill from call log "Create Contact" button
  useEffect(() => {
    if (prefillPhone) {
      setNewContact({
        first_name: '',
        last_name: '',
        phone: prefillPhone,
        email: '',
        notes: ''
      });
      setIsCreating(true);
      setCreateError('');
      if (onClearPrefill) onClearPrefill();
    }
  }, [prefillPhone]);

  // Sort by most recent activity: latest order date > last_seen > last message
  const sorted = [...conversations].sort((a, b) => {
    const aKey = Math.max(a.latest_order_date ? new Date(a.latest_order_date).getTime() : 0, a.last_seen ? new Date(a.last_seen).getTime() : 0, a.lastMessage?.created_at ? new Date(a.lastMessage.created_at).getTime() : 0);
    const bKey = Math.max(b.latest_order_date ? new Date(b.latest_order_date).getTime() : 0, b.last_seen ? new Date(b.last_seen).getTime() : 0, b.lastMessage?.created_at ? new Date(b.lastMessage.created_at).getTime() : 0);
    return bKey - aKey;
  });

  // Client-side search
  const filtered = sorted.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.phone.includes(q) || (c.name || '').toLowerCase().includes(q) || (c.first_name || '').toLowerCase().includes(q) || (c.last_name || '').toLowerCase().includes(q) || (c.email || '').toLowerCase().includes(q);
  });
  async function loadContactDetail(phone) {
    setLoadingDetail(true);
    setIsEditing(false);
    try {
      const data = await api('GET', `/api/contacts/${encodeURIComponent(phone)}`);
      setSelectedContact(data);
    } catch (err) {
      addToast('Failed to load contact: ' + err.message);
    } finally {
      setLoadingDetail(false);
    }
  }
  async function createContact() {
    setCreateError('');
    if (!newContact.phone) {
      setCreateError('Phone number is required');
      return;
    }
    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(newContact)
      });
      const data = await res.json();
      if (!res.ok) {
        setCreateError(data.error || 'Failed to create contact');
        return;
      }
      setIsCreating(false);
      setNewContact({
        first_name: '',
        last_name: '',
        phone: '',
        email: '',
        notes: ''
      });
      if (onRefresh) await onRefresh();
      setSelectedContact({
        contact: data.contact,
        orders: []
      });
    } catch (err) {
      setCreateError(err.message);
    }
  }
  async function updateContact(phone, updates) {
    try {
      const data = await api('PATCH', `/api/contacts/${encodeURIComponent(phone)}`, updates);
      // If phone was changed, reload detail with the new phone
      const reloadPhone = updates.new_phone || phone;
      await loadContactDetail(reloadPhone);
      if (onRefresh) await onRefresh();
      setIsEditing(false);
    } catch (err) {
      addToast('Failed to update contact: ' + err.message);
    }
  }
  const showList = !isMobile || !selectedContact;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flex: 1,
      minHeight: 0,
      overflow: 'hidden'
    }
  }, showList && /*#__PURE__*/React.createElement("div", {
    style: {
      width: selectedContact && !isMobile ? '320px' : '100%',
      borderRight: selectedContact && !isMobile ? '1px solid #2a2a2a' : 'none',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '14px 16px',
      borderBottom: '1px solid #2a2a2a',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      fontSize: 15,
      fontWeight: 600,
      color: '#fff'
    }
  }, "Contacts", /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 8,
      fontSize: 12,
      color: '#9ca3af',
      fontWeight: 400
    }
  }, conversations.length)), /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      setIsCreating(true);
      setCreateError('');
    },
    style: {
      background: '#16a34a',
      border: 'none',
      borderRadius: 6,
      padding: '7px 14px',
      color: '#fff',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer'
    }
  }, "+ New")), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '10px 16px',
      borderBottom: '1px solid #2a2a2a',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("input", {
    type: "text",
    placeholder: "Search by name or number...",
    value: search,
    onChange: e => setSearch(e.target.value),
    style: {
      width: '100%',
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 6,
      padding: '8px 12px',
      color: '#fff',
      fontSize: 13,
      outline: 'none',
      boxSizing: 'border-box'
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement(ViciPinnedCard, {
    onClick: () => setShowViciModal(true)
  }), filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 32,
      textAlign: 'center',
      color: '#9ca3af',
      fontSize: 13
    }
  }, search ? `No contacts match "${search}"` : 'No contacts yet'), filtered.map(c => /*#__PURE__*/React.createElement(ContactRow, {
    key: c.phone,
    contact: c,
    isSelected: selectedContact?.contact?.phone === c.phone,
    onClick: () => loadContactDetail(c.phone)
  })))), selectedContact && !isMobile && /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minHeight: 0,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement(ContactDetail, {
    data: selectedContact,
    loading: loadingDetail,
    onCall: onCall,
    onMessage: phone => {
      onGoToMessages(phone);
    },
    isEditing: isEditing,
    onEditOpen: () => setIsEditing(true),
    onEditCancel: () => setIsEditing(false),
    onEditSave: updateContact
  })), selectedContact && isMobile && /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      inset: 0,
      background: '#0a0a0a',
      zIndex: 100,
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '12px 16px',
      borderBottom: '1px solid #2a2a2a',
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setSelectedContact(null),
    style: {
      background: 'none',
      border: 'none',
      color: '#9ca3af',
      fontSize: 20,
      cursor: 'pointer',
      padding: '4px 8px'
    }
  }, "\u2190"), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 15,
      fontWeight: 600,
      color: '#fff'
    }
  }, selectedContact.contact?.display_name || selectedContact.contact?.phone)), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflow: 'hidden'
    }
  }, /*#__PURE__*/React.createElement(ContactDetail, {
    data: selectedContact,
    loading: loadingDetail,
    onCall: onCall,
    onMessage: phone => {
      onGoToMessages(phone);
    },
    isEditing: isEditing,
    onEditOpen: () => setIsEditing(true),
    onEditCancel: () => setIsEditing(false),
    onEditSave: updateContact
  }))), isCreating && /*#__PURE__*/React.createElement(CreateContactModal, {
    data: newContact,
    onChange: setNewContact,
    onSubmit: createContact,
    onCancel: () => {
      setIsCreating(false);
      setCreateError('');
    },
    error: createError
  }), showViciModal && /*#__PURE__*/React.createElement(ViciModal, {
    onClose: () => setShowViciModal(false)
  }));
}

// ─── Contact Row ──────────────────────────────────────────────────────────────

function ContactRow({
  contact,
  isSelected,
  onClick
}) {
  const displayName = contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.name || contact.phone;
  const initials = (() => {
    const parts = displayName.split(' ').filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return displayName.slice(0, 2).toUpperCase();
  })();
  const statusColour = {
    completed: '#16a34a',
    processing: '#3b82f6',
    'on-hold': '#f59e0b',
    shipped: '#a855f7',
    delivered: '#16a34a',
    failed: '#ef4444',
    cancelled: '#9ca3af',
    refunded: '#9ca3af',
    pending: '#6b7280'
  };
  const latestStatus = contact.latest_order_status;
  const statusColor = latestStatus ? statusColour[latestStatus] || '#9ca3af' : null;
  return /*#__PURE__*/React.createElement("div", {
    onClick: onClick,
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '11px 16px',
      cursor: 'pointer',
      background: isSelected ? '#1a2a1a' : 'transparent',
      borderLeft: isSelected ? '2px solid #16a34a' : '2px solid transparent',
      borderBottom: '1px solid #111'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 38,
      height: 38,
      borderRadius: '50%',
      background: contact.avatar_url ? 'transparent' : '#222',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 13,
      fontWeight: 600,
      color: '#9ca3af',
      flexShrink: 0,
      overflow: 'hidden'
    }
  }, contact.avatar_url ? /*#__PURE__*/React.createElement("img", {
    src: contact.avatar_url,
    alt: "",
    style: {
      width: '100%',
      height: '100%',
      objectFit: 'cover',
      borderRadius: '50%'
    }
  }) : initials), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: '#fff',
      marginBottom: 2,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    }
  }, displayName), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 12,
      color: '#6b7280'
    }
  }, contact.phone), latestStatus && /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 10,
      padding: '1px 6px',
      borderRadius: 4,
      background: `${statusColor}22`,
      color: statusColor,
      textTransform: 'capitalize',
      fontWeight: 600
    }
  }, latestStatus))), (contact.unread_count || 0) > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      minWidth: 18,
      height: 18,
      borderRadius: 9,
      background: '#3b82f6',
      color: '#fff',
      fontSize: 10,
      fontWeight: 700,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '0 5px',
      flexShrink: 0
    }
  }, contact.unread_count));
}

// ─── Contact Detail ───────────────────────────────────────────────────────────

function ContactDetail({
  data,
  loading,
  onCall,
  onMessage,
  isEditing,
  onEditOpen,
  onEditCancel,
  onEditSave
}) {
  const {
    contact,
    orders
  } = data;
  const [editData, setEditData] = useState({
    first_name: contact.first_name || '',
    last_name: contact.last_name || '',
    phone: contact.phone || '',
    email: contact.email || '',
    notes: contact.notes || '',
    avatar_url: contact.avatar_url || ''
  });

  // Reset edit form when contact changes
  useEffect(() => {
    setEditData({
      first_name: contact.first_name || '',
      last_name: contact.last_name || '',
      phone: contact.phone || '',
      email: contact.email || '',
      notes: contact.notes || '',
      avatar_url: contact.avatar_url || ''
    });
  }, [contact.phone]);
  function handleAvatarUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => setEditData(p => ({
      ...p,
      avatar_url: ev.target.result
    }));
    reader.readAsDataURL(file);
  }
  const displayName = contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(' ') || contact.name || contact.phone;
  const initials = (() => {
    const parts = displayName.split(' ').filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return displayName.slice(0, 2).toUpperCase();
  })();
  const statusColour = {
    completed: '#16a34a',
    processing: '#3b82f6',
    'on-hold': '#f59e0b',
    failed: '#ef4444',
    cancelled: '#9ca3af',
    refunded: '#9ca3af',
    shipped: '#a855f7',
    delivered: '#16a34a'
  };
  const detailInput = {
    width: '100%',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '9px 12px',
    color: '#fff',
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box'
  };
  if (loading) {
    return /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "spinner",
      style: {
        width: 24,
        height: 24
      }
    }));
  }
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '24px 24px 16px',
      borderBottom: '1px solid #2a2a2a'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'relative',
      width: 56,
      marginBottom: 12,
      display: 'inline-block'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 56,
      height: 56,
      borderRadius: '50%',
      background: (isEditing ? editData.avatar_url : contact.avatar_url) ? 'transparent' : '#222',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 20,
      fontWeight: 600,
      color: '#9ca3af',
      overflow: 'hidden'
    }
  }, (isEditing ? editData.avatar_url : contact.avatar_url) ? /*#__PURE__*/React.createElement("img", {
    src: isEditing ? editData.avatar_url : contact.avatar_url,
    alt: "",
    style: {
      width: '100%',
      height: '100%',
      objectFit: 'cover'
    }
  }) : initials), isEditing && /*#__PURE__*/React.createElement("label", {
    style: {
      position: 'absolute',
      bottom: -2,
      right: -2,
      width: 20,
      height: 20,
      borderRadius: '50%',
      background: '#16a34a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'pointer',
      fontSize: 10
    }
  }, "+", /*#__PURE__*/React.createElement("input", {
    type: "file",
    accept: "image/*",
    onChange: handleAvatarUpload,
    style: {
      display: 'none'
    }
  }))), !isEditing && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 600,
      color: '#fff',
      marginBottom: 2
    }
  }, displayName), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: '#9ca3af',
      marginBottom: contact.email ? 2 : 12
    }
  }, contact.phone), contact.email && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: '#6b7280',
      marginBottom: 12
    }
  }, contact.email), contact.notes && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: '#9ca3af',
      background: '#1a1a1a',
      borderRadius: 6,
      padding: '8px 12px',
      marginBottom: 12
    }
  }, contact.notes), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => onMessage(contact.phone),
    style: {
      flex: 1,
      padding: '10px',
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 8,
      color: '#fff',
      fontSize: 13,
      cursor: 'pointer',
      fontWeight: 500
    }
  }, "Message"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onCall(contact.phone, displayName),
    style: {
      flex: 1,
      padding: '10px',
      background: '#16a34a',
      border: 'none',
      borderRadius: 8,
      color: '#fff',
      fontSize: 13,
      cursor: 'pointer',
      fontWeight: 500
    }
  }, "Call"), /*#__PURE__*/React.createElement("button", {
    onClick: onEditOpen,
    style: {
      padding: '10px 14px',
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 8,
      color: '#9ca3af',
      fontSize: 13,
      cursor: 'pointer'
    }
  }, "Edit"))), isEditing && /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: editData.first_name,
    onChange: e => setEditData(p => ({
      ...p,
      first_name: e.target.value
    })),
    placeholder: "First name",
    style: detailInput
  }), /*#__PURE__*/React.createElement("input", {
    value: editData.last_name,
    onChange: e => setEditData(p => ({
      ...p,
      last_name: e.target.value
    })),
    placeholder: "Last name",
    style: detailInput
  })), /*#__PURE__*/React.createElement("input", {
    value: editData.phone,
    onChange: e => setEditData(p => ({
      ...p,
      phone: e.target.value
    })),
    placeholder: "Phone number",
    style: detailInput
  }), /*#__PURE__*/React.createElement("input", {
    value: editData.email,
    onChange: e => setEditData(p => ({
      ...p,
      email: e.target.value
    })),
    placeholder: "Email (optional)",
    style: detailInput
  }), /*#__PURE__*/React.createElement("textarea", {
    value: editData.notes,
    onChange: e => setEditData(p => ({
      ...p,
      notes: e.target.value
    })),
    placeholder: "Notes...",
    rows: 3,
    style: {
      ...detailInput,
      resize: 'vertical'
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => {
      const updates = {
        ...editData
      };
      if (editData.phone !== contact.phone) updates.new_phone = editData.phone;
      delete updates.phone;
      onEditSave(contact.phone, updates);
    },
    style: {
      flex: 1,
      padding: '10px',
      background: '#16a34a',
      border: 'none',
      borderRadius: 8,
      color: '#fff',
      fontSize: 13,
      cursor: 'pointer',
      fontWeight: 600
    }
  }, "Save"), /*#__PURE__*/React.createElement("button", {
    onClick: onEditCancel,
    style: {
      padding: '10px 14px',
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 8,
      color: '#9ca3af',
      fontSize: 13,
      cursor: 'pointer'
    }
  }, "Cancel")))), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px 24px'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#9ca3af',
      letterSpacing: '0.12em',
      textTransform: 'uppercase',
      marginBottom: 12
    }
  }, "Order History"), !orders || orders.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '16px',
      background: '#1a1a1a',
      borderRadius: 8,
      fontSize: 13,
      color: '#9ca3af',
      textAlign: 'center'
    }
  }, "No orders yet") : orders.map((order, i) => /*#__PURE__*/React.createElement("div", {
    key: order.woo_order_id || order.id || i,
    style: {
      background: '#1a1a1a',
      borderRadius: 8,
      padding: '12px 14px',
      marginBottom: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      fontWeight: 600,
      color: '#fff'
    }
  }, "Order #", order.woo_order_id), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 11,
      padding: '2px 8px',
      borderRadius: 4,
      background: `${statusColour[order.status] || '#9ca3af'}22`,
      color: statusColour[order.status] || '#9ca3af',
      textTransform: 'capitalize'
    }
  }, order.status)), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: '#9ca3af',
      marginBottom: 4
    }
  }, "$", parseFloat(order.total || 0).toFixed(2), " \xB7 ", formatDate(order.created_at)), Array.isArray(order.items) && order.items.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: '#6b7280'
    }
  }, order.items.map(it => `${it.quantity}x ${it.name}`).join(', ')), order.tracking_number && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: '#3b82f6',
      marginTop: 4
    }
  }, "Tracking: ", order.tracking_number, " ", order.carrier ? `(${order.carrier.toUpperCase()})` : '')))));
}

// ─── Create Contact Modal ─────────────────────────────────────────────────────

function CreateContactModal({
  data,
  onChange,
  onSubmit,
  onCancel,
  error
}) {
  const modalInput = {
    width: '100%',
    background: '#111',
    border: '1px solid #2a2a2a',
    borderRadius: 6,
    padding: '9px 12px',
    color: '#fff',
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box'
  };
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.75)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2000
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 12,
      padding: 28,
      width: '90%',
      maxWidth: 400
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 16,
      fontWeight: 600,
      color: '#fff',
      marginBottom: 20
    }
  }, "New Contact"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      gap: 12
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("input", {
    value: data.first_name,
    onChange: e => onChange(p => ({
      ...p,
      first_name: e.target.value
    })),
    placeholder: "First name (optional)",
    style: modalInput
  }), /*#__PURE__*/React.createElement("input", {
    value: data.last_name,
    onChange: e => onChange(p => ({
      ...p,
      last_name: e.target.value
    })),
    placeholder: "Last name (optional)",
    style: modalInput
  })), /*#__PURE__*/React.createElement("input", {
    value: data.phone,
    onChange: e => onChange(p => ({
      ...p,
      phone: e.target.value
    })),
    placeholder: "Phone (e.g. 3055551234) *",
    style: modalInput
  }), /*#__PURE__*/React.createElement("input", {
    value: data.email,
    onChange: e => onChange(p => ({
      ...p,
      email: e.target.value
    })),
    placeholder: "Email (optional)",
    style: modalInput
  }), /*#__PURE__*/React.createElement("textarea", {
    value: data.notes,
    onChange: e => onChange(p => ({
      ...p,
      notes: e.target.value
    })),
    placeholder: "Notes (optional)",
    rows: 3,
    style: {
      ...modalInput,
      resize: 'vertical'
    }
  }), error && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: '#ef4444'
    }
  }, error), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 10,
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onSubmit,
    style: {
      flex: 1,
      padding: '12px',
      background: '#16a34a',
      border: 'none',
      borderRadius: 8,
      color: '#fff',
      fontSize: 14,
      fontWeight: 600,
      cursor: 'pointer'
    }
  }, "Create Contact"), /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      padding: '12px 16px',
      background: 'none',
      border: '1px solid #2a2a2a',
      borderRadius: 8,
      color: '#9ca3af',
      fontSize: 14,
      cursor: 'pointer'
    }
  }, "Cancel")))));
}

// ─── Messages View ────────────────────────────────────────────────────────────

function MessagesView({
  conversations,
  activePhone,
  messages,
  onSelectContact,
  input,
  setInput,
  onSend,
  onKeyDown,
  sending,
  inputRef,
  messagesEndRef,
  mobileSub,
  setMobileSub,
  callState,
  voiceReady,
  onInitiateCall,
  attachments,
  onPickFiles,
  onRemoveAttachment,
  replyTarget,
  setReplyTarget,
  onReact
}) {
  const [search, setSearch] = useState('');
  const [actionTarget, setActionTarget] = useState(null); // message for the long-press sheet
  const [lightbox, setLightbox] = useState(null); // full-screen image URL
  const fileInputRef = useRef(null);
  const pressTimer = useRef(null);
  const isMobile = useIsMobile();
  const startPress = m => {
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => setActionTarget(m), 450);
  };
  const endPress = () => clearTimeout(pressTimer.current);

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
    const aKey = Math.max(a.last_seen ? new Date(a.last_seen).getTime() : 0, a.latest_order_date ? new Date(a.latest_order_date).getTime() : 0);
    const bKey = Math.max(b.last_seen ? new Date(b.last_seen).getTime() : 0, b.latest_order_date ? new Date(b.latest_order_date).getTime() : 0);
    return bKey - aKey;
  });
  const filtered = sorted.filter(c => {
    if (!search) return true;
    const q = search.toLowerCase();
    return c.phone.includes(q) || (c.name || '').toLowerCase().includes(q);
  });
  const activeMessages = activePhone ? messages[activePhone] || [] : [];
  // Tapback rows render as badges on their target message, not as bubbles
  const visibleMessages = activeMessages.filter(m => !isTapbackRow(m));
  const activeContact = conversations.find(c => c.phone === activePhone);
  const cc = charCount(input);
  const readyAttachments = (attachments || []).filter(a => a.status === 'ready');
  const processingAttachments = (attachments || []).some(a => a.status === 'processing');
  const canSend = (input.trim() || readyAttachments.length > 0) && !sending && !processingAttachments;
  return /*#__PURE__*/React.createElement("div", {
    className: "messages-view"
  }, /*#__PURE__*/React.createElement("div", {
    className: `conv-sidebar${isMobile && mobileSub === 'thread' ? ' hidden' : ''}`
  }, /*#__PURE__*/React.createElement("div", {
    className: "conv-search-wrap"
  }, /*#__PURE__*/React.createElement("input", {
    className: "conv-search",
    placeholder: "Search messages\u2026",
    value: search,
    onChange: e => setSearch(e.target.value)
  })), /*#__PURE__*/React.createElement("div", {
    className: "conv-list"
  }, filtered.length === 0 && /*#__PURE__*/React.createElement("div", {
    className: "conv-empty"
  }, search ? `// no results` : `// no conversations`), filtered.map((c, idx) => {
    const prevHasMsg = idx > 0 && !!filtered[idx - 1].lastMessage;
    const thisHasMsg = !!c.lastMessage;
    const showDivider = prevHasMsg && !thisHasMsg;
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: c.phone
    }, showDivider && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '0.5rem 1rem',
        fontSize: '0.6rem',
        color: 'var(--text3)',
        letterSpacing: '0.1em',
        fontFamily: 'var(--mono)',
        borderBottom: '1px solid var(--border)',
        background: 'var(--bg)'
      }
    }, "// NO MESSAGES YET"), /*#__PURE__*/React.createElement(ConvRow, {
      contact: c,
      active: c.phone === activePhone,
      onClick: () => {
        onSelectContact(c.phone);
        if (isMobile) setMobileSub('thread');
      }
    }));
  }))), /*#__PURE__*/React.createElement("div", {
    className: `thread-panel${isMobile && mobileSub === 'list' ? ' hidden' : ''}`
  }, !activePhone ? /*#__PURE__*/React.createElement("div", {
    className: "no-thread"
  }, /*#__PURE__*/React.createElement("div", {
    className: "no-thread-icon"
  }, "\u2709"), /*#__PURE__*/React.createElement("p", null, "Select a conversation")) : /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    className: "thread-header"
  }, /*#__PURE__*/React.createElement("button", {
    className: "back-btn",
    onClick: () => setMobileSub('list')
  }, "\u2190"), /*#__PURE__*/React.createElement("div", {
    className: "thread-contact"
  }, /*#__PURE__*/React.createElement("div", {
    className: "thread-name"
  }, activeContact?.name || activePhone), activeContact?.name && /*#__PURE__*/React.createElement("div", {
    className: "thread-phone"
  }, activePhone)), activePhone && /*#__PURE__*/React.createElement("button", {
    onClick: () => onInitiateCall(activePhone, activeContact?.name || null),
    disabled: callState.status !== 'idle' || !voiceReady,
    style: {
      background: 'none',
      border: `1px solid ${callState.status !== 'idle' || !voiceReady ? '#2a2a2a' : '#16a34a'}`,
      borderRadius: 6,
      padding: '6px 12px',
      color: callState.status !== 'idle' || !voiceReady ? '#9ca3af' : '#16a34a',
      cursor: callState.status !== 'idle' || !voiceReady ? 'default' : 'pointer',
      fontSize: 13,
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      marginLeft: 8,
      flexShrink: 0
    },
    title: "Call this customer"
  }, "\uD83D\uDCDE Call")), /*#__PURE__*/React.createElement("div", {
    className: "messages-area"
  }, visibleMessages.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--text3)',
      fontFamily: 'var(--mono)',
      fontSize: '0.8125rem'
    }
  }, "// no messages yet") : visibleMessages.map((m, idx) => {
    const prev = visibleMessages[idx - 1];
    const showDate = !prev || new Date(m.created_at).toDateString() !== new Date(prev.created_at).toDateString();
    const original = m.reply_to_message_id ? activeMessages.find(x => x.id === m.reply_to_message_id) : null;
    const media = Array.isArray(m.media_urls) ? m.media_urls : [];
    const reactions = Array.isArray(m.reactions) ? m.reactions : [];
    return /*#__PURE__*/React.createElement(React.Fragment, {
      key: m.id || idx
    }, showDate && /*#__PURE__*/React.createElement("div", {
      className: "date-divider"
    }, new Date(m.created_at).toLocaleDateString('en-US', {
      timeZone: TZ,
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    })), /*#__PURE__*/React.createElement("div", {
      className: "msg-group"
    }, /*#__PURE__*/React.createElement("div", {
      className: `msg-bubble ${m.direction}${reactions.length ? ' has-reactions' : ''}`,
      onContextMenu: e => {
        e.preventDefault();
        setActionTarget(m);
      },
      onTouchStart: () => startPress(m),
      onTouchEnd: endPress,
      onTouchMove: endPress
    }, m.reply_to_message_id && /*#__PURE__*/React.createElement("div", {
      className: "msg-reply-quote"
    }, /*#__PURE__*/React.createElement("span", {
      className: "msg-reply-bar"
    }), original ? messagePreviewText(original, 80) : 'Original message'), media.map((med, i) => {
      const isImg = !med.content_type || med.content_type.startsWith('image/');
      return isImg ? /*#__PURE__*/React.createElement("img", {
        key: i,
        className: "msg-img",
        src: med.url,
        alt: "attachment",
        loading: "lazy",
        onClick: e => {
          e.stopPropagation();
          setLightbox(med.url);
        }
      }) : /*#__PURE__*/React.createElement("a", {
        key: i,
        href: med.url,
        target: "_blank",
        rel: "noreferrer",
        className: "msg-file"
      }, "\uD83D\uDCCE Attachment");
    }), m.body && /*#__PURE__*/React.createElement("div", {
      className: "msg-text"
    }, m.body), reactions.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: `msg-reactions ${m.direction}`
    }, reactions.map((r, i) => /*#__PURE__*/React.createElement("span", {
      key: i,
      title: `${r.source === 'customer' ? 'Customer' : 'You'}: ${r.type}`
    }, TAPBACK_EMOJI[r.type] || '❤️')))), /*#__PURE__*/React.createElement("div", {
      className: `msg-meta ${m.direction}`
    }, formatTime(m.created_at), m.direction === 'outbound' && m.status && (() => {
      const meta = messageStatusMeta(m.status);
      return /*#__PURE__*/React.createElement("span", {
        title: meta.title,
        style: {
          marginLeft: '0.375rem',
          color: meta.color
        }
      }, meta.label);
    })())));
  }), /*#__PURE__*/React.createElement("div", {
    ref: messagesEndRef
  })), /*#__PURE__*/React.createElement("div", {
    className: "compose-area"
  }, replyTarget && /*#__PURE__*/React.createElement("div", {
    className: "reply-bar"
  }, /*#__PURE__*/React.createElement("div", {
    className: "reply-bar-body"
  }, /*#__PURE__*/React.createElement("span", {
    className: "reply-bar-label"
  }, "Replying to"), /*#__PURE__*/React.createElement("span", {
    className: "reply-bar-text"
  }, messagePreviewText(replyTarget, 70))), /*#__PURE__*/React.createElement("button", {
    className: "reply-bar-close",
    onClick: () => setReplyTarget(null)
  }, "\u2715")), (attachments || []).length > 0 && /*#__PURE__*/React.createElement("div", {
    className: "attach-strip"
  }, attachments.map(a => /*#__PURE__*/React.createElement("div", {
    key: a.id,
    className: "attach-thumb"
  }, a.status === 'processing' ? /*#__PURE__*/React.createElement("span", {
    className: "spinner",
    style: {
      width: 16,
      height: 16
    }
  }) : /*#__PURE__*/React.createElement("img", {
    src: a.previewUrl,
    alt: "attachment preview"
  }), /*#__PURE__*/React.createElement("button", {
    className: "attach-remove",
    onClick: () => onRemoveAttachment(a.id)
  }, "\u2715")))), /*#__PURE__*/React.createElement("div", {
    className: "compose-row"
  }, /*#__PURE__*/React.createElement("button", {
    className: "attach-btn",
    title: "Attach a picture",
    onClick: () => fileInputRef.current?.click(),
    disabled: (attachments || []).length >= 4
  }, "\uFF0B"), /*#__PURE__*/React.createElement("input", {
    ref: fileInputRef,
    type: "file",
    accept: "image/*",
    multiple: true,
    style: {
      display: 'none'
    },
    onChange: e => {
      onPickFiles(e.target.files);
      e.target.value = '';
    }
  }), /*#__PURE__*/React.createElement("textarea", {
    ref: inputRef,
    className: "compose-input",
    placeholder: "Type a message\u2026",
    value: input,
    onChange: e => {
      setInput(e.target.value);
      e.target.style.height = 'auto';
      e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
    },
    onKeyDown: onKeyDown,
    rows: 1
  }), /*#__PURE__*/React.createElement("button", {
    className: "send-btn",
    onClick: onSend,
    disabled: !canSend
  }, sending ? /*#__PURE__*/React.createElement("span", {
    className: "spinner",
    style: {
      width: '14px',
      height: '14px',
      borderTopColor: '#030712'
    }
  }) : '↑')), /*#__PURE__*/React.createElement("div", {
    className: "compose-footer"
  }, /*#__PURE__*/React.createElement("span", {
    className: `char-counter${cc.isWarning ? ' warning' : ''}${cc.isDanger ? ' danger' : ''}`
  }, cc.chars, "/160"), /*#__PURE__*/React.createElement("span", null, readyAttachments.length > 0 ? `MMS · ${readyAttachments.length} image${readyAttachments.length > 1 ? 's' : ''}` : `${cc.segments} SMS`))))), actionTarget && /*#__PURE__*/React.createElement("div", {
    className: "msg-action-overlay",
    onClick: () => setActionTarget(null)
  }, /*#__PURE__*/React.createElement("div", {
    className: "msg-action-sheet",
    onClick: e => e.stopPropagation()
  }, /*#__PURE__*/React.createElement("div", {
    className: "msg-action-preview"
  }, messagePreviewText(actionTarget, 90)), actionTarget.direction === 'inbound' && actionTarget.id && /*#__PURE__*/React.createElement("div", {
    className: "tapback-row"
  }, Object.entries(TAPBACK_EMOJI).map(([type, emoji]) => {
    const active = (actionTarget.reactions || []).some(r => r.type === type && r.source === 'operator');
    return /*#__PURE__*/React.createElement("button", {
      key: type,
      className: `tapback-btn${active ? ' active' : ''}`,
      onClick: () => {
        onReact(actionTarget, type);
        setActionTarget(null);
      }
    }, emoji);
  })), /*#__PURE__*/React.createElement("button", {
    className: "msg-action-btn",
    onClick: () => {
      setReplyTarget(actionTarget);
      setActionTarget(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, "\u21A9 \xA0Reply"), /*#__PURE__*/React.createElement("button", {
    className: "msg-action-btn",
    onClick: () => {
      if (navigator.clipboard && actionTarget.body) navigator.clipboard.writeText(actionTarget.body).catch(() => {});
      setActionTarget(null);
    }
  }, "\u29C9 \xA0Copy"), /*#__PURE__*/React.createElement("button", {
    className: "msg-action-btn cancel",
    onClick: () => setActionTarget(null)
  }, "Cancel"))), lightbox && /*#__PURE__*/React.createElement("div", {
    className: "lightbox",
    onClick: () => setLightbox(null)
  }, /*#__PURE__*/React.createElement("img", {
    src: lightbox,
    alt: "full size"
  })));
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
    return d.toLocaleTimeString('en-US', {
      timeZone: TZ,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }
  if (diffDays < 7) {
    return d.toLocaleDateString('en-US', {
      timeZone: TZ,
      weekday: 'short'
    }) + ' ' + d.toLocaleTimeString('en-US', {
      timeZone: TZ,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  }
  return d.toLocaleDateString('en-US', {
    timeZone: TZ,
    month: 'short',
    day: 'numeric'
  });
}
function ConvRow({
  contact: c,
  active,
  onClick
}) {
  const preview = c.lastMessage ? (c.lastMessage.direction === 'outbound' ? '↗ ' : '') + (messagePreviewText(c.lastMessage, 40) || truncate(c.lastMessage.body, 40)) : 'No messages yet';
  const orderStatus = c.latest_order_status || 'none';
  const timestamp = smartTime(c.lastMessage?.created_at || c.latest_order_date || c.last_seen);
  const isUnread = (c.unread_count || 0) > 0;
  return /*#__PURE__*/React.createElement("div", {
    className: `conv-row${active ? ' active' : ''}`,
    onClick: onClick
  }, /*#__PURE__*/React.createElement("div", {
    className: "conv-avatar",
    style: {
      position: 'relative'
    }
  }, getInitials(c), /*#__PURE__*/React.createElement("span", {
    className: `order-dot ${orderStatus}`
  }), isUnread && /*#__PURE__*/React.createElement("span", {
    style: {
      position: 'absolute',
      top: -2,
      right: -2,
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: '#3b82f6',
      border: '2px solid var(--bg)',
      display: 'block'
    }
  })), /*#__PURE__*/React.createElement("div", {
    className: "conv-body"
  }, /*#__PURE__*/React.createElement("div", {
    className: "conv-name",
    style: {
      fontWeight: isUnread ? 700 : undefined,
      color: isUnread ? 'var(--text)' : undefined
    }
  }, c.name || c.phone), /*#__PURE__*/React.createElement("div", {
    className: "conv-preview"
  }, preview)), /*#__PURE__*/React.createElement("div", {
    className: "conv-side"
  }, /*#__PURE__*/React.createElement("span", {
    className: "conv-time"
  }, timestamp), isUnread && /*#__PURE__*/React.createElement("span", {
    className: "unread-pill"
  }, c.unread_count > 99 ? '99+' : c.unread_count)));
}

// ─── Activity Tab Components ──────────────────────────────────────────────────

function flowBadgeStyle(flowType) {
  if (!flowType) return {
    bg: 'var(--surface2)',
    color: 'var(--text3)'
  };
  if (flowType.startsWith('failed')) return {
    bg: 'rgba(248,113,113,0.12)',
    color: 'var(--red)'
  };
  if (flowType.startsWith('hold')) return {
    bg: 'rgba(251,191,36,0.12)',
    color: 'var(--yellow)'
  };
  if (flowType.startsWith('confirmed')) return {
    bg: 'rgba(0,245,160,0.08)',
    color: 'var(--accent)'
  };
  if (flowType.startsWith('shipped') || flowType.startsWith('delivered')) return {
    bg: 'rgba(0,245,160,0.12)',
    color: 'var(--accent)'
  };
  return {
    bg: 'var(--surface2)',
    color: 'var(--text3)'
  };
}
function FlowBadge({
  flowType
}) {
  const {
    bg,
    color
  } = flowBadgeStyle(flowType);
  return /*#__PURE__*/React.createElement("span", {
    style: {
      background: bg,
      color,
      fontSize: '0.625rem',
      fontFamily: 'var(--mono)',
      padding: '2px 6px',
      borderRadius: 3,
      whiteSpace: 'nowrap',
      letterSpacing: '0.03em'
    }
  }, flowType || 'unknown');
}
function useCountdown(sendAt) {
  const [remaining, setRemaining] = useState('');
  useEffect(() => {
    const tick = () => {
      const diff = new Date(sendAt) - new Date();
      if (diff <= 0) {
        setRemaining('firing...');
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor(diff % 3600000 / 60000);
      const s = Math.floor(diff % 60000 / 1000);
      if (h > 0) setRemaining(`${h}h ${m}m`);else if (m > 0) setRemaining(`${m}m ${s}s`);else setRemaining(`${s}s`);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [sendAt]);
  return remaining;
}
function QueueRow({
  item,
  onCancel
}) {
  const countdown = useCountdown(item.send_at);
  const displayName = item.contact_name || '...' + (item.phone?.slice(-4) || '');
  const preview = item.message_body ? item.message_body.length > 70 ? item.message_body.slice(0, 70) + '...' : item.message_body : '';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'flex-start',
      gap: '0.625rem',
      padding: '0.75rem 1rem',
      borderBottom: '1px solid var(--border)',
      minHeight: 56
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.375rem',
      marginBottom: '0.25rem',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text)',
      fontSize: '0.8125rem',
      fontWeight: 600
    }
  }, displayName), /*#__PURE__*/React.createElement(FlowBadge, {
    flowType: item.flow_type
  }), item.order_id && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text3)',
      fontSize: '0.65rem',
      fontFamily: 'var(--mono)'
    }
  }, "#", item.order_id)), /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--text3)',
      fontSize: '0.7rem',
      fontFamily: 'var(--mono)',
      lineHeight: 1.4
    }
  }, preview)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'flex-end',
      gap: '0.375rem',
      flexShrink: 0,
      paddingTop: 2
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--yellow)',
      fontSize: '0.7rem',
      fontFamily: 'var(--mono)',
      whiteSpace: 'nowrap'
    }
  }, countdown), /*#__PURE__*/React.createElement("button", {
    onClick: () => onCancel(item),
    style: {
      background: 'transparent',
      border: '1px solid rgba(248,113,113,0.4)',
      color: 'var(--red)',
      padding: '3px 9px',
      borderRadius: 5,
      fontSize: '0.65rem',
      cursor: 'pointer',
      fontFamily: 'var(--mono)',
      whiteSpace: 'nowrap'
    }
  }, "cancel")));
}
function CancelModal({
  target,
  onConfirm,
  onDismiss,
  cancelling
}) {
  if (!target) return null;
  const displayName = target.contact_name || '...' + (target.phone?.slice(-4) || '');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.85)',
      zIndex: 1000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '1rem'
    },
    onClick: e => {
      if (e.target === e.currentTarget) onDismiss();
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 8,
      padding: '1.5rem',
      maxWidth: 480,
      width: '100%',
      maxHeight: '90vh',
      overflowY: 'auto'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--text)',
      fontSize: '1rem',
      fontWeight: 600,
      marginBottom: '1rem'
    }
  }, "Cancel this message?"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
      marginBottom: '0.75rem',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text)',
      fontWeight: 500
    }
  }, displayName), /*#__PURE__*/React.createElement(FlowBadge, {
    flowType: target.flow_type
  }), target.order_id && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text2)',
      fontSize: '0.75rem',
      fontFamily: 'var(--mono)'
    }
  }, "#", target.order_id)), /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '0.75rem',
      fontSize: '0.75rem',
      color: 'var(--text2)',
      fontFamily: 'var(--mono)',
      whiteSpace: 'pre-wrap',
      marginBottom: '0.75rem',
      lineHeight: 1.6
    }
  }, target.message_body), /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--text2)',
      fontSize: '0.75rem',
      marginBottom: '1.25rem'
    }
  }, "Would send: ", target.send_at ? new Date(target.send_at).toLocaleString('en-US', {
    timeZone: TZ
  }) : ''), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: '0.75rem'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onConfirm,
    disabled: cancelling,
    style: {
      flex: 1,
      background: '#ef4444',
      color: '#fff',
      border: 'none',
      padding: '0.625rem',
      borderRadius: 6,
      fontSize: '0.875rem',
      cursor: 'pointer',
      fontWeight: 500
    }
  }, cancelling ? /*#__PURE__*/React.createElement("span", {
    className: "spinner",
    style: {
      borderTopColor: '#fff'
    }
  }) : 'Yes, cancel it'), /*#__PURE__*/React.createElement("button", {
    onClick: onDismiss,
    style: {
      flex: 1,
      background: 'var(--border)',
      color: 'var(--text2)',
      border: 'none',
      padding: '0.625rem',
      borderRadius: 6,
      fontSize: '0.875rem',
      cursor: 'pointer'
    }
  }, "Keep it"))));
}
function RecentRow({
  item
}) {
  const [expanded, setExpanded] = useState(false);
  const displayName = item.contact_name || '...' + (item.phone?.slice(-4) || '');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      borderBottom: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.75rem',
      padding: '0.625rem 1rem',
      cursor: 'pointer'
    },
    onClick: () => setExpanded(e => !e)
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
      flexWrap: 'wrap'
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text)',
      fontSize: '0.8125rem',
      fontWeight: 500
    }
  }, displayName), /*#__PURE__*/React.createElement(FlowBadge, {
    flowType: item.flow_type
  }), item.order_id && /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text2)',
      fontSize: '0.7rem',
      fontFamily: 'var(--mono)'
    }
  }, "#", item.order_id))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: '0.5rem',
      flexShrink: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text2)',
      fontSize: '0.7rem',
      fontFamily: 'var(--mono)'
    }
  }, relativeTime(item.sent_at)), /*#__PURE__*/React.createElement("span", {
    style: {
      color: 'var(--text2)',
      fontSize: '0.75rem'
    }
  }, expanded ? '▲' : '▼'))), expanded && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 1rem 0.75rem',
      borderTop: '1px solid var(--border)'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--bg)',
      border: '1px solid var(--border)',
      borderRadius: 6,
      padding: '0.625rem',
      fontSize: '0.75rem',
      color: 'var(--text2)',
      fontFamily: 'var(--mono)',
      whiteSpace: 'pre-wrap',
      lineHeight: 1.6,
      marginBottom: '0.375rem'
    }
  }, item.message_body), item.telnyx_message_id && /*#__PURE__*/React.createElement("div", {
    style: {
      color: 'var(--text2)',
      fontSize: '0.65rem',
      fontFamily: 'var(--mono)'
    }
  }, "ID: ", item.telnyx_message_id)));
}
function LiveFeed({
  events
}) {
  return /*#__PURE__*/React.createElement("div", null, events.length === 0 ? /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '1.25rem',
      color: 'var(--text2)',
      fontSize: '0.75rem',
      fontFamily: 'var(--mono)',
      textAlign: 'center'
    }
  }, "// waiting for events") : events.map((ev, i) => {
    const dotColor = ev.type === 'message_sent' ? 'var(--accent)' : ev.type === 'queue_cancelled' ? 'var(--red)' : ev.type === 'new_message' ? 'var(--blue)' : 'var(--yellow)';
    const name = ev.contact_name || (ev.phone ? '...' + ev.phone.slice(-4) : '');
    const label = ev.type === 'queue_added' ? `queued ${ev.flow_type || ''} for ${name}` : ev.type === 'message_sent' ? `sent ${ev.flow_type || ''} to ${name}` : ev.type === 'queue_cancelled' ? `cancelled ${ev.flow_type || ''} for ${name}` : ev.type === 'new_message' ? `inbound SMS from ${name}` : ev.type;
    return /*#__PURE__*/React.createElement("div", {
      key: i,
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '0.5rem',
        padding: '0.5rem 1rem',
        borderBottom: '1px solid var(--border)',
        borderLeft: `3px solid ${dotColor}`
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--text)',
        fontSize: '0.75rem',
        fontFamily: 'var(--mono)',
        flex: 1
      }
    }, label), /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--text2)',
        fontSize: '0.65rem',
        fontFamily: 'var(--mono)',
        flexShrink: 0
      }
    }, relativeTime(ev.ts)));
  }));
}
function StatCard({
  label,
  value,
  color
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      background: 'var(--surface)',
      border: '1px solid var(--border)',
      borderRadius: 10,
      padding: '0.75rem 0.5rem',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '1.5rem',
      fontWeight: 700,
      color,
      fontFamily: 'var(--mono)',
      lineHeight: 1
    }
  }, value), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: '0.6rem',
      color: 'var(--text3)',
      marginTop: '0.3rem',
      letterSpacing: '0.06em',
      textTransform: 'uppercase'
    }
  }, label));
}
const FLOW_FILTERS = [{
  value: 'all',
  label: 'All'
}, {
  value: 'failed-msg1',
  label: 'Failed 1'
}, {
  value: 'failed-msg2',
  label: 'Failed 2'
}, {
  value: 'failed-msg3',
  label: 'Failed 3'
}, {
  value: 'hold-msg1',
  label: 'Hold 1'
}, {
  value: 'hold-msg2',
  label: 'Hold 2'
}, {
  value: 'hold-msg3',
  label: 'Hold 3'
}, {
  value: 'hold-failed-nudge',
  label: 'Nudge'
}, {
  value: 'confirmed-new',
  label: 'New'
}, {
  value: 'confirmed-returning',
  label: 'Return'
}, {
  value: 'shipped-msg1',
  label: 'Shipped'
}, {
  value: 'delivered-msg1',
  label: 'Delivered'
}];
function ActivityTab({
  sseStatus
}) {
  const [stats, setStats] = useState({
    pending: 0,
    sentToday: 0,
    failedToday: 0,
    cancelledToday: 0
  });
  const [queue, setQueue] = useState([]);
  const [recent, setRecent] = useState([]);
  const [flowFilter, setFlowFilter] = useState('all');
  const [cancelTarget, setCancelTarget] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  const [loading, setLoading] = useState(true);
  const [liveEvents, setLiveEvents] = useState([]);
  const [queuePage, setQueuePage] = useState(1);
  const [queueHasMore, setQueueHasMore] = useState(false);
  const [recentPage, setRecentPage] = useState(1);
  const [recentHasMore, setRecentHasMore] = useState(false);
  const isMobile = useIsMobile();
  const currentFilter = useRef(flowFilter);
  currentFilter.current = flowFilter;
  async function loadAll(filter, qPage, rPage) {
    const f = filter ?? flowFilter;
    const qp = qPage ?? 1;
    const rp = rPage ?? 1;
    try {
      const [s, q, r] = await Promise.all([api('GET', '/api/activity/stats'), api('GET', `/api/activity/queue?flow=${f}&page=${qp}`), api('GET', `/api/activity/recent?flow=${f}&page=${rp}`)]);
      setStats(s);
      if (qp === 1) setQueue(q.items || []);else setQueue(prev => [...prev, ...(q.items || [])]);
      setQueueHasMore(q.hasMore || false);
      if (rp === 1) setRecent(r.items || []);else setRecent(prev => [...prev, ...(r.items || [])]);
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
      const event = {
        ...e.detail,
        ts: new Date().toISOString()
      };
      const activityTypes = ['queue_added', 'queue_cancelled', 'message_sent', 'new_message'];
      if (activityTypes.includes(event.type)) {
        setLiveEvents(prev => [event, ...prev].slice(0, 20));
      }
      switch (event.type) {
        case 'queue_added':
          setQueue(prev => {
            if (prev.some(m => m.id === event.id)) return prev;
            const newItem = {
              id: event.id,
              order_id: event.order_id,
              phone: event.phone,
              flow_type: event.flow_type,
              send_at: event.send_at,
              message_body: '',
              contact_name: null
            };
            return [...prev, newItem].sort((a, b) => new Date(a.send_at) - new Date(b.send_at));
          });
          setStats(prev => ({
            ...prev,
            pending: prev.pending + 1
          }));
          break;
        case 'queue_cancelled':
          setQueue(prev => prev.filter(m => m.id !== event.id));
          setStats(prev => ({
            ...prev,
            pending: Math.max(0, prev.pending - 1),
            cancelledToday: prev.cancelledToday + 1
          }));
          break;
        case 'message_sent':
          setQueue(prev => prev.filter(m => m.id !== event.id));
          setStats(prev => ({
            ...prev,
            pending: Math.max(0, prev.pending - 1),
            sentToday: prev.sentToday + 1
          }));
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
      setStats(prev => ({
        ...prev,
        pending: Math.max(0, prev.pending - 1),
        cancelledToday: prev.cancelledToday + 1
      }));
    } catch (err) {
      console.error('[Activity] cancel error:', err.message);
    } finally {
      setCancelling(false);
      setCancelTarget(null);
    }
  }
  const sectionStyle = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    overflow: 'hidden'
  };
  const sectionHdr = {
    padding: '0.625rem 1rem',
    borderBottom: '1px solid var(--border)',
    fontSize: '0.65rem',
    fontFamily: 'var(--mono)',
    color: 'var(--text3)',
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  };
  const loadMoreBtn = {
    background: 'none',
    border: '1px solid var(--border)',
    color: 'var(--text3)',
    padding: '5px 16px',
    borderRadius: 5,
    cursor: 'pointer',
    fontSize: '0.7rem',
    fontFamily: 'var(--mono)'
  };
  return (
    /*#__PURE__*/
    // Outer shell — fills .main-content, clips to viewport bounds
    React.createElement("div", {
      style: {
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        minHeight: 0
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        flex: 1,
        overflowY: 'auto',
        overflowX: 'hidden',
        WebkitOverflowScrolling: 'touch',
        overscrollBehavior: 'contain'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        padding: isMobile ? '0.75rem' : '1.25rem 1.5rem',
        maxWidth: 900,
        margin: '0 auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.875rem',
        paddingBottom: isMobile ? '1.5rem' : '2rem'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'grid',
        gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)',
        gap: '0.5rem'
      }
    }, /*#__PURE__*/React.createElement(StatCard, {
      label: "Pending",
      value: stats.pending,
      color: "var(--yellow)"
    }), /*#__PURE__*/React.createElement(StatCard, {
      label: "Sent today",
      value: stats.sentToday,
      color: "var(--accent)"
    }), /*#__PURE__*/React.createElement(StatCard, {
      label: "Failed today",
      value: stats.failedToday,
      color: "var(--red)"
    }), /*#__PURE__*/React.createElement(StatCard, {
      label: "Cancelled today",
      value: stats.cancelledToday,
      color: "var(--text2)"
    })), /*#__PURE__*/React.createElement("div", {
      style: {
        overflowX: 'auto',
        WebkitOverflowScrolling: 'touch',
        paddingBottom: '4px',
        marginBottom: '-4px'
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        display: 'flex',
        gap: '0.375rem',
        minWidth: 'max-content',
        paddingBottom: '2px'
      }
    }, FLOW_FILTERS.map(f => /*#__PURE__*/React.createElement("button", {
      key: f.value,
      onClick: () => setFlowFilter(f.value),
      style: {
        padding: '5px 11px',
        borderRadius: 20,
        cursor: 'pointer',
        fontSize: '0.675rem',
        fontFamily: 'var(--mono)',
        whiteSpace: 'nowrap',
        fontWeight: 600,
        letterSpacing: '0.03em',
        border: flowFilter === f.value ? '1px solid var(--accent)' : '1px solid var(--border)',
        background: flowFilter === f.value ? 'var(--accent-dim)' : 'transparent',
        color: flowFilter === f.value ? 'var(--accent)' : 'var(--text3)'
      }
    }, f.label)))), /*#__PURE__*/React.createElement("div", {
      style: sectionStyle
    }, /*#__PURE__*/React.createElement("div", {
      style: sectionHdr
    }, /*#__PURE__*/React.createElement("span", null, "// queue (", queue.length, queueHasMore ? '+' : '', ")"), /*#__PURE__*/React.createElement("span", {
      style: {
        color: sseStatus === 'connected' ? 'var(--accent)' : 'var(--yellow)',
        fontSize: '0.6rem',
        fontFamily: 'var(--mono)'
      }
    }, sseStatus === 'connected' ? '● live' : '○ ' + sseStatus)), loading ? /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '2rem',
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "spinner"
    })) : queue.length === 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '1.5rem',
        color: 'var(--text3)',
        fontSize: '0.75rem',
        fontFamily: 'var(--mono)',
        textAlign: 'center'
      }
    }, "// queue is empty") : /*#__PURE__*/React.createElement(React.Fragment, null, queue.map(item => /*#__PURE__*/React.createElement(QueueRow, {
      key: item.id,
      item: item,
      onCancel: setCancelTarget
    })), queueHasMore && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '0.625rem',
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: loadMoreBtn,
      onClick: () => {
        const n = queuePage + 1;
        setQueuePage(n);
        loadAll(flowFilter, n, recentPage);
      }
    }, "load more")))), /*#__PURE__*/React.createElement("div", {
      style: sectionStyle
    }, /*#__PURE__*/React.createElement("div", {
      style: sectionHdr
    }, /*#__PURE__*/React.createElement("span", null, "// recent sends")), loading ? /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '2rem',
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("span", {
      className: "spinner"
    })) : recent.length === 0 ? /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '1.5rem',
        color: 'var(--text3)',
        fontSize: '0.75rem',
        fontFamily: 'var(--mono)',
        textAlign: 'center'
      }
    }, "// no messages sent yet") : /*#__PURE__*/React.createElement(React.Fragment, null, recent.map(item => /*#__PURE__*/React.createElement(RecentRow, {
      key: item.id,
      item: item
    })), recentHasMore && /*#__PURE__*/React.createElement("div", {
      style: {
        padding: '0.625rem',
        textAlign: 'center'
      }
    }, /*#__PURE__*/React.createElement("button", {
      style: loadMoreBtn,
      onClick: () => {
        const n = recentPage + 1;
        setRecentPage(n);
        loadAll(flowFilter, queuePage, n);
      }
    }, "load more")))), /*#__PURE__*/React.createElement("div", {
      style: sectionStyle
    }, /*#__PURE__*/React.createElement("div", {
      style: sectionHdr
    }, /*#__PURE__*/React.createElement("span", null, "// live feed"), /*#__PURE__*/React.createElement("span", {
      style: {
        color: 'var(--text3)',
        fontSize: '0.6rem',
        fontFamily: 'var(--mono)'
      }
    }, liveEvents.length, " events")), /*#__PURE__*/React.createElement(LiveFeed, {
      events: liveEvents
    })))), /*#__PURE__*/React.createElement(CancelModal, {
      target: cancelTarget,
      onConfirm: handleCancelConfirm,
      onDismiss: () => setCancelTarget(null),
      cancelling: cancelling
    }))
  );
}

// ─── Voice Components ─────────────────────────────────────────────────────────

function CallConfirmModal({
  target,
  onConfirm,
  onCancel
}) {
  if (!target) return null;
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 2000
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 12,
      padding: 28,
      minWidth: 280,
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: '#9ca3af',
      marginBottom: 8,
      letterSpacing: '0.1em',
      textTransform: 'uppercase'
    }
  }, "Calling"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 20,
      fontWeight: 600,
      color: '#fff',
      marginBottom: 4
    }
  }, target.name !== target.phone ? target.name : target.phone), target.name !== target.phone && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: '#9ca3af',
      marginBottom: 24
    }
  }, target.phone), target.name === target.phone && /*#__PURE__*/React.createElement("div", {
    style: {
      marginBottom: 24
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      justifyContent: 'center'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onConfirm,
    style: {
      background: '#16a34a',
      border: 'none',
      borderRadius: 8,
      padding: '12px 24px',
      color: '#fff',
      fontSize: 14,
      fontWeight: 600,
      cursor: 'pointer'
    }
  }, "Call"), /*#__PURE__*/React.createElement("button", {
    onClick: onCancel,
    style: {
      background: 'none',
      border: '1px solid #2a2a2a',
      borderRadius: 8,
      padding: '12px 24px',
      color: '#9ca3af',
      fontSize: 14,
      cursor: 'pointer'
    }
  }, "Cancel"))));
}
function ActiveCallPanel({
  callState,
  onAnswer,
  onHangup,
  onMute,
  onRecord,
  onSpeaker,
  isSpeaker,
  formatDuration
}) {
  if (callState.status === 'idle') return null;
  const isInbound = callState.direction === 'inbound';
  const isRinging = callState.status === 'ringing';
  const isActive = callState.status === 'active';
  const isEnded = callState.status === 'ended';
  return /*#__PURE__*/React.createElement("div", {
    style: {
      position: 'fixed',
      bottom: 80,
      left: '50%',
      transform: 'translateX(-50%)',
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 16,
      padding: '20px 28px',
      minWidth: 290,
      zIndex: 1500,
      boxShadow: '0 8px 32px rgba(0,0,0,0.6)',
      textAlign: 'center'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#9ca3af',
      marginBottom: 6,
      letterSpacing: '0.12em',
      textTransform: 'uppercase'
    }
  }, isRinging && isInbound ? 'Incoming call' : isRinging && !isInbound ? 'Calling...' : isActive ? 'On call' : 'Call ended'), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 18,
      fontWeight: 600,
      color: '#fff',
      marginBottom: 2
    }
  }, callState.contactName || callState.contactPhone), callState.contactName && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 13,
      color: '#9ca3af',
      marginBottom: 12
    }
  }, callState.contactPhone), isActive && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 22,
      fontWeight: 700,
      color: '#16a34a',
      marginBottom: 16
    }
  }, formatDuration(callState.duration)), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 12,
      justifyContent: 'center',
      flexWrap: 'wrap'
    }
  }, isRinging && isInbound && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    onClick: onAnswer,
    style: {
      background: '#16a34a',
      border: 'none',
      borderRadius: '50%',
      width: 56,
      height: 56,
      color: '#fff',
      fontSize: 22,
      cursor: 'pointer',
      animation: 'callPulse 1.2s infinite'
    }
  }, "\uD83D\uDCDE"), /*#__PURE__*/React.createElement("button", {
    onClick: onHangup,
    style: {
      background: '#ef4444',
      border: 'none',
      borderRadius: '50%',
      width: 56,
      height: 56,
      color: '#fff',
      fontSize: 22,
      cursor: 'pointer'
    }
  }, "\uD83D\uDCF5")), isActive && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("button", {
    onClick: onMute,
    style: {
      background: callState.isMuted ? '#ef4444' : '#2a2a2a',
      border: 'none',
      borderRadius: '50%',
      width: 48,
      height: 48,
      color: '#fff',
      fontSize: 18,
      cursor: 'pointer'
    },
    title: callState.isMuted ? 'Unmute' : 'Mute'
  }, callState.isMuted ? '🔇' : '🎤'), /*#__PURE__*/React.createElement("button", {
    onClick: onSpeaker,
    style: {
      background: isSpeaker ? '#2563eb' : '#2a2a2a',
      border: 'none',
      borderRadius: '50%',
      width: 48,
      height: 48,
      color: '#fff',
      fontSize: 18,
      cursor: 'pointer'
    },
    title: isSpeaker ? 'Speaker on' : 'Speaker off'
  }, "\uD83D\uDD0A"), /*#__PURE__*/React.createElement("button", {
    onClick: onRecord,
    style: {
      background: callState.isRecording ? '#ef4444' : '#2a2a2a',
      border: 'none',
      borderRadius: '50%',
      width: 48,
      height: 48,
      color: '#fff',
      fontSize: 18,
      cursor: 'pointer'
    },
    title: callState.isRecording ? 'Stop recording' : 'Start recording'
  }, callState.isRecording ? '⏹' : '⏺'), /*#__PURE__*/React.createElement("button", {
    onClick: onHangup,
    style: {
      background: '#ef4444',
      border: 'none',
      borderRadius: '50%',
      width: 48,
      height: 48,
      color: '#fff',
      fontSize: 22,
      cursor: 'pointer'
    }
  }, "\uD83D\uDCF5")), isRinging && !isInbound && /*#__PURE__*/React.createElement("button", {
    onClick: onHangup,
    style: {
      background: '#ef4444',
      border: 'none',
      borderRadius: '50%',
      width: 56,
      height: 56,
      color: '#fff',
      fontSize: 22,
      cursor: 'pointer'
    }
  }, "\uD83D\uDCF5"), isEnded && /*#__PURE__*/React.createElement("div", {
    style: {
      color: '#9ca3af',
      fontSize: 14,
      padding: '8px 0'
    }
  }, "Call ended")));
}
function DialerSection({
  dialNumber,
  setDialNumber,
  onCall,
  voiceReady
}) {
  const KEYPAD = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['*', '0', '#']];
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: 24,
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 28,
      fontWeight: 300,
      color: '#fff',
      minHeight: 44,
      marginBottom: 24,
      letterSpacing: '0.08em',
      textAlign: 'center'
    }
  }, dialNumber || /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#9ca3af',
      fontSize: 16
    }
  }, "Enter a number")), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: 'repeat(3, 72px)',
      gap: 12,
      marginBottom: 24
    }
  }, KEYPAD.flat().map(key => /*#__PURE__*/React.createElement("button", {
    key: key,
    onClick: () => setDialNumber(prev => prev + key),
    style: {
      width: 72,
      height: 72,
      borderRadius: '50%',
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      color: '#fff',
      fontSize: 20,
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, key))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 16,
      alignItems: 'center'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: () => setDialNumber(prev => prev.slice(0, -1)),
    disabled: !dialNumber,
    style: {
      width: 48,
      height: 48,
      borderRadius: '50%',
      background: 'none',
      border: 'none',
      color: '#9ca3af',
      fontSize: 20,
      cursor: 'pointer'
    }
  }, "\u232B"), /*#__PURE__*/React.createElement("button", {
    onClick: () => dialNumber && onCall(dialNumber, null),
    disabled: !dialNumber || !voiceReady,
    style: {
      width: 72,
      height: 72,
      borderRadius: '50%',
      background: !dialNumber || !voiceReady ? '#1a1a1a' : '#16a34a',
      border: 'none',
      color: '#fff',
      fontSize: 28,
      cursor: !dialNumber || !voiceReady ? 'default' : 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center'
    }
  }, "\uD83D\uDCDE"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setDialNumber(prev => prev + '+'),
    style: {
      width: 48,
      height: 48,
      borderRadius: '50%',
      background: 'none',
      border: '1px solid #2a2a2a',
      color: '#9ca3af',
      fontSize: 18,
      cursor: 'pointer',
      fontWeight: 700
    }
  }, "+")));
}
function CallLogRow({
  log,
  icon,
  phone,
  isUnknown,
  knownName,
  durStr,
  onCall,
  onCreateContact,
  onGoToMessages
}) {
  const [expanded, setExpanded] = useState(false);
  return /*#__PURE__*/React.createElement("div", {
    style: {
      borderBottom: '1px solid #1a1a1a'
    }
  }, /*#__PURE__*/React.createElement("div", {
    onClick: () => setExpanded(e => !e),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '12px 16px',
      cursor: 'pointer'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 36,
      height: 36,
      borderRadius: '50%',
      background: '#1a1a1a',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: 16,
      color: icon.color,
      flexShrink: 0
    }
  }, icon.icon), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      color: isUnknown ? '#9ca3af' : '#fff',
      marginBottom: 2
    }
  }, knownName || phone), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: log.status === 'missed' ? '#ef4444' : '#6b7280',
      fontWeight: log.status === 'missed' ? 600 : 400
    }
  }, !isUnknown && knownName && /*#__PURE__*/React.createElement("span", {
    style: {
      marginRight: 6
    }
  }, phone), log.status, durStr ? ` · ${durStr}` : '', " \xB7 ", relativeTime(log.started_at), log.recording_url_mp3 && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: 6,
      color: '#3b82f6'
    }
  }, "\u25CF REC"))), /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      gap: 8,
      flexShrink: 0
    },
    onClick: e => e.stopPropagation()
  }, !isUnknown && onGoToMessages && /*#__PURE__*/React.createElement("button", {
    onClick: () => onGoToMessages(phone),
    style: {
      background: 'none',
      border: '1px solid #2a2a2a',
      borderRadius: 6,
      padding: '5px 9px',
      color: '#9ca3af',
      cursor: 'pointer',
      fontSize: 11,
      fontWeight: 600
    },
    title: "Open message thread"
  }, "Message"), isUnknown && onCreateContact && /*#__PURE__*/React.createElement("button", {
    onClick: () => onCreateContact(phone),
    style: {
      background: 'none',
      border: '1px solid #16a34a',
      borderRadius: 6,
      padding: '5px 9px',
      color: '#16a34a',
      cursor: 'pointer',
      fontSize: 11,
      fontWeight: 600
    },
    title: "Save as contact"
  }, "+ Contact"), /*#__PURE__*/React.createElement("button", {
    onClick: () => onCall(phone, knownName || null),
    style: {
      background: 'none',
      border: '1px solid #2a2a2a',
      borderRadius: 6,
      padding: '6px 10px',
      color: '#16a34a',
      cursor: 'pointer',
      fontSize: 14
    },
    title: "Call back"
  }, "\uD83D\uDCDE")), /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6b7280',
      fontSize: 12,
      flexShrink: 0
    }
  }, expanded ? '▲' : '▼')), expanded && /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '0 16px 14px 64px',
      display: 'flex',
      flexDirection: 'column',
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: '6px 16px',
      fontSize: 12
    }
  }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6b7280'
    }
  }, "Direction:"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff'
    }
  }, log.direction || '—')), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6b7280'
    }
  }, "Status:"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff'
    }
  }, log.status)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6b7280'
    }
  }, "From:"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff'
    }
  }, log.from_number || '—')), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6b7280'
    }
  }, "To:"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff'
    }
  }, log.to_number || '—')), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6b7280'
    }
  }, "Started:"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff'
    }
  }, formatTime(log.started_at))), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#6b7280'
    }
  }, "Duration:"), " ", /*#__PURE__*/React.createElement("span", {
    style: {
      color: '#fff'
    }
  }, durStr || '0:00'))), log.recording_url_mp3 && /*#__PURE__*/React.createElement("div", {
    style: {
      marginTop: 4
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 11,
      color: '#6b7280',
      marginBottom: 6,
      letterSpacing: '0.08em',
      textTransform: 'uppercase'
    }
  }, "Call Recording"), /*#__PURE__*/React.createElement("audio", {
    controls: true,
    preload: "none",
    src: log.recording_url_mp3,
    style: {
      width: '100%',
      height: 36,
      borderRadius: 6
    }
  })), !log.recording_url_mp3 && /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 12,
      color: '#6b7280',
      fontStyle: 'italic'
    }
  }, "No recording available")));
}
function CallLogsSection({
  logs,
  onCall,
  conversations,
  onCreateContact,
  onGoToMessages
}) {
  const statusIcon = {
    completed: {
      icon: '↗',
      color: '#16a34a'
    },
    missed: {
      icon: '↙',
      color: '#ef4444'
    },
    initiated: {
      icon: '↗',
      color: '#9ca3af'
    },
    failed: {
      icon: '✕',
      color: '#ef4444'
    },
    declined: {
      icon: '✕',
      color: '#ef4444'
    },
    answered: {
      icon: '↔',
      color: '#3b82f6'
    }
  };
  function normPhone(p) {
    if (!p) return '';
    const d = p.replace(/\D/g, '');
    return d.length === 10 ? '1' + d : d;
  }
  const contactPhones = new Set();
  const contactNames = {};
  for (const c of conversations || []) {
    const key = normPhone(c.phone);
    contactPhones.add(key);
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.name || '';
    if (name) contactNames[key] = name;
  }
  if (!logs.length) return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: '#9ca3af',
      fontSize: 14
    }
  }, "No calls yet");
  return /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      overflowY: 'auto'
    }
  }, logs.map(log => {
    const icon = statusIcon[log.status] || {
      icon: '?',
      color: '#9ca3af'
    };
    const rawPhone = log.contact_phone;
    const phone = normalisePhoneFrontend(rawPhone) || rawPhone;
    const nk = normPhone(phone);
    const isUnknown = !contactPhones.has(nk);
    const knownName = contactNames[nk] || null;
    const durStr = log.duration_seconds > 0 ? `${Math.floor(log.duration_seconds / 60).toString().padStart(2, '0')}:${(log.duration_seconds % 60).toString().padStart(2, '0')}` : null;
    return /*#__PURE__*/React.createElement(CallLogRow, {
      key: log.id,
      log: log,
      icon: icon,
      phone: phone,
      isUnknown: isUnknown,
      knownName: knownName,
      durStr: durStr,
      onCall: onCall,
      onCreateContact: onCreateContact,
      onGoToMessages: onGoToMessages
    });
  }));
}
function VoiceTab({
  callLogs,
  dialNumber,
  setDialNumber,
  onCall,
  voiceReady,
  onRetryConnect,
  onDisableCalls,
  conversations,
  onCreateContact,
  onGoToMessages,
  onBackfillRecordings
}) {
  const [activeSection, setActiveSection] = useState('dialer');
  return /*#__PURE__*/React.createElement("div", {
    style: {
      height: '100%',
      display: 'flex',
      flexDirection: 'column'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: 'flex',
      borderBottom: '1px solid #2a2a2a',
      padding: '0 16px'
    }
  }, ['dialer', 'logs'].map(s => /*#__PURE__*/React.createElement("button", {
    key: s,
    onClick: () => setActiveSection(s),
    style: {
      background: 'none',
      border: 'none',
      padding: '14px 16px',
      color: activeSection === s ? '#16a34a' : '#9ca3af',
      borderBottom: activeSection === s ? '2px solid #16a34a' : '2px solid transparent',
      cursor: 'pointer',
      fontSize: 13,
      textTransform: 'capitalize',
      letterSpacing: '0.06em'
    }
  }, s === 'dialer' ? 'Dialer' : 'Call Log')), /*#__PURE__*/React.createElement("div", {
    style: {
      marginLeft: 'auto',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      fontSize: 11,
      color: '#9ca3af'
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 7,
      height: 7,
      borderRadius: '50%',
      background: voiceReady ? '#16a34a' : '#ef4444'
    }
  }), voiceReady ? 'Browser calls enabled' : 'iPhone is primary', !voiceReady && /*#__PURE__*/React.createElement("button", {
    onClick: onRetryConnect,
    style: {
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 6,
      color: '#9ca3af',
      fontSize: 11,
      padding: '3px 8px',
      cursor: 'pointer'
    }
  }, "Enable browser calls"), voiceReady && /*#__PURE__*/React.createElement("button", {
    onClick: onDisableCalls,
    style: {
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 6,
      color: '#9ca3af',
      fontSize: 11,
      padding: '3px 8px',
      cursor: 'pointer'
    }
  }, "Make iPhone primary"))), activeSection === 'dialer' && /*#__PURE__*/React.createElement(DialerSection, {
    dialNumber: dialNumber,
    setDialNumber: setDialNumber,
    onCall: onCall,
    voiceReady: voiceReady
  }), activeSection === 'logs' && /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("div", {
    style: {
      padding: '8px 16px',
      borderBottom: '1px solid #1a1a1a',
      display: 'flex',
      justifyContent: 'flex-end'
    }
  }, /*#__PURE__*/React.createElement("button", {
    onClick: onBackfillRecordings,
    style: {
      background: '#1a1a1a',
      border: '1px solid #2a2a2a',
      borderRadius: 6,
      padding: '5px 12px',
      color: '#3b82f6',
      cursor: 'pointer',
      fontSize: 11,
      fontWeight: 600
    },
    title: "Pull all recordings from Telnyx and match to call logs"
  }, "Sync Recordings")), /*#__PURE__*/React.createElement(CallLogsSection, {
    logs: callLogs,
    onCall: onCall,
    conversations: conversations,
    onCreateContact: onCreateContact,
    onGoToMessages: onGoToMessages
  })));
}

// ─── Main App ─────────────────────────────────────────────────────────────────

function App() {
  const [auth, setAuth] = useState({
    checking: true,
    ok: false
  });
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
  const [contactPrefill, setContactPrefill] = useState(null);
  const [attachments, setAttachments] = useState([]); // pending composer images
  const [replyTarget, setReplyTarget] = useState(null); // message being replied to

  // ── Voice state ──────────────────────────────────────────────────────────────
  const [voiceReady, setVoiceReady] = useState(false);
  const [callState, setCallState] = useState({
    status: 'idle',
    direction: null,
    contactPhone: null,
    contactName: null,
    callControlId: null,
    duration: 0,
    isMuted: false,
    isRecording: false
  });
  const [callLogs, setCallLogs] = useState([]);
  const [dialNumber, setDialNumber] = useState('');
  const [confirmCall, setConfirmCall] = useState(null);
  const [isSpeaker, setIsSpeaker] = useState(false);
  const telnyxClientRef = useRef(null);
  const activeCallRef = useRef(null);
  const durationTimerRef = useRef(null);
  const vibrationIntervalRef = useRef(null);
  const callerNumberRef = useRef('+13054043184');
  const callStartRef = useRef(null);
  const callDirectionRef = useRef('outbound');
  const mainTabRef = useRef(mainTab);
  mainTabRef.current = mainTab;
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
    setToasts(t => [...t, {
      id,
      msg
    }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }
  useEffect(() => {
    api('GET', '/auth/check').then(d => setAuth({
      checking: false,
      ok: d.authenticated
    })).catch(() => setAuth({
      checking: false,
      ok: false
    }));
  }, []);
  const loadConversations = useCallback(async () => {
    try {
      const data = await api('GET', '/api/conversations');
      setConversations(data);
    } catch {}
  }, []);
  const loadThread = useCallback(async phone => {
    try {
      const data = await api('GET', `/api/conversations/${encodeURIComponent(phone)}`);
      setMessages(m => ({
        ...m,
        [phone]: data
      }));
    } catch {}
  }, []);
  useEffect(() => {
    if (!auth.ok) return;
    loadConversations();
    requestNotificationPermission();
    connectSSE();
    loadCallLogs();
    pollTimer.current = setInterval(loadConversations, 30000);
    return () => {
      clearInterval(pollTimer.current);
      if (sseRef.current) sseRef.current.close();
      clearTimeout(reconnectTimer.current);
      stopRingVibration();
      // Browser calling is opt-in. If it was enabled during this session,
      // release the SIP registration when the inbox page goes away so the
      // native iPhone remains the primary incoming-call endpoint.
      if (telnyxClientRef.current) {
        try {
          telnyxClientRef.current.disconnect();
        } catch {}
        telnyxClientRef.current = null;
      }
    };
  }, [auth.ok]);

  // Apply notification deep-link once conversations are available
  useEffect(() => {
    if (!auth.ok || conversations.length === 0 || deepLinkApplied.current || !deepLinkPhone.current) return;
    deepLinkApplied.current = true;
    goToMessages(deepLinkPhone.current);
    window.history.replaceState({}, '', '/');
  }, [auth.ok, conversations]);

  // A browser incoming-call notification may still bring the operator to the
  // Voice tab, but it deliberately does not register SIP. Native iOS is the
  // primary endpoint; browser calling is enabled only with the button there.
  useEffect(() => {
    if (!auth.ok) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('call') === 'incoming') {
      setMainTab('voice');
      window.history.replaceState({}, '', '/');
    }
  }, [auth.ok]);
  function connectSSE() {
    if (sseRef.current) sseRef.current.close();
    setSseStatus('connecting');
    const es = new EventSource('/api/sse', {
      withCredentials: true
    });
    sseRef.current = es;
    es.onopen = () => {
      setSseStatus('connected');
      reconnectDelay.current = 1000;
    };
    es.onmessage = e => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === 'connected') return;
        if (evt.type === 'status_update') {
          const {
            messageId,
            status,
            phone
          } = evt;
          setMessages(m => {
            if (!m[phone]) return m;
            return {
              ...m,
              [phone]: m[phone].map(msg => msg.telnyx_message_id === messageId ? {
                ...msg,
                status
              } : msg)
            };
          });
          return;
        }
        if (evt.type === 'reaction_update') {
          const {
            phone,
            message_id,
            reactions
          } = evt;
          setMessages(m => {
            if (!m[phone]) return m;
            return {
              ...m,
              [phone]: m[phone].map(msg => msg.id === message_id ? {
                ...msg,
                reactions
              } : msg)
            };
          });
          return;
        }

        // Dispatch to Activity tab SSE listener
        window.dispatchEvent(new CustomEvent('vici-sse', {
          detail: evt
        }));
        if (evt.type === 'order_status_updated') {
          const {
            phone: updatedPhone,
            status: updatedStatus
          } = evt;
          const now = new Date().toISOString();
          setConversations(prev => prev.map(c => c.phone === updatedPhone ? {
            ...c,
            latest_order_status: updatedStatus,
            last_seen: now
          } : c));
          return;
        }
        if (evt.type === 'call_update') {
          if (evt.event === 'hangup') {
            loadCallLogs();
            if (evt.status === 'missed' && mainTabRef.current !== 'voice') {
              addToast(`Missed call from ...${evt.contact_phone?.slice(-4)}`);
            }
          }
          return;
        }
        if (evt.type === 'call_recording_saved') {
          loadCallLogs();
          return;
        }
        if (evt.type === 'new_message') {
          const {
            phone,
            body,
            direction
          } = evt;
          const mediaUrls = Array.isArray(evt.media_urls) ? evt.media_urls : null;
          setConversations(prev => {
            const idx = prev.findIndex(c => c.phone === phone);
            const now = new Date().toISOString();
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = {
                ...updated[idx],
                last_seen: now,
                lastMessage: {
                  body,
                  direction,
                  created_at: now,
                  media_urls: mediaUrls
                },
                unread_count: direction === 'inbound' && phone !== activePhone ? (updated[idx].unread_count || 0) + 1 : updated[idx].unread_count
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
                  id: evt.id || Date.now(),
                  telnyx_message_id: evt.telnyx_message_id || null,
                  contact_phone: phone,
                  direction,
                  body,
                  media_urls: mediaUrls,
                  reply_to_message_id: evt.reply_to_message_id || null,
                  created_at: new Date().toISOString(),
                  status: direction === 'outbound' ? 'queued' : 'delivered'
                }]
              }));
            }
            return ap;
          });
          if (direction === 'inbound' && isAppInBackground()) {
            const contact = conversations.find(c => c.phone === phone);
            const previewBody = (body || '').slice(0, 80) || (mediaUrls?.length ? '📷 Picture' : '');
            showNotification(`New message from ${contact?.name || phone}`, previewBody, phone);
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
    setTimeout(() => {
      try {
        n.close();
      } catch (_) {}
    }, 4000);
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
    messagesEndRef.current?.scrollIntoView({
      behavior: 'smooth'
    });
  }, [messages, activePhone]);
  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden || !('serviceWorker' in navigator)) return;
      navigator.serviceWorker.ready.then(reg => reg.getNotifications()).then(notifications => notifications.forEach(n => n.close())).catch(() => {});
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);
  useEffect(() => {
    if (activePhone) loadThread(activePhone);
  }, [activePhone]);
  function selectContact(phone) {
    setActivePhone(phone);
    setConversations(prev => prev.map(c => c.phone === phone ? {
      ...c,
      unread_count: 0
    } : c));
    setReplyTarget(null);
    setAttachments([]);
    setTimeout(() => inputRef.current?.focus(), 150);
  }

  // ── Voice functions ──────────────────────────────────────────────────────────

  function loadTelnyxSDK() {
    if (window.TelnyxWebRTC || window.TelnyxRTC) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://unpkg.com/@telnyx/webrtc@2.27.1/lib/bundle.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load Telnyx WebRTC SDK'));
      document.head.appendChild(s);
    });
  }
  async function initVoiceClient() {
    if (telnyxClientRef.current) return;
    try {
      await loadTelnyxSDK();
      const res = await fetch('/api/voice/token', {
        credentials: 'include'
      });
      if (!res.ok) throw new Error('Token fetch failed');
      const {
        login,
        password,
        callerNumber
      } = await res.json();
      if (callerNumber) callerNumberRef.current = callerNumber;
      const TelnyxRTC = window.TelnyxWebRTC?.TelnyxRTC || window.TelnyxRTC;
      if (!TelnyxRTC) throw new Error('Telnyx WebRTC SDK not loaded');
      const client = new TelnyxRTC({
        login,
        password
      });
      client.remoteElement = 'telnyx-audio';
      client.on('telnyx.ready', () => {
        console.log('[VOICE] Client ready');
        setVoiceReady(true);
      });
      client.on('telnyx.error', err => {
        console.error('[VOICE] Client error:', err);
        setVoiceReady(false);
      });
      client.on('telnyx.notification', notification => {
        if (notification.type !== 'callUpdate') return;
        handleCallStateChange(notification.call);
      });
      await client.connect();
      telnyxClientRef.current = client;
    } catch (err) {
      console.error('[VOICE] Init failed:', err.message);
    }
  }

  // Tear down any existing client and reconnect only after an explicit user
  // action. This keeps the native iPhone as the primary SIP endpoint.
  async function retryVoiceConnect() {
    try {
      if (telnyxClientRef.current) {
        try {
          telnyxClientRef.current.disconnect();
        } catch {}
        telnyxClientRef.current = null;
      }
      setVoiceReady(false);
    } catch {}
    await initVoiceClient();
  }
  function disableBrowserCalls() {
    if (telnyxClientRef.current) {
      try {
        telnyxClientRef.current.disconnect();
      } catch {}
      telnyxClientRef.current = null;
    }
    activeCallRef.current = null;
    setVoiceReady(false);
    addToast('Browser calling disabled — iPhone is primary');
  }
  function handleCallStateChange(call) {
    activeCallRef.current = call;
    const state = call.state;
    const rawPhone = call.options?.remoteCallerNumber || call.options?.destinationNumber || 'Unknown';
    const phone = normalisePhoneFrontend(rawPhone) || rawPhone;
    console.log('[VOICE] Call state:', state, 'phone: ...' + phone.slice(-4));
    switch (state) {
      case 'ringing':
        callDirectionRef.current = 'inbound';
        callStartRef.current = Date.now();
        setCallState({
          status: 'ringing',
          direction: 'inbound',
          contactPhone: phone,
          contactName: getContactName(phone),
          callControlId: call.id,
          duration: 0,
          isMuted: false,
          isRecording: false
        });
        if (callDirectionRef.current === 'inbound') startRingVibration();
        if (isAppInBackground()) {
          showNotification('Incoming call', `${getContactName(phone) || phone} is calling`, 'incoming-call');
        }
        break;
      case 'active':
        stopRingVibration();
        if (!callStartRef.current) callStartRef.current = Date.now();
        setCallState(prev => ({
          ...prev,
          status: 'active'
        }));
        startDurationTimer();
        // Auto-start recording for outbound calls
        if (callDirectionRef.current === 'outbound' && call.id) {
          fetch('/api/voice/recording/start', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              call_control_id: call.id
            })
          }).then(r => {
            if (r.ok) {
              console.log('[VOICE] Outbound auto-record started');
              setCallState(prev => ({
                ...prev,
                isRecording: true
              }));
            }
          }).catch(() => {});
        }
        break;
      case 'hangup':
      case 'destroy':
      case 'purge':
        {
          stopRingVibration();
          stopDurationTimer();
          const endedAt = new Date().toISOString();
          const startedAt = callStartRef.current ? new Date(callStartRef.current).toISOString() : endedAt;
          const durationSecs = callStartRef.current ? Math.floor((Date.now() - callStartRef.current) / 1000) : 0;
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
            status: durationSecs > 0 ? 'completed' : direction === 'inbound' ? 'missed' : 'failed',
            started_at: startedAt,
            ended_at: endedAt
          }).catch(() => {});
          setCallState(prev => ({
            ...prev,
            status: 'ended'
          }));
          setIsSpeaker(false);
          // Reset audio output to default when call ends
          try {
            const a = document.getElementById('telnyx-audio');
            if (a?.setSinkId) a.setSinkId('default').catch(() => {});
          } catch {}
          setTimeout(() => {
            setCallState({
              status: 'idle',
              direction: null,
              contactPhone: null,
              contactName: null,
              callControlId: null,
              duration: 0,
              isMuted: false,
              isRecording: false
            });
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
      setCallState(prev => ({
        ...prev,
        duration: prev.duration + 1
      }));
    }, 1000);
  }
  function stopDurationTimer() {
    if (durationTimerRef.current) {
      clearInterval(durationTimerRef.current);
      durationTimerRef.current = null;
    }
  }
  function startRingVibration() {
    if (!('vibrate' in navigator)) return;
    stopRingVibration();
    const ringPattern = [600, 400, 600, 800];
    const doVibrate = () => {
      try {
        navigator.vibrate(ringPattern);
      } catch (_) {}
    };
    doVibrate();
    vibrationIntervalRef.current = setInterval(doVibrate, 2400);
  }
  function stopRingVibration() {
    if (vibrationIntervalRef.current) {
      clearInterval(vibrationIntervalRef.current);
      vibrationIntervalRef.current = null;
    }
    try {
      navigator.vibrate(0);
    } catch (_) {}
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
    if (callState.status !== 'idle') {
      addToast('A call is already active');
      return;
    }
    setConfirmCall({
      phone,
      name: name || phone
    });
  }
  function confirmAndCall() {
    if (!confirmCall || !telnyxClientRef.current) return;
    const {
      phone
    } = confirmCall;
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
        status: 'ringing',
        direction: 'outbound',
        contactPhone: phone,
        contactName: getContactName(phone),
        callControlId: null,
        duration: 0,
        isMuted: false,
        isRecording: false
      });
    } catch (err) {
      console.error('[VOICE] newCall failed:', err.message);
      addToast('Call failed. Please try again.');
    }
  }
  function answerCall() {
    activeCallRef.current?.answer();
  }
  function hangupCall() {
    activeCallRef.current?.hangup();
  }
  function toggleMute() {
    const call = activeCallRef.current;
    if (!call) return;
    if (callState.isMuted) {
      call.unmuteAudio();
    } else {
      call.muteAudio();
    }
    setCallState(prev => ({
      ...prev,
      isMuted: !prev.isMuted
    }));
  }
  async function toggleRecording() {
    if (!callState.callControlId) return;
    const endpoint = callState.isRecording ? 'stop' : 'start';
    await fetch(`/api/voice/recording/${endpoint}`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        call_control_id: callState.callControlId
      })
    });
    setCallState(prev => ({
      ...prev,
      isRecording: !prev.isRecording
    }));
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
      const data = await fetch(url, {
        credentials: 'include'
      }).then(r => r.json());
      setCallLogs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error('[VOICE] loadCallLogs failed:', err.message);
    }
  }

  // Called from ContactModal "Open Message Thread" button
  function goToMessages(phone) {
    selectContact(phone);
    setMainTab('messages');
    setMobileSub('thread');
  }

  // Convert picked files to carrier-safe JPEGs and stage them in the composer
  async function handlePickFiles(fileList) {
    const room = 4 - attachments.length;
    const files = Array.from(fileList || []).slice(0, Math.max(0, room));
    if (Array.from(fileList || []).length > room) addToast('Max 4 pictures per message');
    for (const f of files) {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setAttachments(a => [...a, {
        id,
        status: 'processing'
      }]);
      try {
        const img = await downscaleImage(f);
        setAttachments(a => a.map(x => x.id === id ? {
          id,
          status: 'ready',
          ...img
        } : x));
      } catch (err) {
        setAttachments(a => a.filter(x => x.id !== id));
        addToast(`Couldn't read ${f.name}: ${err.message}`);
      }
    }
  }
  function handleRemoveAttachment(id) {
    setAttachments(a => a.filter(x => x.id !== id));
  }
  async function handleReact(message, type) {
    try {
      const r = await api('POST', '/api/react', {
        messageId: message.id,
        type
      });
      const phone = message.contact_phone || activePhone;
      setMessages(m => ({
        ...m,
        [phone]: (m[phone] || []).map(x => x.id === message.id ? {
          ...x,
          reactions: r.reactions
        } : x)
      }));
    } catch (err) {
      addToast('Reaction failed: ' + err.message);
    }
  }
  async function handleSend() {
    const msg = input.trim();
    const ready = attachments.filter(a => a.status === 'ready');
    if (!msg && ready.length === 0 || !activePhone || sending) return;
    if (attachments.some(a => a.status === 'processing')) return;
    const savedAttachments = attachments;
    const savedReply = replyTarget;
    setInput('');
    setAttachments([]);
    setReplyTarget(null);
    setSending(true);
    try {
      const mediaUrls = [];
      for (const a of ready) {
        const up = await api('POST', '/api/upload', {
          contentType: a.contentType,
          data: a.base64
        });
        mediaUrls.push(up.url);
      }
      await api('POST', '/api/send', {
        to: activePhone,
        message: msg,
        mediaUrls,
        replyToMessageId: savedReply?.id || null
      });
    } catch (err) {
      addToast('Send failed: ' + err.message);
      setInput(msg);
      setAttachments(savedAttachments);
      setReplyTarget(savedReply);
    } finally {
      setSending(false);
    }
  }
  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }
  async function handleLogout() {
    await api('POST', '/auth/logout').catch(() => {});
    setAuth({
      checking: false,
      ok: false
    });
  }
  async function runCatchup() {
    try {
      const preview = await api('GET', '/api/catchup/preview');
      if (preview.total_to_send === 0) {
        addToast('No catch-up messages to send — everyone is up to date');
        return;
      }
      const confirmed = window.confirm(`Send catch-up SMS to:\n• ${preview.processing.count} processing orders (order confirmed)\n• ${preview.shipped.count} shipped orders (tracking)\n\nTotal: ${preview.total_to_send} messages\n\nProceed?`);
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
      setTimeout(() => {
        loadConversations();
        setSyncing(false);
      }, 5000);
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
      setTimeout(() => {
        loadConversations();
        setStatusSyncing(false);
      }, 8000);
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
      setPushState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setPushState('denied');
      return;
    }
    navigator.serviceWorker.register('/sw.js', {
      scope: '/'
    }).then(async reg => {
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        // Re-POST on every load to restore the row if it was pruned server-side.
        try {
          const saveResp = await fetch('/api/push/subscribe', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(existing.toJSON())
          });
          if (!saveResp.ok) throw new Error('subscribe POST failed: ' + saveResp.status);

          // Verify the endpoint is genuinely active in the DB.
          // If a prior 410 caused the server to delete it, the re-POST above would have
          // re-inserted it — but the endpoint itself may be permanently expired at APNs.
          // Ask the server to confirm, then force a fresh subscription if stale.
          const checkResp = await fetch('/api/push/check', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              endpoint: existing.endpoint
            })
          });
          const checkData = checkResp.ok ? await checkResp.json() : {
            active: false
          };
          if (!checkData.active) {
            // The DB row doesn't exist even after re-POST — subscription endpoint is
            // permanently dead (APNs rejected it). Unsubscribe the browser and get fresh.
            await existing.unsubscribe();
            const {
              publicKey
            } = await api('GET', '/api/push/vapid-key');
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
          const {
            publicKey
          } = await api('GET', '/api/push/vapid-key');
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
          await fetch('/api/push/unsubscribe', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              endpoint: sub.endpoint
            })
          });
          await sub.unsubscribe();
        }
        setPushState('prompt');
        addToast('Push notifications off');
      } catch (e) {
        addToast('Error: ' + e.message);
      } finally {
        setPushLoading(false);
      }
      return;
    }
    // Subscribe
    setPushLoading(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        setPushState('denied');
        addToast('Notification permission denied');
        return;
      }
      const {
        publicKey
      } = await api('GET', '/api/push/vapid-key');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      await api('POST', '/api/push/subscribe', sub.toJSON());
      setPushState('subscribed');
      addToast('Push notifications enabled');
    } catch (e) {
      addToast('Push error: ' + e.message);
    } finally {
      setPushLoading(false);
    }
  }
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = window.atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  const pushIcon = pushLoading ? '…' : pushState === 'subscribed' ? '🔔' : pushState === 'denied' ? '🔕' : '🔔';
  const pushTitle = pushState === 'subscribed' ? 'Notifications ON — click to disable' : pushState === 'denied' ? 'Notifications blocked — allow in browser settings' : pushState === 'unsupported' ? 'Push notifications not supported' : 'Enable push notifications';
  if (auth.checking) {
    return /*#__PURE__*/React.createElement("div", {
      className: "loading-screen"
    }, /*#__PURE__*/React.createElement("span", {
      className: "spinner",
      style: {
        width: '28px',
        height: '28px'
      }
    }), /*#__PURE__*/React.createElement("span", null, "INITIALISING"));
  }
  if (!auth.ok) return /*#__PURE__*/React.createElement(LoginScreen, {
    onLogin: () => setAuth({
      checking: false,
      ok: true
    })
  });
  return /*#__PURE__*/React.createElement("div", {
    className: "app"
  }, /*#__PURE__*/React.createElement(ToastContainer, {
    toasts: toasts
  }), /*#__PURE__*/React.createElement("div", {
    className: "header"
  }, /*#__PURE__*/React.createElement("div", {
    className: "header-logo"
  }, "VICI", /*#__PURE__*/React.createElement("small", null, "// SMS")), /*#__PURE__*/React.createElement("div", {
    className: "header-tabs"
  }, /*#__PURE__*/React.createElement("button", {
    className: `header-tab${mainTab === 'contacts' ? ' active' : ''}`,
    onClick: () => setMainTab('contacts')
  }, "CONTACTS"), /*#__PURE__*/React.createElement("button", {
    className: `header-tab${mainTab === 'messages' ? ' active' : ''}`,
    onClick: () => setMainTab('messages')
  }, "MESSAGES ", totalUnread > 0 && `(${totalUnread})`), /*#__PURE__*/React.createElement("button", {
    className: `header-tab${mainTab === 'activity' ? ' active' : ''}`,
    onClick: () => setMainTab('activity')
  }, "ACTIVITY"), /*#__PURE__*/React.createElement("button", {
    className: `header-tab${mainTab === 'voice' ? ' active' : ''}`,
    onClick: () => setMainTab('voice')
  }, "VOICE", /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: voiceReady ? '#16a34a' : '#9ca3af',
      display: 'inline-block',
      marginLeft: 5,
      verticalAlign: 'middle'
    }
  }))), /*#__PURE__*/React.createElement("div", {
    className: "header-spacer"
  }), /*#__PURE__*/React.createElement("div", {
    className: "conn-pill"
  }, /*#__PURE__*/React.createElement("div", {
    className: `conn-dot ${sseStatus}`
  }), /*#__PURE__*/React.createElement("span", null, sseStatus)), /*#__PURE__*/React.createElement("div", {
    className: "header-actions"
  }, /*#__PURE__*/React.createElement("button", {
    className: `hdr-btn hdr-btn-push${pushState === 'subscribed' ? ' active' : ''}`,
    onClick: togglePush,
    disabled: pushLoading || pushState === 'unsupported' || pushState === 'denied',
    title: pushTitle,
    style: {
      opacity: pushState === 'unsupported' || pushState === 'denied' ? 0.45 : 1
    }
  }, pushIcon), pushState === 'subscribed' && /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn",
    title: "Send a test push notification to this device",
    onClick: async () => {
      try {
        await api('POST', '/api/push/test', {});
        addToast('Test push sent — should arrive in 1-2s');
      } catch (e) {
        addToast('Test push failed: ' + e.message);
      }
    }
  }, "\u2709\uFE0E TEST"), /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn",
    disabled: statusSyncing,
    onClick: syncStatuses,
    title: "Update all order statuses from WooCommerce \u2014 no messages sent"
  }, statusSyncing ? '…' : '↻ STATUS'), /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn",
    disabled: syncing,
    onClick: syncWoo,
    title: "Sync WooCommerce orders + contacts"
  }, syncing ? '…' : '↻ WOO'), /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn hdr-btn-catchup",
    disabled: catchingUp,
    onClick: runCatchup,
    title: "Send catch-up SMS to processing/shipped orders that never got automated messages"
  }, catchingUp ? '…' : '✉ CATCHUP'), /*#__PURE__*/React.createElement("button", {
    className: "hdr-btn",
    onClick: handleLogout
  }, "EXIT"))), /*#__PURE__*/React.createElement("div", {
    className: "main-content"
  }, mainTab === 'contacts' && /*#__PURE__*/React.createElement(ContactsView, {
    conversations: conversations,
    onGoToMessages: goToMessages,
    onCall: initiateCall,
    addToast: addToast,
    onRefresh: loadConversations,
    prefillPhone: contactPrefill,
    onClearPrefill: () => setContactPrefill(null)
  }), mainTab === 'messages' && /*#__PURE__*/React.createElement(MessagesView, {
    conversations: conversations,
    activePhone: activePhone,
    messages: messages,
    onSelectContact: selectContact,
    input: input,
    setInput: setInput,
    onSend: handleSend,
    onKeyDown: handleKeyDown,
    sending: sending,
    inputRef: inputRef,
    messagesEndRef: messagesEndRef,
    mobileSub: mobileSub,
    setMobileSub: setMobileSub,
    callState: callState,
    voiceReady: voiceReady,
    onInitiateCall: initiateCall,
    attachments: attachments,
    onPickFiles: handlePickFiles,
    onRemoveAttachment: handleRemoveAttachment,
    replyTarget: replyTarget,
    setReplyTarget: setReplyTarget,
    onReact: handleReact
  }), mainTab === 'activity' && /*#__PURE__*/React.createElement(ActivityTab, {
    sseStatus: sseStatus
  }), mainTab === 'voice' && /*#__PURE__*/React.createElement(VoiceTab, {
    callLogs: callLogs,
    dialNumber: dialNumber,
    setDialNumber: setDialNumber,
    onCall: initiateCall,
    voiceReady: voiceReady,
    onRetryConnect: retryVoiceConnect,
    onDisableCalls: disableBrowserCalls,
    conversations: conversations,
    onCreateContact: phone => {
      setContactPrefill(normalisePhoneFrontend(phone) || phone);
      setMainTab('contacts');
    },
    onGoToMessages: goToMessages,
    onBackfillRecordings: async () => {
      addToast('Syncing recordings from Telnyx...');
      try {
        const r = await api('POST', '/api/voice/backfill-recordings');
        addToast(`Recordings synced: ${r.matched} matched, ${r.updated} updated`);
        loadCallLogs();
      } catch (e) {
        addToast('Recording sync failed: ' + e.message);
      }
    }
  })), /*#__PURE__*/React.createElement(CallConfirmModal, {
    target: confirmCall,
    onConfirm: confirmAndCall,
    onCancel: () => setConfirmCall(null)
  }), /*#__PURE__*/React.createElement(ActiveCallPanel, {
    callState: callState,
    onAnswer: answerCall,
    onHangup: hangupCall,
    onMute: toggleMute,
    onRecord: toggleRecording,
    onSpeaker: toggleSpeaker,
    isSpeaker: isSpeaker,
    formatDuration: formatDuration
  }), isMobile && /*#__PURE__*/React.createElement("nav", {
    className: "bottom-nav"
  }, /*#__PURE__*/React.createElement("div", {
    className: "bottom-nav-inner"
  }, /*#__PURE__*/React.createElement("button", {
    className: `bnav-btn${mainTab === 'contacts' ? ' active' : ''}`,
    onClick: () => setMainTab('contacts')
  }, /*#__PURE__*/React.createElement("span", {
    className: "bnav-icon"
  }, "\u25CE"), "Contacts"), /*#__PURE__*/React.createElement("button", {
    className: `bnav-btn${mainTab === 'messages' ? ' active' : ''}`,
    onClick: () => {
      setMainTab('messages');
      if (activePhone) setMobileSub('list');
    }
  }, /*#__PURE__*/React.createElement("span", {
    className: "bnav-icon"
  }, "\u2709"), "Messages", totalUnread > 0 && /*#__PURE__*/React.createElement("span", {
    className: "bnav-badge"
  }, totalUnread)), /*#__PURE__*/React.createElement("button", {
    className: `bnav-btn${mainTab === 'activity' ? ' active' : ''}`,
    onClick: () => setMainTab('activity')
  }, /*#__PURE__*/React.createElement("span", {
    className: "bnav-icon"
  }, "\u26A1"), "Activity"), /*#__PURE__*/React.createElement("button", {
    className: `bnav-btn${mainTab === 'voice' ? ' active' : ''}`,
    onClick: () => setMainTab('voice')
  }, /*#__PURE__*/React.createElement("span", {
    className: "bnav-icon"
  }, "\uD83D\uDCDE"), "Voice", /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: '50%',
      background: voiceReady ? '#16a34a' : '#9ca3af',
      display: 'inline-block',
      marginLeft: 4
    }
  })))));
}
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(/*#__PURE__*/React.createElement(App, null));
