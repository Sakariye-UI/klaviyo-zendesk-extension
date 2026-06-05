// klaviyo-content.js — ZD Staffside Quick Links v4.1.0
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
        role:  roleMap[String(u.role_id != null ? u.role_id : '').split('_')[0]] || null
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

// ── Fetch integrations via /ux-api/company-applications (impersonation) ──────
// When impersonated, staff cookies aren't available so /staff/ endpoints redirect.
// /ux-api/company-applications is accessible with customer session cookies and
// returns clean JSON with all enabled integrations. Works from ANY page context.
const _customerIntFetchedAt = {};

async function fetchAndCacheIntegrationsFromCustomerPage(accountId) {
  const now = Date.now();
  if (_customerIntFetchedAt[accountId] && now - _customerIntFetchedAt[accountId] < 10 * 60 * 1000) return;
  _customerIntFetchedAt[accountId] = now;

  try {
    const resp = await fetch('/ux-api/company-applications', { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json();
    if (!Array.isArray(data) || !data.length) return;

    const integrations = data
      .filter(item => item.app_title)
      .map(item => ({
        name:     item.app_title,
        disabled: item.status !== 'ENABLED',
        iconUrl:  item.icon_link || null,
        pageUrl:  item.settings_url
          ? (item.settings_url.startsWith('http') ? item.settings_url : 'https://www.klaviyo.com' + item.settings_url)
          : (item.app_slug ? 'https://www.klaviyo.com/integration/' + item.app_slug : null)
      }));

    if (integrations.length) {
      chrome.runtime.sendMessage({
        type: 'CACHE_INTEGRATIONS', accountId, integrations, fallback: true
      }).catch(() => {});
    }
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

// ── Shared billing name map (used by both scraper and fetcher) ────────────────
const BILLING_NAME_MAP = {
  'profiles + email': 'Email', 'email': 'Email',
  'mobile messaging': 'SMS', 'sms': 'SMS',
  'reviews': 'Reviews', 'social marketing': 'Social', 'social': 'Social',
  'customer hub': 'Customer Hub', 'customer agent': 'Customer Agent',
  'helpdesk': 'Helpdesk', 'advanced kdp': 'Advanced KDP',
  'marketing analytics': 'Analytics', 'analytics': 'Analytics',
  'success and support package': 'Success',
  'klaviyo success and support package': 'Success',
};

function normalizePlanName(raw) {
  const lower = raw.replace(/\s*plan\s*$/i, '').trim().toLowerCase();
  return BILLING_NAME_MAP[lower] || raw.replace(/\s*plan\s*$/i, '').trim();
}

function parseBillingOverviewText(text) {
  const idx = text.indexOf('Monthly total');
  if (idx === -1) return null;
  const endIdx = text.indexOf('Total (excl. tax)', idx);
  if (endIdx === -1) return null;
  const lines = text.slice(idx, endIdx).split('\n').map(l => l.trim()).filter(Boolean);
  const fmt = p => `$${p % 1 === 0 ? p.toFixed(0) : p.toFixed(2)}`;
  const plans = [];
  for (let i = 0; i < lines.length; i++) {
    const pm = lines[i].match(/^\$(\d[\d,]*(?:\.\d+)?)$/);
    if (!pm) continue;
    const price = parseFloat(pm[1].replace(/,/g, ''));
    if (price <= 0) continue;
    const candidate = (lines[i - 2] && !/^\$/.test(lines[i - 2]) && lines[i - 2] !== 'Monthly total')
      ? lines[i - 2] : lines[i - 1];
    if (candidate && !/^\$/.test(candidate) && candidate !== 'Monthly total') {
      plans.push({ name: normalizePlanName(candidate), price: fmt(price) });
    }
  }
  return plans.length ? { manuallyBilled: false, plans } : null;
}

// ── Scrape /settings/billing/overview (Monthly total section) ─────────────────
function scrapeBillingOverview() {
  const text = document.body.innerText || '';
  return parseBillingOverviewText(text);
}

// ── Fetch billing from /ajax/billing/current-billing-package (impersonation) ──
// The billing overview page is client-rendered React — fetching it as HTML returns
// an empty shell. This JSON endpoint returns structured plan data and works with
// customer session cookies (accessible when impersonated).
const _customerBillingFetchedAt = {};

const PRODUCT_TYPE_MAP = {
  'email':             'Email',
  'sms':               'SMS',
  'reviews':           'Reviews',
  'social':            'Social',
  'social_marketing':  'Social',
  'customer_hub':      'Cust. Hub',
  'customer_agent':    'Cust. Agent',
  'helpdesk':          'Helpdesk',
  'advanced_kdp':      'Adv. KDP',
  'advanced_analytics':'Analytics',
  'marketing_analytics':'Analytics',
  'klaviyo_success':   'Success',
  'cdp':               'CDP',
};

async function fetchAndCacheBillingFromCustomerPage(accountId) {
  const now = Date.now();
  if (_customerBillingFetchedAt[accountId] && now - _customerBillingFetchedAt[accountId] < 10 * 60 * 1000) return;
  _customerBillingFetchedAt[accountId] = now;

  try {
    const resp = await fetch('/ajax/billing/current-billing-package', { credentials: 'include' });
    if (!resp.ok) return;
    const json = await resp.json();
    const plans = [];
    const fmt = p => `$${p % 1 === 0 ? p.toFixed(0) : p.toFixed(2)}`;

    for (const plan of Object.values(json.data || {})) {
      if (!plan || typeof plan !== 'object') continue;
      if (!(plan.price > 0)) continue;
      const name = PRODUCT_TYPE_MAP[plan.product_type] || normalizePlanName(plan.label || plan.product_type || '');
      // SMS prices are returned in cents by this API; all other plan types are in dollars
      const rawPrice = plan.product_type === 'sms' ? plan.price / 100 : plan.price;
      plans.push({ name, price: fmt(rawPrice) });
    }

    if (plans.length) {
      chrome.runtime.sendMessage({ type: 'CACHE_BILLING_DATA', accountId, billing: { manuallyBilled: false, plans } }).catch(() => {});
    }
  } catch (_) {}
}

// ── Fetch + cache billing from staffside (same-origin — primary billing-fetch path) ──
// Mirrors fetchAndCacheIntegrations exactly. The service worker cannot reliably fetch
// staffside pages (SameSite cookie restrictions from chrome-extension:// origin).
const _staffBillingFetchedAt = {};

async function fetchAndCacheBillingFromStaffsidePage(accountId) {
  const now = Date.now();
  if (_staffBillingFetchedAt[accountId] && now - _staffBillingFetchedAt[accountId] < 10 * 60 * 1000) return;
  _staffBillingFetchedAt[accountId] = now;
  try {
    const resp = await fetch(`/staff/account/${accountId}/billing`, { credentials: 'include' });
    if (!resp.ok) return;
    if (!new URL(resp.url, location.origin).pathname.startsWith('/staff/')) return;
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const bodyText = doc.body.innerText || doc.body.textContent || '';
    if (/manually[\s\-]?billed/i.test(bodyText)) {
      chrome.runtime.sendMessage({ type: 'CACHE_BILLING_DATA', accountId, billing: { manuallyBilled: true, plans: [] } }).catch(() => {});
      return;
    }
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
    const plans = [];
    const MAP = {
      'profiles + email': 'Email', 'email': 'Email', 'mobile messaging': 'SMS', 'sms': 'SMS',
      'reviews': 'Reviews', 'social marketing': 'Social', 'social': 'Social',
      'customer hub': 'Customer Hub', 'customer agent': 'Customer Agent',
      'helpdesk': 'Helpdesk', 'advanced kdp': 'Advanced KDP',
      'marketing analytics': 'Analytics', 'analytics': 'Analytics',
      'success and support package': 'Success', 'klaviyo success and support package': 'Success',
    };
    const fmt = p => `$${p % 1 === 0 ? p.toFixed(0) : p.toFixed(2)}`;

    // Primary: "Monthly total" breakdown section — actual prices the customer pays
    const mtIdx = lines.findIndex(l => l === 'Monthly total');
    const taxIdx = lines.findIndex(l => /^Total\s*\(excl\.?\s*tax\)/i.test(l));
    if (mtIdx !== -1 && taxIdx !== -1) {
      const section = lines.slice(mtIdx + 1, taxIdx);
      for (let i = 0; i < section.length; i++) {
        const pm = section[i].match(/^\$(\d[\d,]*(?:\.\d+)?)$/);
        if (!pm) continue;
        const price = parseFloat(pm[1].replace(/,/g, ''));
        if (price <= 0) continue;
        const candidate = (section[i - 2] && !/^\$/.test(section[i - 2]) && section[i - 2] !== 'Monthly total')
          ? section[i - 2] : section[i - 1];
        if (candidate && !/^\$/.test(candidate) && candidate !== 'Monthly total') {
          const key = candidate.toLowerCase().replace(/\s*plan\s*$/, '').trim();
          plans.push({ name: MAP[key] || candidate.trim(), price: fmt(price) });
        }
      }
    }
    if (plans.length) {
      chrome.runtime.sendMessage({ type: 'CACHE_BILLING_DATA', accountId, billing: { manuallyBilled: false, plans } }).catch(() => {});
      return;
    }

    // Fallback: "Email MRR: $500.00" (handles comma-formatted amounts)
    for (const line of lines) {
      const m = line.match(/^(.+?)\s+MRR:\s+\$(\d[\d,]*(?:\.\d+)?)$/);
      if (!m) continue;
      const price = parseFloat(m[2].replace(/,/g, ''));
      if (price <= 0) continue;
      const lower = m[1].toLowerCase().trim();
      plans.push({ name: MAP[lower] || m[1].trim(), price: fmt(price) });
    }

    // Legacy format: "Plan name\n... / $500.00 / plan_id"
    if (!plans.length) {
      for (let i = 1; i < lines.length; i++) {
        const m = lines[i].match(/\/\s*\$(\d[\d,]*(?:\.\d+)?)\s*\//);
        if (!m) continue;
        const price = parseFloat(m[1].replace(/,/g, ''));
        if (price <= 0) continue;
        const lower = (lines[i - 1] || '').toLowerCase().replace(/\s*plan\s*$/, '').trim();
        const name = MAP[lower] || null;
        if (name) plans.push({ name, price: fmt(price) });
      }
    }

    if (plans.length) {
      chrome.runtime.sendMessage({ type: 'CACHE_BILLING_DATA', accountId, billing: { manuallyBilled: false, plans } }).catch(() => {});
    }
  } catch (_) {}
}

// ── Report staff session OR cache customer data ───────────────────────────────
function report() {
  const { accountId, hasEditAccess } = getImpersonationState();
  const path = location.pathname;

  // Genuine staffside page (not impersonated, not mid-switch)
  if (!accountId && path.startsWith('/staff/') && !path.startsWith('/staff/staffside-switch/')) {
    chrome.runtime.sendMessage({ type: 'SAVE_STAFF_SESSION' }).catch(() => {});

    // Pre-cache integrations and billing for this account using same-origin fetches.
    // This is the primary path for both — the service worker cannot reliably make
    // credentialed requests to www.klaviyo.com from its chrome-extension:// origin
    // due to SameSite cookie restrictions.
    const m = path.match(/\/staff\/account\/([A-Za-z0-9]+)/);
    if (m) {
      fetchAndCacheIntegrations(m[1]);
      fetchAndCacheBillingFromStaffsidePage(m[1]);
    }

    return;
  }

  if (!accountId) return;

  // On ANY page in a customer account: fetch user list + access level from banner
  fetchAndCacheFromApi(accountId, hasEditAccess);

  // Proactively cache integrations and billing from customer-facing endpoints.
  // These run on every page visit when impersonated, so the cache is warm by the
  // time the ZD panel opens — avoids the gap where role shows but other data doesn't.
  fetchAndCacheIntegrationsFromCustomerPage(accountId);
  fetchAndCacheBillingFromCustomerPage(accountId);

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

  if (path.startsWith('/settings/billing')) {
    const billing = scrapeBillingOverview();
    if (billing) {
      chrome.runtime.sendMessage({ type: 'CACHE_BILLING_DATA', accountId, billing }).catch(() => {});
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
// If this tab is currently impersonated in that account, use the customer-facing
// /integrations page instead — staff-side endpoint will redirect with customer cookies.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FETCH_INTEGRATIONS_FOR_ACCOUNT' && msg.accountId) {
    const { accountId: currentAccountId } = getImpersonationState();
    if (currentAccountId && currentAccountId === msg.accountId) {
      fetchAndCacheIntegrationsFromCustomerPage(msg.accountId);
    } else {
      fetchAndCacheIntegrations(msg.accountId);
    }
  }
});


// ── On-demand billing fetch triggered by the ZD panel ─────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'FETCH_BILLING_FOR_ACCOUNT' && msg.accountId) {
    const { accountId: currentAccountId } = getImpersonationState();
    if (currentAccountId === msg.accountId) {
      // Try live DOM scrape first (instant if already on billing page)
      const billing = scrapeBillingOverview();
      if (billing) {
        chrome.runtime.sendMessage({ type: 'CACHE_BILLING_DATA', accountId: currentAccountId, billing }).catch(() => {});
      } else {
        // Not on the billing page — fetch it in the page context (same-origin, customer cookies)
        // Reset throttle so this on-demand request always fires
        delete _customerBillingFetchedAt[currentAccountId];
        fetchAndCacheBillingFromCustomerPage(currentAccountId);
      }
    } else {
      // Different account or not impersonated — fetch staffside billing page directly.
      // Same-origin fetch from Klaviyo tab includes staff cookies without SameSite issues.
      fetchAndCacheBillingFromStaffsidePage(msg.accountId);
    }
  }
});
