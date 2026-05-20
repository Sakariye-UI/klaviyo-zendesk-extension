// klaviyo-content.js — ZD Staffside Quick Links v3.4.9
// Runs on www.klaviyo.com pages.
// 1. When on a genuine staffside URL (not impersonated), tells background to save
//    the staff session cookies for later lookups from ZD tickets.
// 2. Fetches + caches integrations for any staffside account page (same-origin
//    request — reliable cookies, no SameSite restrictions).
// 3. When impersonated on ANY page: reads access level from the banner and fetches
//    the user list from /ajax/account/users/get, then caches both for the ZD panel.
// 4. Also scrapes /settings/account/security for expiry date when visited directly.
// 5. Fallback: when impersonated, also tries /integrations (customer-facing) if
//    the staffside integration fetch hasn't populated the cache yet.

// Base role map for standard static roles
const ROLE_MAP = {
  '0': 'Owner', '1': 'Admin', '2': 'Manager', '3': 'Analyst',
  '4': 'Campaign Coordinator', '5': 'Content Creator',
  '6': 'Support', '11': 'Social Media Manager'
};

function getImpersonationState() {
  const text = document.body ? document.body.innerText : '';
  const m = text.match(/You(?:'|'|')re in [^(]+\(([A-Za-z0-9]+)\)/);
  if (!m) return { accountId: null, hasEditAccess: false };
  const hasEditAccess = /with edit access/i.test(text);
  return { accountId: m[1], hasEditAccess };
}

// ── Fetch + cache integrations (same-origin — always has correct staff cookies) ─
// The service worker cannot reliably fetch www.klaviyo.com (SameSite cookie
// restrictions apply to cross-origin requests from chrome-extension:// origin).
// Running this fetch here, in the Klaviyo page context, bypasses that entirely.

const _intFetchedAt = {};  // accountId → timestamp, throttle per-account

async function fetchAndCacheIntegrations(accountId) {
  const now = Date.now();
  if (_intFetchedAt[accountId] && now - _intFetchedAt[accountId] < 10 * 60 * 1000) return;
  _intFetchedAt[accountId] = now;

  try {
    const resp = await fetch(`/staff/account/${accountId}/integrations`, { credentials: 'include' });
    if (!resp.ok) return;
    if (!new URL(resp.url, location.origin).pathname.startsWith('/staff/')) return;

    const html = await resp.text();
    const doc  = new DOMParser().parseFromString(html, 'text/html');
    const integrations = [];
    const seen = new Set();

    for (const row of doc.querySelectorAll('tr')) {
      const link = row.querySelector(
        'a[href*="/integration/"]:not([href*="recent-metrics"]):not([href*="/metrics"]),' +
        'a[href*="/applications/"]'
      );
      if (!link) continue;
      const name = link.textContent.trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());

      const img = row.querySelector('img');
      let iconUrl = img ? img.getAttribute('src') : null;
      if (iconUrl && iconUrl.startsWith('/')) iconUrl = location.origin + iconUrl;

      integrations.push({ name, disabled: false, iconUrl: iconUrl || null });
    }

    if (integrations.length) {
      chrome.runtime.sendMessage({ type: 'CACHE_INTEGRATIONS', accountId, integrations }).catch(() => {});
    }
  } catch (_) {}
}

// ── Fetch user list + role list via API (works with customer session cookies) ──
let lastApiAccountId = null;
let lastApiCallTime  = 0;

async function fetchAndCacheFromApi(accountId, hasEditAccess) {
  const now = Date.now();
  // Throttle: one fetch per account per 5 minutes
  if (accountId === lastApiAccountId && now - lastApiCallTime < 5 * 60 * 1000) return;
  lastApiAccountId = accountId;
  lastApiCallTime  = now;

  try {
    // Fetch user list and role list in parallel
    const [usersResp, roleListResp] = await Promise.all([
      fetch('/ajax/account/users/get', { credentials: 'include' }),
      fetch('/ajax/account/users/get-role-list', { credentials: 'include' })
    ]);
    if (!usersResp.ok) return;

    const usersData    = await usersResp.json();
    const roleListData = roleListResp.ok ? await roleListResp.json() : null;

    // Build a complete role map including any custom roles for this account
    const roleMap = { ...ROLE_MAP };
    if (roleListData?.data?.all_roles_list) {
      for (const r of roleListData.data.all_roles_list) {
        if (r.internal_key !== undefined && r.name) {
          roleMap[String(r.internal_key)] = r.name;
        }
      }
    }

    const companyUsers = usersData?.data?.company_users;
    if (!Array.isArray(companyUsers)) return;

    // Include ALL non-deleted users — don't filter by role so no one falls through
    const users = companyUsers
      .filter(u => !u.soft_deleted && u.email)
      .map(u => ({
        email: u.email.toLowerCase(),
        role:  roleMap[String(u.role_id || '').split('_')[0]] || null
      }));

    if (!users.length) return;

    chrome.runtime.sendMessage({
      type: 'CACHE_CUSTOMER_PAGE_DATA',
      accountId,
      users,
      remoteAccess: { hasEditAccess, accessExpiry: null, fromBanner: true }
    }).catch(() => {});
  } catch (_) {}
}

// ── Scrape /integrations (fallback — live DOM when impersonating) ─────────────
// Only connected integrations appear inside <tr> elements.
// Recommended/available-to-add integrations use InternalNameplate components
// (smaller icons, no <tr> ancestor) — we skip those intentionally.
function scrapeIntegrationsPage() {
  const integrations = [];
  const seen = new Set();
  for (const img of document.querySelectorAll(
    'img[src*="static.klaviyo.com/applications"], img[src*="/applications/"]'
  )) {
    const name = img.alt?.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    if (!img.closest('tr')) continue;          // skip non-connected ones
    seen.add(name.toLowerCase());
    const rowText = img.closest('tr')?.innerText || '';
    const disabled = /action required/i.test(rowText);
    integrations.push({ name, disabled, iconUrl: img.getAttribute('src') || null });
  }
  return integrations.length ? integrations : null;
}

// ── Scrape /settings/account/users (fallback DOM scrape) ─────────────────────
function scrapeUsersPage() {
  const rows = document.querySelectorAll('table tbody tr');
  if (!rows.length) return null;
  const users = [];
  rows.forEach(row => {
    const cells = row.querySelectorAll('td');
    if (cells.length < 2) return;
    const nameEmailText = cells[0].innerText.trim();
    const role          = cells[1].innerText.trim();
    const lines = nameEmailText.split('\n').map(l => l.trim()).filter(Boolean);
    const email = lines[lines.length - 1];
    if (email && email.includes('@') && role) {
      users.push({ email: email.toLowerCase(), role });
    }
  });
  return users.length ? users : null;
}

// ── Scrape /settings/account/security (Klaviyo Remote Access section) ────────
function scrapeSecurityPage() {
  if (!document.body.innerText.includes('Klaviyo Remote Access')) return null;
  const dataRows = Array.from(document.querySelectorAll('tr')).filter(r => {
    const cells = r.querySelectorAll('td');
    if (cells.length < 3) return false;
    const level = cells[0].innerText.trim().toLowerCase();
    return level === 'edit' || level === 'read';
  });
  if (!dataRows.length) {
    return { hasEditAccess: false, accessExpiry: null };
  }
  const cells         = dataRows[0].querySelectorAll('td');
  const hasEditAccess = cells[0].innerText.trim().toLowerCase() === 'edit';
  const accessExpiry  = cells[2]?.innerText.trim() || null;
  return { hasEditAccess, accessExpiry };
}

// ── Report staff session OR cache customer data ───────────────────────────────
function report() {
  const { accountId, hasEditAccess } = getImpersonationState();
  const path = location.pathname;

  // Genuine staffside page (not impersonated, not mid-switch)
  if (!accountId && path.startsWith('/staff/') && !path.startsWith('/staff/staffside-switch/')) {
    chrome.runtime.sendMessage({ type: 'SAVE_STAFF_SESSION' }).catch(() => {});

    // Pre-cache integrations for this account using a same-origin fetch.
    // This is the primary integration-fetch path — the service worker cannot
    // reliably make credentialed requests to www.klaviyo.com from its
    // chrome-extension:// origin due to SameSite cookie restrictions.
    const m = path.match(/\/staff\/account\/([A-Za-z0-9]+)/);
    if (m) fetchAndCacheIntegrations(m[1]);

    return;
  }

  if (!accountId) return;

  // On ANY page in a customer account: fetch user list + access level from banner
  fetchAndCacheFromApi(accountId, hasEditAccess);

  // Fallback: scrape /integrations live DOM when impersonating and staffside data
  // isn't available yet. Uses fallback:true so it won't overwrite richer staffside data.
  if (path === '/integrations' || path.startsWith('/integrations/')) {
    const integrations = scrapeIntegrationsPage();
    if (integrations) {
      chrome.runtime.sendMessage({
        type: 'CACHE_INTEGRATIONS', accountId, integrations, fallback: true
      }).catch(() => {});
    }
  }

  // Also scrape the specific settings pages for richer data (role list + expiry)
  if (path.startsWith('/settings/account/users')) {
    const users = scrapeUsersPage();
    if (users) {
      chrome.runtime.sendMessage({ type: 'CACHE_CUSTOMER_PAGE_DATA', accountId, users }).catch(() => {});
    }
  } else if (path.startsWith('/settings/account/security')) {
    const remoteAccess = scrapeSecurityPage();
    if (remoteAccess !== null) {
      chrome.runtime.sendMessage({ type: 'CACHE_CUSTOMER_PAGE_DATA', accountId, remoteAccess }).catch(() => {});
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', report);
} else {
  report();
}

let reportTimer = null;
new MutationObserver(() => {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(report, 300);
}).observe(document.documentElement, { childList: true, subtree: true });

// ── On-demand integration fetch triggered by the ZD panel ────────────────────
// When the background can't get integrations via cookie swap, it asks any open
// Klaviyo tab to fetch in the page context using the specific accountId from
// the ticket — same-origin, so cookies always work regardless of SameSite rules.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FETCH_INTEGRATIONS_FOR_ACCOUNT' && msg.accountId) {
    fetchAndCacheIntegrations(msg.accountId);
  }
});
