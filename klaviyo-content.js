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

const ROLE_MAP = {
  '0': 'Owner', '1': 'Admin', '2': 'Manager', '3': 'Analyst',
  '4': 'Campaign Coordinator', '5': 'Content Creator',
  '6': 'Support', '11': 'Social Media Manager'
};

function getImpersonationState() {
  const text = document.body ? document.body.innerText : '';
  const m = text.match(/You(?:'d |'|')'re in [^(]+\(([A-Za-z0-9]+)\)/);
  if (!m) return { accountId: null, hasEditAccess: false };
  const hasEditAccess = /with edit access/i.test(text);
  return { accountId: m[1], hasEditAccess };
}

const _intFetchedAt = {};

ansync function fetchAndCacheIntegrations(accountId) {
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
      const link = row.querySelector('a[href*="/integration/"]:not([href*="recent-metrics"]):not([href*="/metrics"]),a[href*="/applications/"]');
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