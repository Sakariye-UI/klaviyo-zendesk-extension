// Klaviyo Staffside Quick Links — content script v4.0.0
// Injected on all /agent* pages so SPA navigation is covered automatically.

const ACCOUNT_ID_FIELD = 66187667;

let currentTicketId = null;
let injected        = false;
let fetching        = false;
let reinitTimer     = null;

// Pre-warm the service worker so it's already running when we need it
chrome.runtime.sendMessage({ type: 'PING' }).catch(() => {});

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

  function findProfileEmailEl(email, requireOrg = true) {
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
    if (emailEl) return { emailEl, dl: emailEl.closest('dl') };

    // Relaxed fallback — no Org. check. Used for requesters not signed in who have
    // no org in their profile. Still requires the email to appear inside a dl.
    if (!requireOrg) {
      const fallbackEl = Array.from(document.querySelectorAll('a, span, div, p')).find(el => {
        if (el.childElementCount !== 0) return false;
        if (el.textContent.trim().toLowerCase() !== emailLower) return false;
        return !!el.closest('dl');
      });
      return fallbackEl ? { emailEl: fallbackEl, dl: fallbackEl.closest('dl') } : null;
    }

    return null;
  }

  function tryInject() {
    if (ticketId !== currentTicketId) return false;
    if (document.getElementById('klv-staffside-panel')) return true;

    const email = getEmail();
    if (!email) return false;

    // When there's no accountId (no Klaviyo account linked), relax the Org. requirement
    // so tickets from non-signed-in requesters still get the search button.
    let found = findProfileEmailEl(email, true);
    if (!found && !accountId) found = findProfileEmailEl(email, false);
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
  if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return true;
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
  panel.dataset.accountId = accountId || '';
  panel.dataset.email = email;

  applyDarkMode(panel);
  dl.insertBefore(panel, emailSection.nextSibling);
  injected = true;

  // No accountId — show a staffside search link by email only
  if (!accountId) {
    const searchUrl = `https://www.klaviyo.com/staff/users/search?q=${encodeURIComponent(email)}`;
    panel.innerHTML = `
      <div class="klv-buttons">
        <a href="${searchUrl}" target="_blank" class="klv-btn klv-btn-staffside">View in Staffside</a>
      </div>
    `;
    return;
  }

  panel.innerHTML = `<div class="klv-loading"><div class="klv-spinner"></div>Loading…</div>`;

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
      renderPanel(panel, { accountId, email, role, hasEditAccess, accessExpiry, fromCache, forceData: true });
    }
  );
}

// ── Render final panel ────────────────────────────────────────────────────────
function renderPanel(panel, { accountId, email, role, hasEditAccess, accessExpiry, fromCache, forceData = false }) {
  panel.dataset.accountId = accountId;
  panel.dataset.email     = email || panel.dataset.email || '';

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

  // Preserve existing integrations and billing rows across re-render so they
  // don't flash away while the refresh fetch is in flight.
  const existingInt     = panel.querySelector('.klv-integrations');
  const existingBilling = panel.querySelector('.klv-billing');

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

  // Re-insert preserved rows before the buttons so layout is unchanged
  const btns = panel.querySelector('.klv-buttons');
  if (existingBilling) panel.insertBefore(existingBilling, btns);
  if (existingInt)     panel.insertBefore(existingInt, btns);

  applyDarkMode(panel);
  panel.querySelector('.klv-btn-refresh')?.addEventListener('click', () => refreshPanel(panel));
  fetchAndRenderIntegrations(panel, accountId, 0, forceData);
  fetchAndRenderBilling(panel, accountId, 0, forceData);
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
  const keys = Object.keys(INTEGRATION_EMOJIS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (lower.includes(key)) return INTEGRATION_EMOJIS[key];
  }
  return '🔌';
}

// ── Shared: build + insert the integrations row ──────────────────────────────
function renderIntegrationsRow(panel, integrations) {
  if (panel.querySelector('.klv-integrations')) return;
  const accountId = panel.dataset.accountId;
  const fallbackUrl = accountId
    ? `https://www.klaviyo.com/staff/account/${accountId}/integrations`
    : 'https://www.klaviyo.com/integrations';
  const iconsHtml = integrations.map(int => {
    const cls = int.disabled ? ' klv-int-disabled' : '';
    const url = int.pageUrl || fallbackUrl;
    const icon = int.iconUrl
      ? `<img class="klv-int-icon${cls}" src="${esc(int.iconUrl)}" title="${esc(int.name)}" alt="${esc(int.name)}">`
      : `<span class="klv-int-icon klv-int-emoji${cls}" title="${esc(int.name)}">${getIntegrationEmoji(int.name)}</span>`;
    return `<a href="${esc(url)}" target="_blank" title="${esc(int.name)}" style="display:inline-flex;text-decoration:none;">${icon}</a>`;
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
function fetchAndRenderIntegrations(panel, accountId, attempt, force) {
  attempt = attempt || 0;
  chrome.runtime.sendMessage(
    { type: 'FETCH_INTEGRATIONS', accountId, force: !!force },
    (resp) => {
      const integrations = resp?.integrations || [];
      if (!integrations.length) {
        if (attempt < 3 && document.getElementById('klv-staffside-panel') === panel) {
          setTimeout(() => fetchAndRenderIntegrations(panel, accountId, attempt + 1, false), attempt === 0 ? 1500 : 4000);
        }
        return;
      }
      // On force refresh, replace existing row only if new data came back
      if (force) panel.querySelector('.klv-integrations')?.remove();
      renderIntegrationsRow(panel, integrations);
    }
  );
}

// ── Push listener — background notifies us the instant integrations cache is warm ──
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'PUSH_INTEGRATIONS') return;
  const panel = document.getElementById('klv-staffside-panel');
  if (!panel || panel.dataset.accountId !== msg.accountId) return;
  renderIntegrationsRow(panel, msg.integrations);
});

// ── Billing row ───────────────────────────────────────────────────────────────
const BILLING_PRIORITY = ['email', 'sms'];
const PLAN_SORT_NORM   = { 'profiles + email': 'email', 'mobile messaging': 'sms' };

function sortPlans(plans) {
  return [...plans].sort((a, b) => {
    const an = PLAN_SORT_NORM[a.name.toLowerCase()] || a.name.toLowerCase();
    const bn = PLAN_SORT_NORM[b.name.toLowerCase()] || b.name.toLowerCase();
    const ai = BILLING_PRIORITY.indexOf(an);
    const bi = BILLING_PRIORITY.indexOf(bn);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

function renderBillingRow(panel, billing, accountId) {
  if (panel.querySelector('.klv-billing')) return;
  if (!billing) return;

  const billingUrl = `https://www.klaviyo.com/staff/account/${accountId}/billing`;
  let plansHtml;

  if (billing.manuallyBilled) {
    plansHtml = `<span class="klv-billing-name klv-access-value-read">Manually Billed</span>`;
  } else if (Array.isArray(billing.plans) && billing.plans.length) {
    const NAME_ABBR = {
      'profiles + email': 'Email',
      'email':            'Email',
      'mobile messaging': 'SMS',
      'sms':              'SMS',
      'customer hub':     'Cust. Hub',
      'customer agent':   'Cust. Agent',
      'success and support package':         'Success',
      'klaviyo success and support package': 'Success',
      'marketing analytics': 'Analytics',
      'advanced kdp':        'Adv. KDP',
    };
    const sorted = sortPlans(billing.plans);
    const items = sorted.map(p => {
      const short = NAME_ABBR[p.name.toLowerCase()] || p.name;
      return `<span class="klv-billing-item">${esc(short)} <a href="${esc(billingUrl)}" target="_blank" class="klv-billing-price">${esc(p.price)}</a></span>`;
    }).join('');
    plansHtml = `<div class="klv-billing-wrap">${items}</div>`;
  } else {
    return;
  }

  const row = document.createElement('div');
  row.className = 'klv-billing klv-access';
  row.innerHTML = `<span class="klv-access-key">Plans:</span>${plansHtml}`;

  const ints = panel.querySelector('.klv-integrations');
  const btns = panel.querySelector('.klv-buttons');
  if (ints)      panel.insertBefore(row, ints);
  else if (btns) panel.insertBefore(row, btns);
  else           panel.appendChild(row);
}

function fetchAndRenderBilling(panel, accountId, attempt, force) {
  attempt = attempt || 0;
  chrome.runtime.sendMessage(
    { type: 'FETCH_BILLING_DATA', accountId, force: !!force },
    (resp) => {
      const billing = resp?.billing;
      if (!billing) {
        if (attempt < 3 && document.getElementById('klv-staffside-panel') === panel) {
          setTimeout(() => fetchAndRenderBilling(panel, accountId, attempt + 1, false), attempt === 0 ? 1500 : 4000);
        }
        return;
      }
      panel.querySelector('.klv-billing')?.remove();
      renderBillingRow(panel, billing, accountId);
    }
  );
}

// ── Push listener — background pushes billing the instant it's cached ─────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'PUSH_BILLING_DATA') return;
  const panel = document.getElementById('klv-staffside-panel');
  if (!panel || panel.dataset.accountId !== msg.accountId) return;
  panel.querySelector('.klv-billing')?.remove();
  renderBillingRow(panel, msg.billing, msg.accountId);
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
