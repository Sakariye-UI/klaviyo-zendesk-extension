// Background service worker — ZD Staffside Quick Links v4.0.0

// ── Cookie-swap lock ──────────────────────────────────────────────────────────
// All operations that swap Klaviyo cookies must run through this lock so they
// never overlap — concurrent swaps corrupt each other's cookie state.
let _cookieSwapLocked = false;
const _cookieSwapQueue = [];

function withCookieSwap(fn) {
  return new Promise((resolve, reject) => {
    _cookieSwapQueue.push({ fn, resolve, reject });
    _drainCookieSwapQueue();
  });
}
function _drainCookieSwapQueue() {
  if (_cookieSwapLocked || !_cookieSwapQueue.length) return;
  _cookieSwapLocked = true;
  const { fn, resolve, reject } = _cookieSwapQueue.shift();
  Promise.resolve().then(() => fn()).then(
    val => { _cookieSwapLocked = false; _drainCookieSwapQueue(); resolve(val); },
    err => { _cookieSwapLocked = false; _drainCookieSwapQueue(); reject(err); }
  );
}

// ── Message handlers ──────────────────────────────────────────────────────────

let fetchInProgress = false;

// Tabs waiting for integrations that weren't in cache yet.
// When klaviyo-content.js caches them, we push immediately instead of
// waiting for the content script's retry timer.
const pendingIntegrationTabs = {}; // accountId → Set<tabId>

const pendingBillingTabs = {}; // accountId → Set<tabId>

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'FETCH_STAFFSIDE_DATA') {
    const force = !!msg.force;

    // On a forced refresh, allow the fetch through even if one is in progress
    if (fetchInProgress && !force) {
      readCache(msg.accountId).then(cached => {
        sendResponse(cached || { role: null, hasEditAccess: false, accessExpiry: null });
      });
      return true;
    }

    // Force refresh: clear cached data for this account so fetchStaffsideData
    // skips all cache layers and goes straight to a live network fetch.
    const fetchPromise = force
      ? clearAccountCache(msg.accountId).then(() => fetchStaffsideData(msg.accountId, msg.email, true))
      : fetchStaffsideData(msg.accountId, msg.email, false);

    fetchInProgress = true;
    fetchPromise
      .then(data => sendResponse(data))
      .catch(() => sendResponse({ role: null, hasEditAccess: false, accessExpiry: null }))
      .finally(() => { fetchInProgress = false; });
    return true;
  }

  if (msg.type === 'FETCH_INTEGRATIONS') {
    const accountId = msg.accountId;
    const tabId     = sender.tab?.id;
    fetchIntegrationsData(accountId, msg.force)
      .then(data => {
        sendResponse(data);
        // If still empty, register this tab so we can push the moment
        // klaviyo-content.js caches the data — no retry delay needed.
        if (!data.integrations?.length && tabId) {
          if (!pendingIntegrationTabs[accountId]) pendingIntegrationTabs[accountId] = new Set();
          pendingIntegrationTabs[accountId].add(tabId);
        }
      })
      .catch(() => sendResponse({ integrations: [] }));
    return true;
  }

  if (msg.type === 'SAVE_STAFF_SESSION') {
    saveStaffSession();
  }

  if (msg.type === 'CACHE_CUSTOMER_PAGE_DATA') {
    const { accountId, users, remoteAccess } = msg;
    if (!accountId) return;
    if (users)        writeCustomerUsersCache(accountId, users);
    if (remoteAccess) writeCustomerSecurityCache(accountId, remoteAccess);
  }

  // Integrations fetched/scraped by klaviyo-content.js (same-origin — reliable cookies).
  // fallback:true means the data came from /integrations (customer page) — only write
  // if the cache is empty so we don't overwrite richer staffside data.
  // After caching, push immediately to any Zendesk tabs that were waiting.
  if (msg.type === 'CACHE_INTEGRATIONS') {
    const { accountId, integrations, fallback } = msg;
    if (accountId && Array.isArray(integrations) && integrations.length) {
      const proceed = fallback
        ? readIntegrationsCache(accountId).then(existing => !existing)
        : Promise.resolve(true);
      proceed.then(shouldWrite => {
        if (!shouldWrite) return;
        writeIntegrationsCache(accountId, integrations);
        // Push to waiting Zendesk tabs so they update instantly
        const waiting = pendingIntegrationTabs[accountId];
        if (waiting) {
          delete pendingIntegrationTabs[accountId];
          for (const tabId of waiting) {
            chrome.tabs.sendMessage(tabId, { type: 'PUSH_INTEGRATIONS', accountId, integrations })
              .catch(() => {});
          }
        }
      });
    }
  }

  if (msg.type === 'FETCH_BILLING_DATA') {
    fetchBillingData(msg.accountId, msg.force)
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ billing: null }));
    return true;
  }

  if (msg.type === 'CACHE_BILLING_DATA') {
    const { accountId, billing } = msg;
    if (!accountId || !billing) return;
    writeBillingCache(accountId, billing);
    // Broadcast to ALL open ZD ticket tabs — don't rely on pendingBillingTabs
    // (that in-memory map is lost when the service worker restarts).
    chrome.tabs.query({ url: 'https://klaviyo.zendesk.com/agent/tickets/*' }).then(tabs => {
      for (const tab of tabs) {
        chrome.tabs.sendMessage(tab.id, { type: 'PUSH_BILLING_DATA', accountId, billing }).catch(() => {});
      }
    }).catch(() => {});
    // Also flush any pending tabs registered before the worker restarted
    const waiting = pendingBillingTabs[accountId];
    if (waiting?.size) {
      delete pendingBillingTabs[accountId];
      for (const tabId of waiting) {
        chrome.tabs.sendMessage(tabId, { type: 'PUSH_BILLING_DATA', accountId, billing }).catch(() => {});
      }
    }
  }
});

// ── Pre-impersonation: save session + pre-cache target account ────────────────
// Fires before staffside-switch loads, while staff cookies are still valid.
chrome.webNavigation.onBeforeNavigate.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    lastSessionSave = 0;
    saveStaffSession();
    const m = details.url.match(/\/staff\/staffside-switch\/([A-Za-z0-9]+)\//);
    if (m) preFetchAndCacheAccount(m[1]);
  },
  { url: [{ hostEquals: 'www.klaviyo.com', pathContains: '/staff/staffside-switch/' }] }
);

async function preFetchAndCacheAccount(accountId) {
  try {
    // Check what we already have — fetch only what's missing.
    // This fires on onBeforeNavigate (staff cookies still active), so both fetches
    // are reliable here. Integrations are fetched in parallel with overview so the
    // cache is warm before the session switches to customer cookies.
    const [cached, intCached, billingCached] = await Promise.all([
      readCache(accountId),
      readIntegrationsCache(accountId),
      readBillingCache(accountId),
    ]);
    if (cached && intCached && billingCached) return;

    const [resp, intResp, billingResp] = await Promise.all([
      !cached        ? fetch('https://www.klaviyo.com/staff/account/' + accountId + '/overview',     { credentials: 'include' }) : Promise.resolve(null),
      !intCached     ? fetch('https://www.klaviyo.com/staff/account/' + accountId + '/integrations', { credentials: 'include' }) : Promise.resolve(null),
      !billingCached ? fetch('https://www.klaviyo.com/staff/account/' + accountId + '/billing',      { credentials: 'include' }) : Promise.resolve(null),
    ]);

    if (resp) {
      if (!resp.ok) return;
      const html = await resp.text();
      if (!isStaffsidePage(html, resp.url)) return;
      await writeCache(accountId, await parseStaffsideData(html, null, accountId));
    }

    if (intResp?.ok && new URL(intResp.url).pathname.startsWith('/staff/')) {
      const intHtml = await intResp.text();
      const integrations = parseIntegrations(intHtml);
      if (integrations.length) await writeIntegrationsCache(accountId, integrations);
    }

    if (billingResp?.ok) {
      const billingHtml = await billingResp.text();
      const billing = parseStaffsideBilling(billingHtml);
      if (billing) await cacheAndPushBilling(accountId, billing);
    }
  } catch (_) {}
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL_MS       = 15 * 60 * 1000;          // 15 minutes — always try fresh on re-entry
const STALE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days  — last-resort fallback

async function readCache(accountId) {
  try {
    const key = 'klv_' + accountId;
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry) return null;
    // Expired — keep the entry (readStaleCache uses it) but return null for fresh reads
    if (Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
    if (entry.role === undefined && entry.hasEditAccess === undefined) return null;
    return { role: entry.role, hasEditAccess: entry.hasEditAccess, accessExpiry: entry.accessExpiry };
  } catch (_) { return null; }
}

// Returns the last cached staffside result up to STALE_CACHE_TTL_MS old — used as a
// fallback when all fresh fetch attempts fail so the panel still shows something.
async function readStaleCache(accountId) {
  try {
    const key = 'klv_' + accountId;
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > STALE_CACHE_TTL_MS) return null;
    if (entry.role === undefined && entry.hasEditAccess === undefined) return null;
    return { role: entry.role, hasEditAccess: entry.hasEditAccess, accessExpiry: entry.accessExpiry, fromCache: true };
  } catch (_) { return null; }
}

// ── Customer-page cache (scraped by klaviyo-content.js on /settings pages) ───

const CUSTOMER_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function writeCustomerUsersCache(accountId, users) {
  try {
    await chrome.storage.local.set({ ['klv_cu_' + accountId]: { users, cachedAt: Date.now() } });
  } catch (_) {}
}

async function writeCustomerSecurityCache(accountId, data) {
  try {
    const key = 'klv_cs_' + accountId;
    if (data.fromBanner) {
      // Banner data only has hasEditAccess — preserve any existing accessExpiry from a
      // previous security-page scrape so we don't wipe out richer data.
      const existing = (await chrome.storage.local.get(key))[key];
      const merged = {
        hasEditAccess: data.hasEditAccess,
        accessExpiry:  existing?.accessExpiry ?? null,
        cachedAt:      Date.now()
      };
      await chrome.storage.local.set({ [key]: merged });
    } else {
      await chrome.storage.local.set({ [key]: { hasEditAccess: data.hasEditAccess, accessExpiry: data.accessExpiry ?? null, cachedAt: Date.now() } });
    }
  } catch (_) {}
}

async function readCustomerPageCache(accountId, email) {
  try {
    const [usersResult, secResult] = await Promise.all([
      chrome.storage.local.get('klv_cu_' + accountId),
      chrome.storage.local.get('klv_cs_' + accountId),
    ]);
    const usersEntry = usersResult['klv_cu_' + accountId];
    const secEntry   = secResult['klv_cs_' + accountId];

    // Enforce 24-hour TTL — discard stale entries so stale role/access data never lingers
    const now = Date.now();
    const usersValid = usersEntry && (now - usersEntry.cachedAt <= CUSTOMER_CACHE_TTL_MS);
    const secValid   = secEntry   && (now - secEntry.cachedAt   <= CUSTOMER_CACHE_TTL_MS);
    if (!usersValid && !secValid) return null;

    let role = null;
    if (usersValid && email) {
      const emailLower = email.toLowerCase();
      const user = usersEntry.users.find(u => u.email === emailLower);
      if (user) role = user.role;
    }

    const hasEditAccess = secValid ? (secEntry.hasEditAccess ?? false) : false;
    const accessExpiry  = secValid ? (secEntry.accessExpiry  ?? null)  : null;

    if (!role && !hasEditAccess && !secValid) return null;
    return { role, hasEditAccess, accessExpiry, fromCache: true };
  } catch (_) { return null; }
}

// Clears only the staffside scrape result before a forced refresh.
// Customer page data (klv_cu_, klv_cs_) and integrations (klv_int_) are NOT cleared —
// each section is independently sticky and should show its last successfully pulled
// data even if the current refresh can't update that particular section.
async function clearAccountCache(accountId) {
  try {
    await chrome.storage.local.remove('klv_' + accountId);
  } catch (_) {}
}

async function writeCache(accountId, data) {
  try {
    await chrome.storage.local.set({
      ['klv_' + accountId]: { role: data.role, hasEditAccess: data.hasEditAccess, accessExpiry: data.accessExpiry, cachedAt: Date.now() }
    });
  } catch (_) {}
}

// ── Staff session save / restore ──────────────────────────────────────────────

const STAFF_SESSION_TTL_MS  = 8 * 60 * 60 * 1000;
const SESSION_SAVE_THROTTLE = 5 * 60 * 1000;
let lastSessionSave = 0;

async function saveStaffSession() {
  const now = Date.now();
  if (now - lastSessionSave < SESSION_SAVE_THROTTLE) return;
  lastSessionSave = now;
  try {
    const cookies = await chrome.cookies.getAll({ url: 'https://www.klaviyo.com' });
    if (!cookies.length) return;
    await chrome.storage.local.set({ klv_staff_session: { cookies, savedAt: now } });
  } catch (_) {}
}

async function getStaffSession() {
  try {
    const { klv_staff_session: s } = await chrome.storage.local.get('klv_staff_session');
    if (!s) return null;
    if (Date.now() - s.savedAt > STAFF_SESSION_TTL_MS) { chrome.storage.local.remove('klv_staff_session'); return null; }
    return s;
  } catch (_) { return null; }
}

// ── Cookie helpers ────────────────────────────────────────────────────────────

async function setCookies(cookies) {
  for (const c of cookies) {
    try {
      const host = c.domain.startsWith('.') ? 'www' + c.domain : c.domain;
      const details = {
        url: 'https://' + host + (c.path || '/'),
        name: c.name, value: c.value, path: c.path || '/',
        secure: c.secure, httpOnly: c.httpOnly,
      };
      if (!c.hostOnly) details.domain = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
      if (c.sameSite && c.sameSite !== 'unspecified') details.sameSite = c.sameSite;
      if (c.expirationDate) details.expirationDate = c.expirationDate;
      await chrome.cookies.set(details);
    } catch (_) {}
  }
}

async function removeCookie(c) {
  try {
    const host = c.domain.startsWith('.') ? 'www' + c.domain : c.domain;
    await chrome.cookies.remove({ url: 'https://' + host + (c.path || '/'), name: c.name });
  } catch (_) {}
}

async function restoreSnapshot(snapshot) {
  const current = await chrome.cookies.getAll({ url: 'https://www.klaviyo.com' });
  const keys = new Set(snapshot.map(c => c.name + '|' + c.domain + '|' + c.path));
  for (const c of current) {
    if (!keys.has(c.name + '|' + c.domain + '|' + c.path)) await removeCookie(c);
  }
  await setCookies(snapshot);
}

// ── Staffside page detection ──────────────────────────────────────────────────

function isStaffsidePage(html, finalUrl) {
  try {
    const pathname = new URL(finalUrl).pathname;
    return pathname.startsWith('/staff/') && html.includes('user_item');
  } catch (_) { return false; }
}

// ── Main fetch ────────────────────────────────────────────────────────────────

async function fetchStaffsideData(accountId, email, force = false) {
  const overviewUrl = 'https://www.klaviyo.com/staff/account/' + accountId + '/overview';

  // Hoisted so step 4 fallback can always reference it regardless of force/early-return path
  let customerData = null;

  if (!force) {
    // 1. Valid staffside cache — still good for role, but override access level
    //    with customer security cache when available (banner data reflects current session)
    const cached = await readCache(accountId);
    if (cached) {
      refreshCacheInBackground(accountId, email);
      customerData = await readCustomerPageCache(accountId, email);
      if (customerData) {
        return {
          role:          customerData.role || cached.role,
          hasEditAccess: customerData.hasEditAccess,
          accessExpiry:  customerData.accessExpiry ?? cached.accessExpiry
        };
      }
      return cached;
    }

    // 2. Customer page cache — populated by klaviyo-content.js on any page visit.
    //    If we have role + access level already, skip the slow staffside fetch entirely.
    customerData = await readCustomerPageCache(accountId, email);
    if (customerData?.role) {
      refreshCacheInBackground(accountId, email); // update staffside in background
      return customerData;
    }
  } else {
    // Force refresh skips the cache layers above, but we still read the customer page
    // cache here so step 4's fallback has a role to show if the live staffside fetch
    // fails (e.g. currently impersonated — staff cookies unavailable).
    customerData = await readCustomerPageCache(accountId, email);
  }

  // 3. Try fresh staffside fetch (slower — network round trip, possibly cookie swap)
  try {
    const intUrl     = 'https://www.klaviyo.com/staff/account/' + accountId + '/integrations';
    const billingUrl = 'https://www.klaviyo.com/staff/account/' + accountId + '/billing';

    // Fetch overview + integrations + billing in parallel
    const [resp, intResp, billingResp] = await Promise.all([
      fetch(overviewUrl, { credentials: 'include' }),
      fetch(intUrl,      { credentials: 'include' }),
      fetch(billingUrl,  { credentials: 'include' }),
    ]);

    if (resp.ok) {
      const html = await resp.text();
      if (isStaffsidePage(html, resp.url)) {
        // Cache integrations while we still have the response
        if (intResp.ok && new URL(intResp.url).pathname.startsWith('/staff/')) {
          const intHtml = await intResp.text();
          const integrations = parseIntegrations(intHtml);
          if (integrations.length) await writeIntegrationsCache(accountId, integrations);
        }

        // Process billing async — don't block role/access response on billing HTML
        if (billingResp?.ok) {
          billingResp.text().then(billingHtml => {
            const billing = parseStaffsideBilling(billingHtml);
            if (billing) cacheAndPushBilling(accountId, billing);
          }).catch(() => {});
        }
        const result = await parseStaffsideData(html, email, accountId);
        await writeCache(accountId, result);
        return result;
      }
      // Impersonated — try cookie swap
      const staffSession = await getStaffSession();
      if (staffSession) {
        const swapResult = await fetchWithStaffSession(accountId, email, overviewUrl, staffSession);
        if (swapResult.role !== null || swapResult.hasEditAccess) return swapResult;
      }
    }
  } catch (_) {}

  // 4. Merge best available: customer page cache (fresh access + role from API)
  //    and stale staffside cache (role from a prior staffside parse).
  const stale = await readStaleCache(accountId);

  if (!stale && !customerData) {
    return { role: null, hasEditAccess: false, accessExpiry: null };
  }

  // Customer page cache has the freshest access level (from impersonation banner).
  // Stale staffside cache may have a role from a previous parse.
  const role          = customerData?.role || stale?.role || null;
  const hasEditAccess = customerData ? customerData.hasEditAccess : (stale?.hasEditAccess ?? false);
  const accessExpiry  = customerData?.accessExpiry ?? stale?.accessExpiry ?? null;
  return { role, hasEditAccess, accessExpiry, fromCache: true };
}

// Fetch staffside billing. Fast path: direct fetch (works when cookies are SameSite-less).
// Fallback: saved staff session cookie swap, then Klaviyo tab async push.
async function fetchBillingData(accountId, force) {
  const cached = await readBillingCache(accountId);
  if (cached && !force) return { billing: cached };

  // 2. Direct fetch — fast when cookies are already SameSite-stripped by a prior swap.
  try {
    const billingUrl = 'https://www.klaviyo.com/staff/account/' + accountId + '/billing';
    const resp = await fetch(billingUrl, { credentials: 'include' });
    if (resp.ok && new URL(resp.url).pathname.startsWith('/staff/')) {
      const html = await resp.text();
      const billing = parseStaffsideBilling(html);
      if (billing) {
        await writeBillingCache(accountId, billing);
        cacheAndPushBilling(accountId, billing);
        return { billing };
      }
    }
  } catch (_) {}

  // 3. Cookie-swap with saved staff session — safe because it uses stored cookies,
  // not live ones, so restoreSnapshot() can never wipe a mid-flight impersonation login.
  const staffSession = await getStaffSession();
  if (staffSession) {
    const staffBilling = await fetchBillingWithCookieSwap(accountId, staffSession).catch(() => null);
    if (staffBilling) return { billing: staffBilling };
  }

  // Ask any open Klaviyo tab to fetch and push asynchronously
  chrome.tabs.query({ url: 'https://www.klaviyo.com/*' }).then(tabs => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'FETCH_BILLING_FOR_ACCOUNT', accountId }).catch(() => {});
    }
  }).catch(() => {});

  // Return cached data (even if stale) so the panel isn't blank
  return { billing: cached || null };
}

// Called when billing isn't cached and service worker can't use staff cookies directly.
// Returns the billing object directly (mirrors fetchIntegrationsData pattern).
async function fetchBillingWithCookieSwap(accountId, staffSession) {
  return withCookieSwap(async () => {
    const billingUrl = 'https://www.klaviyo.com/staff/account/' + accountId + '/billing';
    const customerSnapshot = await chrome.cookies.getAll({ url: 'https://www.klaviyo.com' });
    await setCookies(staffSession.cookies);
    try {
      const resp = await fetch(billingUrl, { credentials: 'include' });
      if (!resp.ok) return null;
      const html = await resp.text();
      const billing = parseStaffsideBilling(html);
      if (billing) await cacheAndPushBilling(accountId, billing);
      return billing || null;
    } finally {
      await restoreSnapshot(customerSnapshot);
    }
  });
}

// Write billing to cache AND broadcast to all open ZD ticket tabs.
// Broadcasts to all tabs — never relies on pendingBillingTabs (lost on service worker restart).
async function cacheAndPushBilling(accountId, billing) {
  await writeBillingCache(accountId, billing);
  chrome.tabs.query({ url: 'https://klaviyo.zendesk.com/agent/tickets/*' }).then(tabs => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'PUSH_BILLING_DATA', accountId, billing }).catch(() => {});
    }
  }).catch(() => {});
}

async function refreshCacheInBackground(accountId, email) {
  try {
    const intUrl     = 'https://www.klaviyo.com/staff/account/' + accountId + '/integrations';
    const billingUrl = 'https://www.klaviyo.com/staff/account/' + accountId + '/billing';
    const needsInt     = !(await readIntegrationsCache(accountId));
    const needsBilling = !(await readBillingCache(accountId));

    const [resp, intResp, billingResp] = await Promise.all([
      fetch('https://www.klaviyo.com/staff/account/' + accountId + '/overview', { credentials: 'include' }),
      needsInt     ? fetch(intUrl,     { credentials: 'include' }) : Promise.resolve(null),
      needsBilling ? fetch(billingUrl, { credentials: 'include' }) : Promise.resolve(null),
    ]);

    if (!resp.ok) return;
    const html = await resp.text();
    if (!isStaffsidePage(html, resp.url)) return;
    await writeCache(accountId, await parseStaffsideData(html, email, accountId));

    if (needsInt && intResp?.ok && new URL(intResp.url).pathname.startsWith('/staff/')) {
      const intHtml = await intResp.text();
      const integrations = parseIntegrations(intHtml);
      if (integrations.length) await writeIntegrationsCache(accountId, integrations);
    }

    if (needsBilling && billingResp?.ok) {
      const billingHtml = await billingResp.text();
      const billing = parseStaffsideBilling(billingHtml);
      if (billing) await cacheAndPushBilling(accountId, billing);
    }
  } catch (_) {}
}

async function fetchWithStaffSession(accountId, email, overviewUrl, staffSession) {
  return withCookieSwap(async () => {
  const intUrl     = 'https://www.klaviyo.com/staff/account/' + accountId + '/integrations';
  const billingUrl = 'https://www.klaviyo.com/staff/account/' + accountId + '/billing';
  const customerSnapshot = await chrome.cookies.getAll({ url: 'https://www.klaviyo.com' });
  await setCookies(staffSession.cookies);
  try {
    // Fetch overview + integrations + billing in parallel while staff cookies are active
    const [resp, intResp, billingResp] = await Promise.all([
      fetch(overviewUrl, { credentials: 'include' }),
      fetch(intUrl,      { credentials: 'include' }),
      fetch(billingUrl,  { credentials: 'include' }),
    ]);

    // Process integrations
    if (intResp.ok && new URL(intResp.url).pathname.startsWith('/staff/')) {
      const intHtml = await intResp.text();
      const integrations = parseIntegrations(intHtml);
      if (integrations.length) await writeIntegrationsCache(accountId, integrations);
    }

    // Process billing async — don't block role/access response on billing HTML
    if (billingResp?.ok) {
      billingResp.text().then(billingHtml => {
        const billing = parseStaffsideBilling(billingHtml);
        if (billing) cacheAndPushBilling(accountId, billing);
      }).catch(() => {});
    }

    if (!resp.ok) return { role: null, hasEditAccess: false, accessExpiry: null };
    const html = await resp.text();
    if (!isStaffsidePage(html, resp.url)) return { role: null, hasEditAccess: false, accessExpiry: null };
    const result = await parseStaffsideData(html, email, accountId);
    await writeCache(accountId, result);
    return result;
  } finally {
    await restoreSnapshot(customerSnapshot);
  }
  }); // end withCookieSwap
}

// ── Integrations fetch + cache ────────────────────────────────────────────────

const INTEGRATIONS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Low-level: fetch + parse integrations using whatever cookies are currently set.
// Returns an array (may be empty).
async function fetchIntegrationsLive(accountId) {
  try {
    const url = 'https://www.klaviyo.com/staff/account/' + accountId + '/integrations';
    const resp = await fetch(url, { credentials: 'include' });
    if (resp.ok && new URL(resp.url).pathname.startsWith('/staff/')) {
      const html = await resp.text();
      return parseIntegrations(html);
    }
  } catch (_) {}
  return [];
}

// Called by the FETCH_INTEGRATIONS message.
// 1. Serve from cache when warm.
// 2. Direct fetch — fast path. Works when cookies are already SameSite-stripped (any prior
//    cookie swap permanently removes SameSite from browser cookies via setCookies(), so
//    subsequent plain fetches from the service worker can include them).
// 3. Cookie-swap fetch with saved staff session (fallback when direct fetch fails).
// 4. Ask an open Klaviyo tab to fetch same-origin.
async function fetchIntegrationsData(accountId, force) {
  // 1. Cache hit — skip on force refresh so we always try a fresh fetch,
  //    but keep the cached value as a fallback if the fresh fetch returns nothing.
  const cached = await readIntegrationsCache(accountId);
  if (cached && !force) return { integrations: cached };

  // 2. Direct fetch — no cookie manipulation. Fast when cookies are already SameSite-less.
  const direct = await fetchIntegrationsLive(accountId);
  if (direct.length) {
    await writeIntegrationsCache(accountId, direct);
    return { integrations: direct };
  }

  // 3. Cookie-swap fetch with saved staff session — uses stored (not live) cookies so
  //    restoreSnapshot() can never wipe a mid-flight impersonation login.
  const staffSession = await getStaffSession();
  if (staffSession) {
    const staffSwapped = await withCookieSwap(async () => {
      const customerSnapshot = await chrome.cookies.getAll({ url: 'https://www.klaviyo.com' });
      await setCookies(staffSession.cookies);
      try {
        return await fetchIntegrationsLive(accountId);
      } finally {
        await restoreSnapshot(customerSnapshot);
      }
    }).catch(() => []);
    if (staffSwapped.length) {
      await writeIntegrationsCache(accountId, staffSwapped);
      return { integrations: staffSwapped };
    }
  }

  // 4. Ask any open Klaviyo tab to fetch in the page context (same-origin — always
  //    has the right cookies regardless of SameSite restrictions on the service worker).
  //    The result arrives via CACHE_INTEGRATIONS and gets pushed to the waiting ZD tab.
  try {
    const klaviyoTabs = await chrome.tabs.query({ url: 'https://www.klaviyo.com/*' });
    for (const tab of klaviyoTabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'FETCH_INTEGRATIONS_FOR_ACCOUNT', accountId }).catch(() => {});
    }
  } catch (_) {}

  // 5. Fall back to whatever is cached (stale or existing) — don't blank the panel
  //    if the fresh fetch failed. Show what we have while the async fetch above runs.
  if (cached) return { integrations: cached };
  const stale = await readStaleIntegrationsCache(accountId);
  if (stale) return { integrations: stale };

  return { integrations: [] };
}


function parseIntegrations(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const integrations = [];
    const seen = new Set();

    // Both tables use <tr> rows. Each integration row contains:
    //   div.integration_icon > img  (native: relative /media/images/... path)
    //   OR img src pointing to static.klaviyo.com  (OAuth apps: absolute URL)
    for (const row of doc.querySelectorAll('tr')) {
      const link = row.querySelector(
        'a[href*="/integration/"]:not([href*="recent-metrics"]):not([href*="/metrics"]),' +
        'a[href*="/applications/"]'
      );
      if (!link) continue;

      const name = link.textContent.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      // Extract icon — make relative paths absolute
      const img = row.querySelector('img');
      let iconUrl = img ? img.getAttribute('src') : null;
      if (iconUrl && iconUrl.startsWith('/')) {
        iconUrl = 'https://www.klaviyo.com' + iconUrl;
      }

      // "Disabled" text appears alongside the link inside the heading
      const heading = link.closest('h1,h2,h3,h4');
      const disabled = heading
        ? /disabled/i.test(heading.textContent.replace(link.textContent, ''))
        : false;

      // Capture the integration page URL (relative → absolute)
      const href = link.getAttribute('href') || '';
      const pageUrl = href.startsWith('http') ? href : href ? 'https://www.klaviyo.com' + href : null;

      integrations.push({ name, disabled, iconUrl, pageUrl });
    }

    return integrations;
  } catch (_) { return []; }
}

// ── Parse billing data from staffside /billing HTML ───────────────────────────
const BILLING_NAME_MAP = {
  'profiles + email': 'Email',
  'email': 'Email',
  'mobile messaging': 'SMS',
  'sms': 'SMS',
  'reviews': 'Reviews',
  'social marketing': 'Social',
  'social': 'Social',
  'customer hub': 'Customer Hub',
  'customer agent': 'Customer Agent',
  'helpdesk': 'Helpdesk',
  'advanced kdp': 'Advanced KDP',
  'marketing analytics': 'Analytics',
  'analytics': 'Analytics',
  'success and support package': 'Success',
  'klaviyo success and support package': 'Success',
};

function formatBillingPrice(price) {
  return `$${price % 1 === 0 ? price.toFixed(0) : price.toFixed(2)}`;
}

function parseStaffsideBilling(html) {
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const bodyText = doc.body.innerText || doc.body.textContent || '';
    if (/manually[\s\-]?billed/i.test(bodyText)) {
      return { manuallyBilled: true, plans: [] };
    }
    const lines = bodyText.split('\n').map(l => l.trim()).filter(Boolean);
    const plans = [];

    // New format: "Email MRR: $500.00" lines in the summary section
    for (const line of lines) {
      const m = line.match(/^(.+?)\s+MRR:\s+\$(\d+(?:\.\d+)?)$/);
      if (!m) continue;
      const price = parseFloat(m[2]);
      if (price <= 0) continue;
      const lower = m[1].toLowerCase().trim();
      const name = BILLING_NAME_MAP[lower] || m[1].trim();
      plans.push({ name, price: formatBillingPrice(price) });
    }
    if (plans.length) return { manuallyBilled: false, plans };

    // Legacy format: "Profiles + email plan\n35k profiles ... / $500.00 / plan_id"
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(/\/\s*\$(\d+(?:\.\d+)?)\s*\//);
      if (!m) continue;
      const price = parseFloat(m[1]);
      if (price <= 0) continue;
      const lower = (lines[i - 1] || '').toLowerCase().replace(/\s*plan\s*$/, '').trim();
      const name = BILLING_NAME_MAP[lower] || null;
      if (name) plans.push({ name, price: formatBillingPrice(price) });
    }
    return plans.length ? { manuallyBilled: false, plans } : null;
  } catch (_) { return null; }
}

function cleanBillingPlanName(raw) {
  const lower = raw.toLowerCase().replace(/\s*plan\s*$/, '').trim();
  return BILLING_NAME_MAP[lower] || null;
}

async function readIntegrationsCache(accountId) {
  try {
    const key = 'klv_int_' + accountId;
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > INTEGRATIONS_CACHE_TTL_MS) return null;
    return entry.integrations;
  } catch (_) { return null; }
}

// Returns integrations regardless of TTL — last-resort fallback so the section
// never goes blank just because a live refresh failed.
async function readStaleIntegrationsCache(accountId) {
  try {
    const key = 'klv_int_' + accountId;
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry || !Array.isArray(entry.integrations) || !entry.integrations.length) return null;
    return entry.integrations;
  } catch (_) { return null; }
}

async function writeIntegrationsCache(accountId, integrations) {
  try {
    await chrome.storage.local.set({
      ['klv_int_' + accountId]: { integrations, cachedAt: Date.now() }
    });
  } catch (_) {}
}

async function deleteIntegrationsCache(accountId) {
  try { await chrome.storage.local.remove('klv_int_' + accountId); } catch (_) {}
}

// ── Billing cache ─────────────────────────────────────────────────────────────

const BILLING_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function readBillingCache(accountId) {
  try {
    const key = 'klv_billing_' + accountId;
    const result = await chrome.storage.local.get(key);
    const entry = result[key];
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > BILLING_CACHE_TTL_MS) return null;
    return entry.billing;
  } catch (_) { return null; }
}

async function writeBillingCache(accountId, billing) {
  try {
    await chrome.storage.local.set({
      ['klv_billing_' + accountId]: { billing, cachedAt: Date.now() }
    });
  } catch (_) {}
}

async function deleteBillingCache(accountId) {
  try { await chrome.storage.local.remove('klv_billing_' + accountId); } catch (_) {}
}

// ── Parse role + edit access from staffside HTML ──────────────────────────────

async function parseStaffsideData(html, email, accountId) {
  const captionMatch = html.match(/class="caption"[^>]*>([\s\S]*?)<\/div>/i);
  const captionText  = captionMatch ? captionMatch[1].replace(/<[^>]+>/g, '').trim() : '';
  const hasEditAccess = captionText.toLowerCase().includes('edit access granted');
  let accessExpiry = null;
  if (hasEditAccess) {
    const m = captionText.match(/Expires in (.+?)\.?\s*$/i);
    if (m) accessExpiry = m[1].trim();
  }

  let role = null;
  if (email) {
    const idx = html.toLowerCase().indexOf(email.toLowerCase());
    if (idx !== -1) {
      // Strip email addresses before matching role words so "admin@..." doesn't
      // get mistaken for the Admin role label.
      const snippet = html.slice(Math.max(0, idx - 400), idx + 400)
        .replace(/<[^>]+>/g, ' ')
        .replace(/\S+@\S+/g, ' ');
      const m = snippet.match(/\b(Owner|Admin|Analyst|Manager)\b/i);
      role = m ? m[1] : null;
    }
  }
  if (!role) role = extractRoleViaDom(html, email);
  if (!role && email) {
    const userPageUrl = extractUserPageUrl(html, email);
    if (userPageUrl) role = await fetchRoleFromUserPage(userPageUrl, accountId);
  }

  return { role, hasEditAccess, accessExpiry };
}

function extractRoleViaDom(html, email) {
  if (!email) return null;
  const target = email.toLowerCase().trim();
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const item of doc.querySelectorAll('li.user_item')) {
      if (!item.textContent.toLowerCase().includes(target)) continue;
      const s = Array.from(item.querySelectorAll('span')).find(s => ['Owner','Admin','Analyst','Manager'].includes(s.textContent.trim()));
      if (s) return s.textContent.trim();
      const el = Array.from(item.querySelectorAll('td,div,p')).find(el => el.childElementCount === 0 && ['Owner','Admin','Analyst','Manager'].includes(el.textContent.trim()));
      if (el) return el.textContent.trim();
    }
    for (const el of doc.querySelectorAll('tr,li,[class*="user"]')) {
      if (!el.textContent.toLowerCase().includes(target)) continue;
      const cleaned = el.textContent.replace(/\S+@\S+/g, ' ');
      const m = cleaned.match(/\b(Owner|Admin|Analyst|Manager)\b/);
      if (m) return m[1];
    }
  } catch (_) {}
  return null;
}

function extractUserPageUrl(html, email) {
  if (!email) return null;
  const idx = html.toLowerCase().indexOf(email.toLowerCase());
  if (idx === -1) return null;
  const win = html.slice(Math.max(0, idx - 500), idx + 200);
  const m = win.match(/href="(\/staff\/user\/[^"]+)"/i);
  return m ? 'https://www.klaviyo.com' + m[1] : null;
}

async function fetchRoleFromUserPage(userPageUrl, accountId) {
  try {
    const resp = await fetch(userPageUrl, { credentials: 'include' });
    if (!resp.ok) return null;
    const html = await resp.text();
    if (accountId) {
      const idx = html.toLowerCase().indexOf(accountId.toLowerCase());
      if (idx !== -1) {
        const m = html.slice(Math.max(0, idx - 50), idx + 200).match(/\/\s*(Owner|Admin|Analyst|Manager)\b/i);
        if (m) return m[1];
      }
    }
    const m = html.match(/\b(Owner|Admin|Analyst|Manager)\b/i);
    return m ? m[1] : null;
  } catch (_) { return null; }
}
