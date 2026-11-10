import axios from 'axios';

// 🌍 Server URL — dev default below; Settings → Privacy & Data → "Server URL"
//    (orbi_settings.apiBaseUrl) overrides it (self-hosting).
//    No static host_permissions in the manifest: requests are governed by the
//    server's CORS allow-list (backend allows chrome-extension:// origins).
//    Keep both origins in sync with public/background.js (SW can't import here).
export const DEFAULT_API_ORIGIN = 'http://127.0.0.1:5000';
// 🏢 Hosted production API (Cloudflare Worker + D1) — the Store-build default,
//    so sign-in and cloud sync work with zero configuration. Unpacked dev
//    loads keep the localhost default above.
export const STORED_API_ORIGIN = 'https://site-8b67ef3788b2498f88d007d22c888375.freebuff.page';
const trimOrigin = (v) => String(v || '').trim().replace(/\/+$/, '');

// 🏪 Same guard as public/background.js: a Store install must never silently
//    target localhost (that's the dev machine, not a real server) — it gets
//    the baked hosted origin instead. Chrome adds update_url only for
//    Store/enterprise installs; unpacked dev loads have none, so the dev
//    default still works locally.
const isStoreInstalled = () => {
  try { return !!globalThis.chrome?.runtime?.getManifest?.().update_url; } catch { return false; }
};

class ServerNotConfiguredError extends Error {
  constructor() {
    super('No cloud server configured — set the Server URL in Settings → Privacy & Data, or turn cloud sync off.');
    this.name = 'ServerNotConfiguredError';
  }
}

const API = axios.create({ baseURL: `${DEFAULT_API_ORIGIN}/api` });

API.interceptors.request.use(async (req) => {
  let origin = '';
  try {
    const storage = globalThis.chrome?.storage?.local;
    if (storage) {
      const { orbi_settings: s } = await storage.get('orbi_settings');
      origin = trimOrigin(s?.apiBaseUrl);
    }
  } catch { /* keep the default origin */ }
  if (!origin) {
    origin = isStoreInstalled() ? STORED_API_ORIGIN : DEFAULT_API_ORIGIN;
    if (!origin) throw new ServerNotConfiguredError(); // defensive only — origin is always non-empty now
  }
  req.baseURL = `${origin}/api`;
  const token = localStorage.getItem('token');
  if (token) req.headers.Authorization = `Bearer ${token}`;
  return req;
});

// 🔑 Token pair helpers — the access JWT (7d) and the per-device rotating
//    refresh token (30d) live in BOTH localStorage (popup) and
//    chrome.storage.local (service worker mirror), so sign-in in the popup
//    is enough for background sync to refresh on its own.
const storeTokens = ({ token, refreshToken }) => {
  if (token) {
    localStorage.setItem('token', token);
    try { globalThis.chrome?.storage?.local?.set({ token }); } catch { /* SW mirror */ }
  }
  if (refreshToken) {
    localStorage.setItem('refreshToken', refreshToken);
    try { globalThis.chrome?.storage?.local?.set({ refreshToken }); } catch { /* SW mirror */ }
  }
};
export const saveTokens = storeTokens;

const clearAuth = () => {
  localStorage.removeItem('token');
  localStorage.removeItem('refreshToken');
  try { globalThis.chrome?.storage?.local?.remove(['token', 'refreshToken']); } catch { /* SW mirror */ }
  globalThis.dispatchEvent?.(new Event('orbitabs-auth-expired'));
};

// ⏰ 401 handling: EXPIRY is routine (7-day JWT), so first try the refresh
//    token ONCE and replay the original request. Only a dead refresh (revoked
//    / expired session, deleted account) falls through to sign-out — that's
//    when "Not connected" is the honest state. Requests without a token
//    (login/register/forgot-password) never reach this branch.
API.interceptors.response.use(
  (res) => res,
  async (err) => {
    const orig = err?.config;
    const status = err?.response?.status;
    const hasSession = !!localStorage.getItem('token');
    const isRefreshCall = !!orig?._skipAuthRefresh;
    if (status === 401 && hasSession && orig && !orig._retried && !isRefreshCall && localStorage.getItem('refreshToken')) {
      orig._retried = true;
      try {
        const r = await fetch(`${orig.baseURL}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: localStorage.getItem('refreshToken') }),
        });
        if (r.ok) {
          const d = await r.json().catch(() => ({}));
          if (d?.token) {
            storeTokens({ token: d.token, ...(d.refreshToken ? { refreshToken: d.refreshToken } : {}) });
            // AxiosHeaders exposes .set(); plain objects take a spread. Cover both.
            if (orig.headers && typeof orig.headers.set === 'function') orig.headers.set('Authorization', `Bearer ${d.token}`);
            else orig.headers = { ...orig.headers, Authorization: `Bearer ${d.token}` };
            return API.request(orig);
          }
        }
      } catch { /* network hiccup → treat the401 as real below */ }
    }
    if (status === 401 && hasSession) {
      clearAuth(); // zombie "connected" state must not survive a dead session
    }
    return Promise.reject(err);
  }
);

export const registerUser = (data) => API.post('/auth/register', data);
export const loginUser = (data) => API.post('/auth/login', data);
// 🔑 Sliding session — exchange the refresh token for a fresh access JWT.
export const refreshSession = (refreshToken) =>
  API.post('/auth/refresh', { refreshToken }, { _skipAuthRefresh: true });
// 💰 Entitlement — the SERVER says what this account may sync (A2).
export const getPlan = () => API.get('/me/plan');
// 🔑 Password recovery — server emails a single-use 30-min reset link.
export const forgotPassword = (email) => API.post('/auth/forgot-password', { email });
export const getSessions = () => API.get('/sessions');
export const createSession = (data) => API.post('/sessions', data);
// 🆕 Trash + Undo APIs (soft delete = undoable for 30 days)
export const deleteSession = (id) => API.delete(`/sessions/${id}`);        // → trash
export const restoreSession = (id) => API.post(`/sessions/${id}/restore`); // undo single
export const restoreBulkSessions = (ids) => API.post('/sessions/restore/bulk', { ids }); // undo bulk
export const getTrash = () => API.get('/sessions/trash');                  // trashed sessions
export const purgeSession = (id) => API.delete(`/sessions/${id}/purge`);   // forever (no undo)
export const emptyTrash = () => API.delete('/sessions/trash/purge');       // forever (no undo)
// 🆕 GDPR account deletion — removes the user AND all their cloud sessions
//     (password re-entry required server-side; local Chrome data untouched)
export const deleteAccount = (password) => API.delete('/auth/account', { data: { password } });

// 🕘 VERSION HISTORY (B7) — server-kept snapshots of a synced session.
//     Depth is tier-owned (3 free / 20 pro); restoring one is a real write
//     that every other device LWW-adopts on its next sync.
export const getVersions = (id) => API.get(`/sessions/${id}/versions`);
export const restoreVersion = (id, vid) => API.post(`/sessions/${id}/versions/${vid}/restore`);

// 🔗 SHARED SESSIONS (B5) — mint a 30-day link for one synced session;
//     preview/claim live on /api/shares/:token (the web dashboard claims).
export const shareSession = (id) => API.post(`/sessions/${id}/share`);
export const previewShare = (token) => API.get(`/shares/${token}`);
export const claimShare = (token) => API.post(`/shares/${token}`);

// 🛒 BILLING (B2) — hosted checkout (Lemon Squeezy MoR); the webhook is the
//     only thing that flips the plan server-side. 503 billing-not-configured
//     until the operator sets the LS env vars.
export const startCheckout = () => API.post('/billing/checkout');
export const getBillingConfig = () => API.get('/billing/config');