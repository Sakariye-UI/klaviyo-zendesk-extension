// Klaviyo Staffside Quick Links — content script v3.5.1
// Injected on all /agent* pages so SPA navigation is covered automatically.

const ACCOUNT_ID_FIELD = 66187667;

let currentTicketId = null;
let injected        = false;
let fetching        = false;
let reinitTimer     = null;

// ── Bootstrap ─────────────────────────────────────────────────────────────────
function getTicketId() {
  const m = location.pathname.match(/\/tickets\/(\d+)/);
  return m ? m[1] : null;
}

function reset() {
  document.getElementById('klv-staffside-panel')?.remove();
  injected = false;
  fetching = false;
}

function init() {
  const ticketId = getTicketId();
  if (!ticketId) return;
  if (ticketId === currentTicketId && injected) return;
  currentTicketId = ticketId;
  injected = false;
  reset();
  fetchTicketAndInject(ticketId);
}

// ── Fetch ticket (accountId) + user (email) ───────────────────────────────────
async function fetchTicketAndInject(ticketId) {
  if (fetching) return;
  fetching = true;
  try {
    const tr = await fetch(`/api/v2/tickets/${ticketId}.json`, { credentials: 'include' });
    if (!tr.ok) return;
    const { ticket } = await tr.json();
    if (ticketId !== currentTicketId) return;

    const accountId = (ticket.custom_fields || []).find(f => f.id === ACCOUNT_ID_FIELD)?.value || '';
    if (!accountId) return;

    let email = '';
    if (ticket.requester_id) {
      fetch(`/api/v2/users/${ticket.requester_id}.json`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(d => { email = d?.user?.email?.toLowerCase() || ''; })
        .catch(() => {});
    }

    waitForProfileAndInject(accountId, ticketId, () => email);
  } catch (_) {
  } finally {
    fetching = false;
  }
}

// ── Wait for the verified email to appear in the right-panel profile ───────────
function waitForProfileAndInject(accountId, ticketId, getEmail) {

  function findProfileEmailEl(email) {
    const emailLower = email.toLowerCase();

    for (const dt of document.querySelectorAll('dl dt')) {
      if (dt.textContent.trim().toLowerCase() !== 'email') continue;
      const dl = dt.closest('dl');
      if (!dl) continue;
      const valueEl = dt.nextElementSibling;
      if (!valueEl) continue;
      const leaf = valueEl.childElementCount === 0
        ? valueEl
        : Array.from(valueEl.querySelectorAll('*')).find(
            e => e.childElementCount === 0 && e.textContent.includes('@')
          );
      if (!leaf) continue;
      if (leaf.textContent.trim().toLowerCase() !== emailLower) continue;
      return { emailEl: leaf, dl };
    }

    const emailEl = Array.from(document.querySelectorAll('a, span, div, p')).find(el => {
      if (el.childElementCount !== 0) return false;
      if (el.textContent.trim().toLowerCase() !== emailLower) return false;
      const dl = el.closest('dl');
      return !!dl && dl.textContent.includes('Org.');
    });
    return emailEl ? { emailEl, dl: emailEl.closest('dl') } : null;
  }

  function tryInject() {
    if (ticketId !== currentTicketId) return false;
    if (document.getElementById('klv-staffside-panel')) return true;

    const email = getEmail();
    if (!email) return false;

    const found = findProfileEmailEl(email);
    if (!found) return false;

    const { emailEl, dl } = found;
    let emailSection = emailEl;
    while (emailSection.parentElement && emailSection.parentElement !== dl) {
      emailSection = emailSection.parentElement;
    }
    if (emailSection.parentElement !== dl) return false;

    injectPanel(dl, emailSection, accountId, email);
    return true;
  }

  if (tryInject()) return;

  let obs;
  const giveUp = setTimeout(() => obs?.disconnect(), 12000);

  obs = new MutationObserver(() => {
    if (ticketId !== currentTicketId) { obs.disconnect(); clearTimeout(giveUp); return; }
    if (tryInject()) { obs.disconnect(); clearTimeout(giveUp); }
  });
  obs.observe(document.body, { childList: true, subtree: true });

  const poll = setInterval(() => {
    if (ticketId !== currentTicketId || document.getElementById('klv-staffside-panel')) {
      clearInterval(poll);
      return;
    }
    if (tryInject()) {
      obs.disconnect();
      clearTimeout(giveUp);
      clearInterval(poll);
    }
  }, 200);
  setTimeout(() => clearInterval(poll), 12000);
}

// ── Dark mode detection ───────────────────────────────────────────────────────
function detectDark() {
  // System-level dark mode
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return true;
  // Zendesk-specific dark mode — sample the background of the page body/root
  const probe = document.body;
  const bg = window.getComputedStyle(probe).backgroundColor;
  const rgb = bg.match(/\d+/g)?.map(Number);
  if (rgb && rgb.length >= 3) {
    const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    if (luminance < 80) return true;
  }
  return false;
}

function applyDarkMode(panel) {
  const dark = detectDark();
  panel.classList.toggle('klv-dark', dark);
  if (dark) {
    // Walk up the DOM to find Zendesk's actual sidebar background color
    // so the panel blends in perfectly rather than using a hardcoded value
    let bg = null;
    let el = panel.parentElement;
    while (el && el !== document.body) {
      const c = window.getComputedStyle(el).backgroundColor;
      if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') { bg = c; break; }
      el = el.parentElement;
    }
    if (!bg) {
      const bodyBg = window.getComputedStyle(document.body).backgroundColor;
      if (bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)') bg = bodyBg;
    }
    if (bg) panel.style.setProperty('--klv-bg', bg);
    else panel.style.removeProperty('--klv-bg');
  } else {
    panel.style.removeProperty('--klv-bg');
  }
}

// Watch for Zendesk theme changes (light ↔ dark toggle)
const darkModeObserver = new MutationObserver(() => {
  const panel = document.getElementById('klv-staffside-panel');
  if (panel) applyDarkMode(panel);
});
darkModeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-garden-theme', 'data-color-scheme'] });
darkModeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });

// ── Inject loading skeleton then populate ─────────────────────────────────────
function injectPanel(dl, emailSection, accountId, email) {
  if (document.getElementById('klv-staffside-panel')) return;

  const panel = document.createElement('div');
  panel.id = 'klv-staffside-panel';
  panel.dataset.accountId = accountId;
  panel.dataset.email = email;
  panel.innerHTML = `<div class="klv-loading"><div class="klv-spinner"></div>Loading…</div>`;

  applyDarkMode(panel);
  dl.insertBefore(panel, emailSection.nextSibling);
  injected = true;

  chrome.runtime.sendMessage(
    { type: 'FETCH_STAFFSIDE_DATA', accountId, email },
    (resp) => {
      const { role = null, hasEditAccess = false, accessExpiry = null, fromCache = false } = resp || {};
      renderPanel(panel, { accountId, email, role, hasEditAccess, accessExpiry, fromCache });
    }
  );
}

// ── Manual refresh ─────────────────────────────────────────────────────────────
function refreshPanel(panel) {
  const accountId = panel.dataset.accountId;
  const email     = panel.dataset.email;
  if (!accountId) return;

  // Show spinner in the refresh button without wiping the whole panel
  const btn = panel.querySelector('.klv-btn-refresh');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '↻';
    btn.classList.add('klv-btn-refresh-spinning');
  }

  chrome.runtime.sendMessage(
    { type: 'FETCH_STAFFSIDE_DATA', accountId, email, force: true },
    (resp) => {
      const { role = null, hasEditAccess = false, accessExpiry = null, fromCache = false } = resp || {};
      renderPanel(panel, { accountId, email, role, hasEditAccess, accessExpiry, fromCache });
    }
  );
}

// ── Render final panel ────────────────────────────────────────────────────────
function renderPanel(panel, { accountId, email, role, hasEditAccess, accessExpiry, fromCache }) {
  // Preserve data attributes across re-renders
  panel.dataset.accountId = accountId;
  panel.dataset.email     = email || panel.dataset.email || '';

  // Snapshot existing integrations before wiping innerHTML — re-inserted immediately
  // after rebuild so they never disappear during a refresh, even while the async
  // fetchAndRenderIntegrations call is still in flight.
  const existingIntsHtml = panel.querySelector('.klv-integrations')?.outerHTML || null;

  const staffsideUrl = `https://www.klaviyo.com/staff/account/${accountId}/overview`;
  const switchUrl    = hasEditAccess
    ? `https://www.klaviyo.com/staff/staffside-switch/${accountId}/write`
    : `https://www.klaviyo.com/staff/staffside-switch/${accountId}/read`;

  const roleClass   = (role || 'unknown').toLowerCase();
  const roleLabel   = role || '—';

  const accessValueClass = hasEditAccess ? 'klv-access-value-write' : 'klv-access-value-read';
  const accessText       = hasEditAccess ? 'Edit'                   : 'Read only';
  const expiryHtml = (hasEditAccess && accessExpiry)
    ? `<span class="klv-access-expiry">· Expires ${esc(formatExpiry(accessExpiry))}</span>`
    : '';

  const switchClass = hasEditAccess ? 'klv-btn-switch-write' : 'klv-btn-switch-read';
  const switchText  = hasEditAccess ? 'Go into account'      : 'Go into account (Read)';

  panel.innerHTML = `
    <div class="klv-role-row">
      <span class="klv-role-key">User role:</span>
      <span class="klv-role klv-role-${esc(roleClass)}">${esc(roleLabel)}</span>
      <button class="klv-btn-refresh" title="Refresh">↻</button>
    </div>

    <div class="klv-access">
      <span class="klv-access-key">Access:</span>
      <span class="klv-access-value ${accessValueClass}">${accessText}</span>
      ${expiryHtml}
    </div>

    <div class="klv-buttons">
      <a href="${staffsideUrl}" target="_blank" class="klv-btn klv-btn-staffside">View in Staffside</a>
      <a href="${switchUrl}"    target="_blank" class="klv-btn ${switchClass}">${switchText}</a>
    </div>
  `;

  // Restore integrations immediately so they don't disappear during a refresh
  if (existingIntsHtml) {
    const buttons = panel.querySelector('.klv-buttons');
    if (buttons) buttons.insertAdjacentHTML('beforebegin', existingIntsHtml);
  }

  applyDarkMode(panel);
  panel.querySelector('.klv-btn-refresh')?.addEventListener('click', () => refreshPanel(panel));
  fetchAndRenderIntegrations(panel, accountId);
}

function formatExpiry(str) {
  try {
    const d = new Date(str.replace(/(\d+)(st|nd|rd|th)/, '$1').replace('p.m.', 'PM').replace('a.m.', 'AM'));
    if (!isNaN(d)) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch (_) {}
  return str;
}

// ── Integration emoji map ─────────────────────────────────────────────────────
const INTEGRATION_EMOJIS = {
  'shopify':       '🛒',
  'meta ads':      '📘',
  'facebook':      '📘',
  'meta':          '📘',
  'google ads':    '🎯',
  'google':        '🎯',
  'typeform':      '📋',
  'triple whale':  '🐋',
  'chatarmin':     '💬',
  'klaviyo':       '✉️',
  'salesforce':    '☁️',
  'hubspot':       '🟠',
  'mailchimp':     '🐒',
  'zapier':        '⚡',
  'woocommerce':   '🛍️',
  'bigcommerce':   '🏪',
  'recharge':      '🔄',
  'stripe':        '💳',
  'attentive':     '📱',
  'postscript':    '📱',
  'sms bump':      '📱',
  'yotpo':         '⭐',
  'okendo':        '⭐',
  'tiktok':        '🎵',
  'pinterest':     '📌',
  'instagram':     '📸',
  'twitter':       '🐦',
  'x ads':         '🐦',
  'linkedin':      '💼',
  'magento':       '🧡',
  'klar':          '📊',
  'slack':         '💬',
  'gorgias':       '🎧',
  'zendesk':       '🎫',
  'intercom':      '💬',
  'privy':         '🪟',
  'loyalty':       '💎',
  'smile':         '😊',
  'reviews':       '⭐',
  'judge.me':      '⚖️',
  'stamped':       '🏷️',
};

function getIntegrationEmoji(name) {
  const lower = name.toLowerCase();
  // Try longest match first to avoid 'meta' matching 'meta ads' incorrectly
  const keys = Object.keys(INTEGRATION_EMOJIS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key)) return INTEGRATION_EMOJIS[key];
  }
  return '🔌';
}

// ── Shared: build + insert the integrations row ──────────────────────────────
function renderIntegrationsRow(panel, integrations) {
  if (panel.querySelector('.klv-integrations')) return; // already shown
  const iconsHtml = integrations.map(int => {
    const cls = int.disabled ? ' klv-int-disabled' : '';
    if (int.iconUrl) {
      return `<img class="klv-int-icon${cls}" src="${esc(int.iconUrl)}" title="${esc(int.name)}" alt="${esc(int.name)}">`;
    }
    const emoji = getIntegrationEmoji(int.name);
    return `<span class="klv-int-icon klv-int-emoji${cls}" title="${esc(int.name)}">${emoji}</span>`;
  }).join('');

  const row = document.createElement('div');
  row.className = 'klv-integrations';
  row.innerHTML =
    `<span class="klv-role-key">Integrations:</span>` +
    `<span class="klv-int-icons">${iconsHtml}</span>`;

  const buttons = panel.querySelector('.klv-buttons');
  if (buttons) panel.insertBefore(row, buttons);
  else panel.appendChild(row);
}

// ── Fetch + render integrations ───────────────────────────────────────────────
// Primary path: background pushes via PUSH_INTEGRATIONS the instant
// klaviyo-content.js caches them — typically < 1 second.
// Fallback: retry at 1 s and 4 s in case the push is missed.
function fetchAndRenderIntegrations(panel, accountId, attempt) {
  attempt = attempt || 0;
  chrome.runtime.sendMessage(
    { type: 'FETCH_INTEGRATIONS', accountId },
    (resp) => {
      const integrations = resp?.integrations || [];
      if (!integrations.length) {
        // Retry twice as a fallback (1 s then 4 s) — push path covers most cases
        if (attempt < 2 && document.getElementById('klv-staffside-panel') === panel) {
          setTimeout(() => fetchAndRenderIntegrations(panel, accountId, attempt + 1), attempt === 0 ? 1000 : 4000);
        }
        return;
      }
      renderIntegrationsRow(panel, integrations);
    }
  );
}

// ── Push listener — background notifies us the instant cache is warm ──────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'PUSH_INTEGRATIONS') return;
  const panel = document.getElementById('klv-staffside-panel');
  if (!panel || panel.dataset.accountId !== msg.accountId) return;
  renderIntegrationsRow(panel, msg.integrations);
});

// ── Push listener — background pushes role/access the instant it's cached ────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'PUSH_STAFFSIDE_DATA') return;
  const panel = document.getElementById('klv-staffside-panel');
  if (!panel || panel.dataset.accountId !== msg.accountId) return;
  const { role = null, hasEditAccess = false, accessExpiry = null, fromCache = false } = msg;
  renderPanel(panel, {
    accountId: msg.accountId,
    email:     panel.dataset.email,
    role, hasEditAccess, accessExpiry, fromCache
  });
});

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── SPA navigation watcher ────────────────────────────────────────────────────
let lastUrl = location.href;

new MutationObserver(() => {
  const nowUrl = location.href;
  if (nowUrl !== lastUrl) {
    lastUrl = nowUrl;
    reset();
    clearTimeout(reinitTimer);
    reinitTimer = setTimeout(init, 200);
  } else if (getTicketId() && !document.getElementById('klv-staffside-panel') && injected) {
    injected = false;
    clearTimeout(reinitTimer);
    reinitTimer = setTimeout(init, 150);
  }
}).observe(document.body, { childList: true, subtree: true });

window.addEventListener('popstate', () => {
  reset();
  clearTimeout(reinitTimer);
  reinitTimer = setTimeout(init, 150);
});

setInterval(() => {
  const ticketId = getTicketId();
  if (!ticketId) return;
  if (ticketId !== currentTicketId) {
    init();
  } else if (!document.getElementById('klv-staffside-panel') && !fetching) {
    injected = false;
    init();
  }
}, 1000);

init();
