/**
 * Ember Studio — Notification Infrastructure Platform Dashboard
 * Browser-only SPA. Native ES Modules. No build step.
 * Strictly adheres to design.md / Ember Studio design system.
 *
 * Verified API surface:
 *   GET  /v1/dashboard-config                               (public)
 *   POST /v1/projects                                       (Cognito)
 *   POST /v1/projects/:id/api-keys                          (Cognito)
 *   DEL  /v1/projects/:id/api-keys/:kid                     (Cognito)
 *   POST /v1/projects/:id/templates                         (Cognito)
 *   GET  /v1/projects/:id/templates                         (Cognito)
 *   GET  /v1/projects/:id/notifications[?limit&cursor]      (Cognito)
 *   GET  /v1/campaigns                                      (API key)
 *   GET  /v1/campaigns/:id                                  (API key)
 *   POST /v1/campaigns/:id/pause|resume|cancel              (API key)
 *   POST /v1/notifications                                  (API key)
 */

import {
  buildCampaignPayload,
  buildNotificationPayload,
  buildPushPayload,
  maskToken,
  parseObjectJson,
  validateRecipient,
} from './form-utils.js';
import { createPkcePair, selectApiToken, tokenIsExpired } from './auth.js';

// ─────────────────────────────────────────────────────────────────────────────
// Session / storage keys
// ─────────────────────────────────────────────────────────────────────────────
const SESSION = {
  accessToken: 'nfy.access-token',
  projectId:   'nfy.project-id',
  apiKey:      'nfy.api-key',
  apiKeyProjectId: 'nfy.api-key-project-id',
  pkceVerifier: 'nfy.pkce-verifier',
  oauthState: 'nfy.oauth-state',
};

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────
let oauthConfig = null;
let templateVariables = ['name'];

/** Demo Mode — enabled by default so users can immediately experience Ember Studio */
let isDemoMode = window.NOTIFICATION_MVP_CONFIG?.demoMode === true;

const MOCK_DATA = {
  notifications: [
    { notificationId: 'ntf_9f81a7b201', recipient: 'sarah.connor@acme.io', channel: 'email', templateSlug: 'welcome-onboarding', status: 'delivered', createdAt: new Date(Date.now() - 4 * 60000).toISOString(), updatedAt: new Date(Date.now() - 3 * 60000).toISOString() },
    { notificationId: 'ntf_3c42e1d876', recipient: '+14155552671', channel: 'sms', templateSlug: 'otp-verification', status: 'delivered', createdAt: new Date(Date.now() - 14 * 60000).toISOString(), updatedAt: new Date(Date.now() - 13 * 60000).toISOString() },
    { notificationId: 'ntf_88a91c0e34', recipient: 'device_usr_88291a', channel: 'push', templateSlug: 'security-alert', status: 'delivered', createdAt: new Date(Date.now() - 28 * 60000).toISOString(), updatedAt: new Date(Date.now() - 27 * 60000).toISOString() },
    { notificationId: 'ntf_5b72f44a19', recipient: 'alex.rivera@fintech.co', channel: 'email', templateSlug: 'invoice-receipt', status: 'sent', createdAt: new Date(Date.now() - 42 * 60000).toISOString(), updatedAt: new Date(Date.now() - 42 * 60000).toISOString() },
    { notificationId: 'ntf_0d93ea7728', recipient: '+12125559812', channel: 'sms', templateSlug: 'payment-reminder', status: 'failed', createdAt: new Date(Date.now() - 65 * 60000).toISOString(), updatedAt: new Date(Date.now() - 64 * 60000).toISOString() },
    { notificationId: 'ntf_e4179bc345', recipient: 'elena.rostova@design.org', channel: 'email', templateSlug: 'weekly-digest', status: 'delivered', createdAt: new Date(Date.now() - 110 * 60000).toISOString(), updatedAt: new Date(Date.now() - 108 * 60000).toISOString() },
    { notificationId: 'ntf_210d7a83ef', recipient: 'device_usr_44019b', channel: 'push', templateSlug: 'project-update', status: 'delivered', createdAt: new Date(Date.now() - 160 * 60000).toISOString(), updatedAt: new Date(Date.now() - 159 * 60000).toISOString() },
    { notificationId: 'ntf_7718cd92aa', recipient: 'david.kim@enterprise.com', channel: 'email', templateSlug: 'welcome-onboarding', status: 'bounced', createdAt: new Date(Date.now() - 240 * 60000).toISOString(), updatedAt: new Date(Date.now() - 238 * 60000).toISOString() },
  ],
  campaigns: [
    {
      campaignId: 'cmp_autumn_launch_2026',
      projectId: 'prj_ember_studio_demo',
      templateSlug: 'autumn-product-release',
      templateVersion: 2,
      channel: 'email',
      state: 'running',
      total: 12450,
      processed: 9812,
      successful: 9680,
      failed: 132,
      pending: 2638,
      createdAt: new Date(Date.now() - 180 * 60000).toISOString(),
      updatedAt: new Date(Date.now() - 2 * 60000).toISOString(),
    },
    {
      campaignId: 'cmp_security_mfa_sms',
      projectId: 'prj_ember_studio_demo',
      templateSlug: 'mandatory-mfa-notice',
      templateVersion: 1,
      channel: 'sms',
      state: 'queued',
      total: 4200,
      processed: 0,
      successful: 0,
      failed: 0,
      pending: 4200,
      createdAt: new Date(Date.now() - 45 * 60000).toISOString(),
      updatedAt: new Date(Date.now() - 45 * 60000).toISOString(),
    },
    {
      campaignId: 'cmp_mobile_v3_push',
      projectId: 'prj_ember_studio_demo',
      templateSlug: 'app-update-available',
      templateVersion: 3,
      channel: 'push',
      state: 'completed',
      total: 28900,
      processed: 28900,
      successful: 28410,
      failed: 490,
      pending: 0,
      createdAt: new Date(Date.now() - 1440 * 60000).toISOString(),
      updatedAt: new Date(Date.now() - 600 * 60000).toISOString(),
    },
    {
      campaignId: 'cmp_onboarding_drip_emea',
      projectId: 'prj_ember_studio_demo',
      templateSlug: 'day-3-getting-started',
      templateVersion: 1,
      channel: 'email',
      state: 'paused',
      total: 6500,
      processed: 3100,
      successful: 3045,
      failed: 55,
      pending: 3400,
      createdAt: new Date(Date.now() - 2880 * 60000).toISOString(),
      updatedAt: new Date(Date.now() - 320 * 60000).toISOString(),
    },
  ],
  templates: [
    {
      slug: 'welcome-onboarding',
      subject: 'Welcome to Ember Studio, {{name}}',
      html: '<p>Welcome {{name}}, your account is now ready.</p>',
      state: 'published',
      variables: ['name', 'companyName'],
      version: 2,
      createdAt: new Date(Date.now() - 86400000 * 3).toISOString()
    },
    {
      slug: 'otp-verification',
      subject: 'Your one-time security code is {{code}}',
      html: '<p>Your verification code is: <strong>{{code}}</strong></p>',
      state: 'published',
      variables: ['code', 'expiresMinutes'],
      version: 1,
      createdAt: new Date(Date.now() - 86400000 * 5).toISOString()
    },
    {
      slug: 'invoice-receipt',
      subject: 'Payment receipt for invoice #{{invoiceId}}',
      html: '<p>Thank you for your payment of {{amount}}.</p>',
      state: 'published',
      variables: ['invoiceId', 'amount', 'dueDate'],
      version: 1,
      createdAt: new Date(Date.now() - 86400000 * 7).toISOString()
    }
  ]
};

let sessionTemplates = [];
let templateLoadError = null;
let templateMode = 'create';
let editingTemplate = null;
const deletingTemplateSlugs = new Set();

// Notification history state & cursor
let ntfNextCursor = null;
let ntfAllItems = [...MOCK_DATA.notifications];

// Campaigns raw data
let campaignsData = [...MOCK_DATA.campaigns];
let authorizedProjects = [];
let projectLoadSequence = 0;
let campaignPollTimer = null;
let sessionDevices = [];
let campaignSummaryReady = false;

// ─────────────────────────────────────────────────────────────────────────────
// Tiny DOM helpers
// ─────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'className') node.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  node.append(...children.filter(c => c != null));
  return node;
};
const text = (str) => document.createTextNode(str);

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────
const apiUrl = () => (($('api-url-input')?.value || window.NOTIFICATION_MVP_CONFIG?.apiBaseUrl || '').trim().replace(/\/$/, ''));
function requireApiUrl() {
  const value = apiUrl();
  if (!value) throw new Error('API URL is not configured. Set apiBaseUrl in config.js or enter it in Settings.');
  return value;
}

const jwtExpired = (token) => {
  return tokenIsExpired(token);
};

const accessToken = () => {
  const t = sessionStorage.getItem(SESSION.accessToken);
  return t && !jwtExpired(t) ? t : null;
};

const storedApiKey = () => sessionStorage.getItem(SESSION.apiKey);
const storedApiKeyProjectId = () => sessionStorage.getItem(SESSION.apiKeyProjectId);
const storedProjectId = () => sessionStorage.getItem(SESSION.projectId);

async function payload(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw { ...data, status: response.status, statusText: response.statusText, kind: 'http' };
  return data;
}

async function adminRequest(path, method = 'GET', body) {
  const token = accessToken();
  if (!token) throw { status: 401, error: 'Authentication required' };
  const url = `${requireApiUrl()}${path}`;
  try {
    return await payload(await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    }));
  } catch (err) {
    if (err?.kind === 'http' || err?.status) throw err;
    throw { kind: 'network', method, url, cause: err };
  }
}

async function loadAuthorizedProjects() {
  const sequence = ++projectLoadSequence;
  const selector = $('project-selector');
  if (!selector || !accessToken()) return;
  selector.disabled = true;
  try {
    const data = await adminRequest('/v1/projects');
    if (sequence !== projectLoadSequence) return;
    authorizedProjects = Array.isArray(data.projects) ? data.projects : [];
    const saved = storedProjectId();
    const selected = authorizedProjects.some((project) => project.projectId === saved) ? saved : authorizedProjects[0]?.projectId || '';
    selector.innerHTML = authorizedProjects.length ? authorizedProjects.map((project) => `<option value="${escHtml(project.projectId)}">${escHtml(project.name || project.projectId)}</option>`).join('') : '<option value="">No authorized projects</option>';
    selector.value = selected;
    $('proj-delete-btn').disabled = !selected;
    if (selected !== saved) {
      if (selected) sessionStorage.setItem(SESSION.projectId, selected); else sessionStorage.removeItem(SESSION.projectId);
      sessionStorage.removeItem(SESSION.apiKey);
      sessionStorage.removeItem(SESSION.apiKeyProjectId);
    }
    selector.disabled = false;
    $('project-selector-status').textContent = authorizedProjects.length ? 'Select an authorized project to view its data.' : 'No authorized projects are available.';
    updateAuthUi();
  } catch (err) {
    if (sequence !== projectLoadSequence) return;
    selector.innerHTML = '<option value="">Projects unavailable</option>';
    selector.disabled = false;
    $('project-selector-status').textContent = friendlyError(err);
  }
}

async function switchProject(projectId) {
  if (!authorizedProjects.some((project) => project.projectId === projectId)) return;
  sessionStorage.setItem(SESSION.projectId, projectId);
  sessionStorage.removeItem(SESSION.apiKey);
  sessionStorage.removeItem(SESSION.apiKeyProjectId);
  sessionTemplates = [];
  campaignsData = [];
  ntfAllItems = [];
  updateAuthUi();
  loadTemplates();
  loadNotifications();
  loadOverview();
}

async function apiKeyRequest(path, method = 'GET', body) {
  const key = storedApiKey();
  if (!key) throw new Error('No API key stored. Create one in Project & API Keys.');
  return payload(await fetch(`${requireApiUrl()}${path}`, {
    method,
    headers: {
      'x-api-key': key,
      'content-type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  }));
}

const friendlyError = (err) => {
  const detail = err?.error || err?.message || 'The request could not be completed.';
  if (err?.status === 401) return 'Session expired or not authenticated. Please log in.';
  if (err?.status === 403) return 'The signed-in user is not authorized for this project.';
  if (err?.status === 404) return err?.code === 'TEMPLATE_NOT_FOUND' ? 'Template not found; refresh the Templates page.' : 'The requested API resource was not found.';
  if (err?.status === 409) {
    if (err?.code === 'TEMPLATE_VERSION_CONFLICT') return 'This template changed elsewhere. Refresh it and try again.';
    if (err?.code === 'TEMPLATE_SLUG_EXISTS') return 'A template with this slug already exists. Edit it or choose a different slug.';
    return detail;
  }
  if (err?.kind === 'network') return `Could not reach the API for ${err.method} ${err.url}. This may be a network or CORS preflight failure; verify the API URL and that ${err.method} is allowed by the deployed API.`;
  if (/Published template not found/i.test(detail)) return 'Template not found or not published.';
  if (/valid email/i.test(detail)) return 'Enter a valid recipient email address.';
  if (/suppressed|opted.?out/i.test(detail)) return 'One or more recipients are suppressed or opted out.';
  if (/rate limit/i.test(detail)) return 'The project rate limit was reached. Try again shortly.';
  if (/provider/i.test(detail)) return 'The delivery provider rejected the request. Check provider configuration.';
  if (/Missing template variable/i.test(detail)) return detail;
  if (err?.status >= 500) {
    return err?.requestId
      ? `The server could not complete this request. Try again later. Request ID: ${err.requestId}`
      : 'The server could not complete this request. Try again later.';
  }
  if (/network|fetch|failed to fetch/i.test(String(err))) return 'Network or CORS error — check the API URL and browser connection details.';
  return detail;
};

// ─────────────────────────────────────────────────────────────────────────────
// Toast notifications
// ─────────────────────────────────────────────────────────────────────────────
function toast(message, type = 'info', durationMs = 4000) {
  const icons = {
    success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    info:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
  };
  const div = document.createElement('div');
  div.className = `toast toast-${type}`;
  div.setAttribute('role', 'alert');
  div.innerHTML = `${icons[type] ?? icons.info}<span>${escHtml(message)}</span>`;
  $('toast-container').append(div);
  setTimeout(() => {
    div.classList.add('removing');
    div.addEventListener('animationend', () => div.remove());
  }, durationMs);
}

// ─────────────────────────────────────────────────────────────────────────────
// Confirm modal
// ─────────────────────────────────────────────────────────────────────────────
function confirm(titleStr, bodyStr, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    $('confirm-modal-title').textContent = titleStr;
    $('confirm-modal-body').textContent = bodyStr;
    $('confirm-modal-ok').textContent = okLabel;
    $('confirm-modal').classList.add('open');

    const close = (result) => {
      $('confirm-modal').classList.remove('open');
      resolve(result);
    };
    const onOk = () => { cleanUp(); close(true); };
    const onCancel = () => { cleanUp(); close(false); };
    const onBackdrop = (e) => { if (e.target === $('confirm-modal')) { cleanUp(); close(false); } };
    const cleanUp = () => {
      $('confirm-modal-ok').removeEventListener('click', onOk);
      $('confirm-modal-cancel').removeEventListener('click', onCancel);
      $('confirm-modal-close').removeEventListener('click', onCancel);
      $('confirm-modal').removeEventListener('click', onBackdrop);
    };
    $('confirm-modal-ok').addEventListener('click', onOk);
    $('confirm-modal-cancel').addEventListener('click', onCancel);
    $('confirm-modal-close').addEventListener('click', onCancel);
    $('confirm-modal').addEventListener('click', onBackdrop);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Routing / navigation
// ─────────────────────────────────────────────────────────────────────────────
const PAGE_TITLES = {
  overview:          'Infrastructure Overview',
  campaigns:         'Bulk Campaigns',
  'campaign-detail': 'Campaign Detail',
  notifications:     'Delivery History',
  templates:         'Message Templates',
  project:           'Project & API Keys',
  send:              'Send Notification',
  settings:          'Platform Settings',
};

function navigateTo(pageId) {
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    const active = item.dataset.page === pageId;
    item.classList.toggle('active', active);
    item.setAttribute('aria-current', active ? 'page' : 'false');
  });

  document.querySelectorAll('.page').forEach(page => {
    page.classList.toggle('active', page.id === `page-${pageId}`);
  });

  $('topbar-title').textContent = PAGE_TITLES[pageId] ?? pageId;
  $('main-content').scrollTop = 0;
  onPageLoad(pageId);
}

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-page]');
  if (target) {
    e.preventDefault();
    navigateTo(target.dataset.page);
  }
});

document.querySelectorAll('.nav-item[data-page]').forEach(item => {
  item.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo(item.dataset.page); }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Auth helpers
// ─────────────────────────────────────────────────────────────────────────────
async function loadOAuthConfig() {
  if (oauthConfig) return;
  oauthConfig = await payload(await fetch(`${requireApiUrl()}/v1/dashboard-config`));
  if (!oauthConfig.cognitoClientId || !oauthConfig.cognitoDomain) {
    throw new Error('Cognito configuration is unavailable from /v1/dashboard-config.');
  }
}

async function completeLogin() {
  const params = new URLSearchParams(location.search);
  if (params.get('error')) throw new Error(params.get('error_description') || 'Cognito login was cancelled.');
  const code = params.get('code');
  if (!code) return;
  if (params.get('state') !== sessionStorage.getItem(SESSION.oauthState)) {
    throw new Error('Cognito login state validation failed. Please try again.');
  }
  const redirectUri = `${location.origin}${location.pathname}`;
  const response = await fetch(`${oauthConfig.cognitoDomain}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oauthConfig.cognitoClientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: sessionStorage.getItem(SESSION.pkceVerifier) || '',
    }),
  });
  const tokens = await payload(response);
  const apiToken = selectApiToken(tokens);
  if (!apiToken) throw new Error('Cognito did not return a usable API token.');
  sessionStorage.setItem(SESSION.accessToken, apiToken);
  sessionStorage.removeItem(SESSION.pkceVerifier);
  sessionStorage.removeItem(SESSION.oauthState);
  history.replaceState({}, document.title, location.pathname);
}

async function triggerLogin() {
  if (!oauthConfig) { toast('Cannot load OAuth config — check the API URL.', 'error'); return; }
  const { verifier, challenge } = await createPkcePair();
  const stateBytes = new Uint8Array(24);
  crypto.getRandomValues(stateBytes);
  const state = [...stateBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  sessionStorage.setItem(SESSION.pkceVerifier, verifier);
  sessionStorage.setItem(SESSION.oauthState, state);
  const redirectUri = `${location.origin}${location.pathname}`;
  location.assign(`${oauthConfig.cognitoDomain}/login?${new URLSearchParams({
    response_type: 'code',
    client_id: oauthConfig.cognitoClientId,
    redirect_uri: redirectUri,
    scope: 'openid email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })}`);
}

function triggerLogout() {
  const domain = oauthConfig?.cognitoDomain;
  sessionStorage.clear();
  updateAuthUi();
  if (domain && oauthConfig?.cognitoClientId) {
    location.assign(`${domain}/logout?${new URLSearchParams({
      client_id: oauthConfig.cognitoClientId,
      logout_uri: `${location.origin}${location.pathname}`,
    })}`);
  }
}

function updateAuthUi() {
  const signedIn = Boolean(accessToken());
  const hasKey = Boolean(storedApiKey());

  $('auth-user-label').textContent = signedIn ? 'Signed in (Cognito)' : 'Not signed in';

  $('sidebar-auth-label').textContent = signedIn ? 'Sign Out' : 'Login';
  $('sidebar-auth-action').dataset.auth = signedIn ? 'logout' : 'login';

  if ($('settings-auth-state')) {
    $('settings-auth-state').textContent = signedIn
      ? 'Authenticated with AWS Cognito. You can perform protected project management actions.'
      : 'Not signed in. Log in to create projects, templates, and API keys.';
    $('settings-login-btn').classList.toggle('hidden', signedIn);
    $('settings-logout-btn').classList.toggle('hidden', !signedIn);
  }

  if ($('key-session-status')) {
    $('key-session-status').textContent = hasKey ? 'Active in session' : 'None stored';
    $('key-session-status').style.color = hasKey ? 'var(--success)' : 'var(--warning)';
  }

  const projId = storedProjectId();
  if ($('proj-id-input') && projId) $('proj-id-input').value = projId;
  if ($('settings-api-url')) $('settings-api-url').value = apiUrl();
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────
const escHtml = (str) => String(str)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function statusBadge(status) {
  const cls = `badge badge-${(status || 'default').toLowerCase()}`;
  return `<span class="${cls}">${escHtml(status || '—')}</span>`;
}

function channelChip(channel) {
  const c = (channel || 'email').toLowerCase();
  return `<span class="channel-chip ${c}">${escHtml(c.toUpperCase())}</span>`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour:'2-digit', minute:'2-digit' });
  } catch { return iso; }
}

function fmtRelative(iso) {
  if (!iso) return '—';
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000)  return 'just now';
    if (diff < 3600000) return `${Math.floor(diff/60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff/3600000)}h ago`;
    return `${Math.floor(diff/86400000)}d ago`;
  } catch { return iso; }
}

function progressHtml(campaign) {
  const total = Number.isFinite(campaign.total) ? campaign.total : 0;
  const processed = Number.isFinite(campaign.processed) ? campaign.processed : 0;
  const pct = total > 0
    ? Math.round((processed / total) * 100)
    : 0;
  const fillClass = (campaign.failed ?? 0) > 0 && pct === 100 ? 'warning' : '';
  return `
    <div style="min-width:100px;">
      <div class="progress-wrap">
        <div class="progress-fill ${fillClass}" style="width:${pct}%"></div>
      </div>
       <span class="text-sm text-muted" style="margin-top:4px;display:block;font-size:12px;">${pct}% (${processed}/${total})</span>
    </div>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visualizations (Ember Studio SVG Charts)
// ─────────────────────────────────────────────────────────────────────────────
function renderDeliveryAreaChart(notifications) {
  const container = $('overview-chart-wrap');
  if (!container) return;
  if (!notifications || notifications.length === 0) {
    container.innerHTML = `<span class="text-sm text-muted">No delivery events available in this project yet.</span>`;
    return;
  }

  // Group notifications into chronologically ordered buckets based on real timestamps
  const sorted = [...notifications].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  // Create 6-8 interval points from real data
  const pointCount = Math.min(Math.max(sorted.length, 3), 8);
  const chunk = Math.ceil(sorted.length / pointCount);
  const dataPoints = [];

  for (let i = 0; i < sorted.length; i += chunk) {
    const slice = sorted.slice(i, i + chunk);
    const date = new Date(slice[slice.length - 1].createdAt);
    const label = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    dataPoints.push({ label, count: slice.length });
  }

  const w = 560;
  const h = 160;
  const pTop = 20;
  const pBottom = 28;
  const pLeft = 32;
  const pRight = 20;

  const innerW = w - pLeft - pRight;
  const innerH = h - pTop - pBottom;

  const maxVal = Math.max(...dataPoints.map(d => d.count), 1);
  const coords = dataPoints.map((d, idx) => {
    const x = pLeft + (idx / (dataPoints.length - 1 || 1)) * innerW;
    const y = pTop + innerH - (d.count / maxVal) * innerH;
    return { x, y, ...d };
  });

  const pathD = coords.reduce((acc, pt, i) => `${acc} ${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`, '');
  const areaD = `${pathD} L ${coords[coords.length - 1].x.toFixed(1)},${(pTop + innerH).toFixed(1)} L ${coords[0].x.toFixed(1)},${(pTop + innerH).toFixed(1)} Z`;

  container.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}" class="chart-svg" preserveAspectRatio="none">
      <defs>
        <linearGradient id="terracotta-grad" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="#C2410C" stop-opacity="0.4" />
          <stop offset="100%" stop-color="#C2410C" stop-opacity="0.0" />
        </linearGradient>
      </defs>
      <g class="chart-grid">
        <line x1="${pLeft}" y1="${pTop}" x2="${w - pRight}" y2="${pTop}" />
        <line x1="${pLeft}" y1="${pTop + innerH / 2}" x2="${w - pRight}" y2="${pTop + innerH / 2}" />
        <line x1="${pLeft}" y1="${pTop + innerH}" x2="${w - pRight}" y2="${pTop + innerH}" />
      </g>
      <path d="${areaD}" class="chart-area" />
      <path d="${pathD}" class="chart-line" />
      ${coords.map(pt => `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3.5" class="chart-point"><title>${pt.label}: ${pt.count} events</title></circle>`).join('')}
      <g class="chart-axis">
        ${coords.map(pt => `<text x="${pt.x.toFixed(1)}" y="${h - 8}" text-anchor="middle">${pt.label}</text>`).join('')}
      </g>
    </svg>
  `;
}

function renderChannelDonut(channels) {
  const container = $('overview-donut-wrap');
  if (!container) return;

  const total = channels.email + channels.sms + channels.push;
  if (total === 0) {
    container.innerHTML = `<span class="text-sm text-muted">No channel activity recorded.</span>`;
    return;
  }

  // Circumference of 100 diameter circle = pi * 100 = 314.16
  const circ = 2 * Math.PI * 45; // radius 45, viewBox 120x120
  const emailPct = channels.email / total;
  const smsPct   = channels.sms / total;
  const pushPct  = channels.push / total;

  const emailDash = (emailPct * circ).toFixed(1);
  const smsDash   = (smsPct * circ).toFixed(1);
  const pushDash  = (pushPct * circ).toFixed(1);

  const smsOffset = -((emailPct) * circ);
  const pushOffset = -((emailPct + smsPct) * circ);

  container.innerHTML = `
    <div class="donut-wrap">
      <svg viewBox="0 0 120 120" class="donut-svg">
        <circle cx="60" cy="60" r="45" fill="none" stroke="var(--border)" stroke-width="16" />
        <circle cx="60" cy="60" r="45" class="donut-segment" stroke="var(--ch-email)" stroke-dasharray="${emailDash} ${circ}" stroke-dashoffset="0" />
        <circle cx="60" cy="60" r="45" class="donut-segment" stroke="var(--ch-sms)" stroke-dasharray="${smsDash} ${circ}" stroke-dashoffset="${smsOffset}" />
        <circle cx="60" cy="60" r="45" class="donut-segment" stroke="var(--ch-push)" stroke-dasharray="${pushDash} ${circ}" stroke-dashoffset="${pushOffset}" />
      </svg>
      <div style="display:flex;flex-direction:column;gap:8px;font-size:13px;">
        <div class="flex items-center gap-8">
          <div style="width:10px;height:10px;border-radius:2px;background:var(--ch-email);"></div>
          <span>Email: <strong>${channels.email}</strong> (${Math.round(emailPct * 100)}%)</span>
        </div>
        <div class="flex items-center gap-8">
          <div style="width:10px;height:10px;border-radius:2px;background:var(--ch-sms);"></div>
          <span>SMS: <strong>${channels.sms}</strong> (${Math.round(smsPct * 100)}%)</span>
        </div>
        <div class="flex items-center gap-8">
          <div style="width:10px;height:10px;border-radius:2px;background:var(--ch-push);"></div>
          <span>Push: <strong>${channels.push}</strong> (${Math.round(pushPct * 100)}%)</span>
        </div>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Overview
// ─────────────────────────────────────────────────────────────────────────────
async function loadOverview() {
  const signedIn = Boolean(accessToken());
  const projectId = storedProjectId();
  const hasKey = Boolean(storedApiKey());

  // In demo mode or signed in, hide the unauthenticated prompt
  $('overview-auth-notice').classList.toggle('hidden', signedIn || isDemoMode);

  if (isDemoMode && (!signedIn || !projectId)) {
    // Populate rich realistic metrics from MOCK_DATA
    const notifications = MOCK_DATA.notifications;
    const total = 54200;
    const delivered = 52780;
    const failed = 1420;
    const deliveredPct = 97;
    const failedPct = 3;

    $('stat-total').textContent = total.toLocaleString();
    $('stat-delivered').textContent = delivered.toLocaleString();
    $('stat-delivered-pct').textContent = `${deliveredPct}% delivery rate`;
    $('stat-failed').textContent = failed.toLocaleString();
    $('stat-failed-pct').textContent = `${failedPct}% failure rate`;
    $('stat-campaigns').textContent = '2';
    $('stat-total-campaigns').textContent = MOCK_DATA.campaigns.length.toLocaleString();

    const channels = { email: 32400, sms: 14200, push: 7600 };
    renderDeliveryAreaChart(notifications);
    renderChannelDonut(channels);
    renderOverviewNtfTable(notifications);

    // Active campaigns preview
    const active = MOCK_DATA.campaigns.filter(c => ['queued','running','paused'].includes(c.state));
    const container = $('overview-campaigns-list');
    if (container) {
      container.innerHTML = active.slice(0, 4).map(c => {
        const pct = c.total > 0 ? Math.round((c.processed / c.total) * 100) : 0;
        return `
          <div style="display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid var(--border);">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
              <span class="truncate" style="font-size:14px;font-weight:600;max-width:180px;" title="${escHtml(c.campaignId)}">${escHtml(c.templateSlug || c.campaignId)}</span>
              ${statusBadge(c.state)}
            </div>
            <div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>
            <span class="text-sm text-muted">${pct}% · ${c.total.toLocaleString()} recipients</span>
          </div>`;
      }).join('');
    }
    return;
  }

  loadOverviewCampaigns(hasKey);

  if (signedIn && projectId) {
    loadOverviewStats(projectId);
  } else {
    ['stat-total','stat-delivered','stat-failed','stat-campaigns','stat-total-campaigns'].forEach(id => {
      const e = $(id); if (e) e.textContent = '—';
    });
    $('overview-ntf-tbody').innerHTML = `<tr><td colspan="5"><div class="state-empty"><h3>Sign in to view real project data</h3><p>Authenticate with AWS Cognito to retrieve DynamoDB telemetry.</p></div></td></tr>`;
    if ($('overview-chart-wrap')) $('overview-chart-wrap').innerHTML = `<span class="text-sm text-muted">Awaiting authentication…</span>`;
    if ($('overview-donut-wrap')) $('overview-donut-wrap').innerHTML = `<span class="text-sm text-muted">Awaiting authentication…</span>`;
  }
}

async function loadOverviewStats(projectId) {
  try {
    const data = await adminRequest(`/v1/projects/${projectId}/notifications?limit=50`);
    const notifications = data.notifications || [];

    const total = notifications.length;
    const delivered = notifications.filter(n => ['delivered','sent'].includes(n.status)).length;
    const failed = notifications.filter(n => ['failed','bounced'].includes(n.status)).length;
    const deliveredPct = total > 0 ? Math.round((delivered / total) * 100) : 0;
    const failedPct    = total > 0 ? Math.round((failed    / total) * 100) : 0;

    $('stat-total').textContent = total.toLocaleString();
    $('stat-delivered').textContent = delivered.toLocaleString();
    $('stat-delivered-pct').textContent = total > 0 ? `${deliveredPct}% delivery rate` : 'No events';
    $('stat-failed').textContent = failed.toLocaleString();
    $('stat-failed-pct').textContent = total > 0 ? `${failedPct}% failure rate` : '0%';

    const channels = { email: 0, sms: 0, push: 0 };
    for (const n of notifications) {
      const ch = (n.channel || 'email').toLowerCase();
      if (ch in channels) channels[ch]++;
    }

    renderDeliveryAreaChart(notifications);
    renderChannelDonut(channels);
    renderOverviewNtfTable(notifications.slice(0, 8));
    ntfAllItems = notifications;
  } catch (err) {
    $('overview-ntf-tbody').innerHTML = `<tr><td colspan="5"><div class="state-empty"><h3>${escHtml(friendlyError(err))}</h3></div></td></tr>`;
  }
}

function renderOverviewNtfTable(items) {
  if (!items.length) {
    $('overview-ntf-tbody').innerHTML = `<tr><td colspan="5"><div class="state-empty"><h3>No notifications recorded</h3><p>Trigger your first dispatch from the Send Notification section.</p></div></td></tr>`;
    return;
  }
  $('overview-ntf-tbody').innerHTML = items.map(n => `
    <tr>
      <td class="text-mono truncate" style="max-width:180px;" title="${escHtml(n.recipient || '')}">${escHtml(n.recipient || '—')}</td>
      <td>${channelChip(n.channel)}</td>
      <td class="text-mono truncate" style="max-width:130px;">${escHtml(n.templateSlug || '—')}</td>
      <td>${statusBadge(n.status)}</td>
      <td class="text-muted text-sm">${fmtRelative(n.createdAt)}</td>
    </tr>
  `).join('');
}

async function loadOverviewCampaigns(hasKey) {
  const container = $('overview-campaigns-list');
  const completedContainer = $('overview-completed-campaigns-list');
  const projectId = storedProjectId();
  const apiKeyProjectId = storedApiKeyProjectId();
  if (!hasKey) {
    container.innerHTML = `<div class="state-empty" style="padding:16px 0;"><h3>API key required</h3><p>Configure an API key in Project & Keys to inspect active campaigns.</p></div>`;
    $('stat-campaigns').textContent = '—';
    $('stat-total-campaigns').textContent = '—';
    completedContainer.innerHTML = container.innerHTML;
    return;
  }
  if (!projectId || (apiKeyProjectId && apiKeyProjectId !== projectId)) {
    container.innerHTML = `<div class="state-empty" style="padding:16px 0;"><h3>Project API key mismatch</h3><p>Select the project that owns this API key, or configure a project-specific key.</p></div>`;
    $('stat-campaigns').textContent = '—';
    $('stat-total-campaigns').textContent = '—';
    completedContainer.innerHTML = container.innerHTML;
    return;
  }
  try {
    const data = await apiKeyRequest('/v1/campaigns');
    if (!Array.isArray(data.items)) throw { error: 'The campaign list response was invalid.', status: 502, kind: 'http' };
    const campaigns = data.items.filter(c => !c.projectId || c.projectId === projectId);
    const active = campaigns.filter(c => ['queued','running','paused'].includes(c.state));
    const completed = campaigns.filter(c => c.state === 'completed');
    $('stat-campaigns').textContent = active.length.toLocaleString();
    $('stat-total-campaigns').textContent = campaigns.length.toLocaleString();

    container.innerHTML = active.length ? active.slice(0, 4).map(c => {
      const pct = c.total > 0 ? Math.round((c.processed / c.total) * 100) : 0;
      return `
        <div style="display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid var(--border);">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
            <span class="truncate" style="font-size:14px;font-weight:600;max-width:180px;" title="${escHtml(c.campaignId)}">${escHtml(c.templateSlug || c.campaignId)}</span>
            ${statusBadge(c.state)}
          </div>
          <div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>
          <span class="text-sm text-muted">${pct}% · ${c.total.toLocaleString()} recipients</span>
        </div>`;
    }).join('') : `<div class="state-empty" style="padding:16px 0;"><h3>No Active Campaigns</h3><p>All broadcasts have completed or none have been scheduled.</p></div>`;
    completedContainer.innerHTML = completed.length ? completed.slice(0, 4).map(c => `
      <div style="display:flex;flex-direction:column;gap:6px;padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><span class="truncate" style="font-size:14px;font-weight:600;max-width:180px;" title="${escHtml(c.campaignId)}">${escHtml(c.templateSlug || c.campaignId)}</span>${statusBadge(c.state)}</div>
        <span class="text-sm text-muted">${Number(c.processed) || 0}/${Number(c.total) || 0} processed · ${Number(c.successful) || 0} successful · ${Number(c.failed) || 0} errors</span>
      </div>`).join('') : `<div class="state-empty" style="padding:16px 0;"><h3>${campaigns.length ? 'No Recently Completed Campaigns' : 'No Campaigns Yet'}</h3><p>${campaigns.length ? 'Completed campaigns will appear here.' : 'Create a campaign to see it here.'}</p></div>`;
  } catch (err) {
    container.innerHTML = `<div class="state-empty" style="padding:16px 0;"><h3>${escHtml(friendlyError(err))}</h3></div>`;
    completedContainer.innerHTML = container.innerHTML;
    $('stat-total-campaigns').textContent = '—';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Campaigns
// ─────────────────────────────────────────────────────────────────────────────
async function loadCampaigns() {
  const hasKey = Boolean(storedApiKey());
  $('campaigns-auth-notice').classList.toggle('hidden', hasKey || isDemoMode);

  if (isDemoMode && !hasKey) {
    renderCampaignsTable();
    return;
  }

  if (!hasKey) {
    $('campaigns-tbody').innerHTML = `<tr><td colspan="7"><div class="state-empty"><h3>API Key Required</h3><p>Campaign management uses API-key authentication. Generate one in Project & API Keys.</p></div></td></tr>`;
    return;
  }

  $('campaigns-tbody').innerHTML = `<tr><td colspan="7"><div class="state-loading"><div class="spinner"></div><span>Loading campaigns from DynamoDB…</span></div></td></tr>`;
  try {
    const data = await apiKeyRequest('/v1/campaigns');
    campaignsData = data.items || [];
    renderCampaignsTable();
  } catch (err) {
    $('campaigns-tbody').innerHTML = `<tr><td colspan="7"><div class="state-empty"><h3>${escHtml(friendlyError(err))}</h3></div></td></tr>`;
  }
}

function renderCampaignsTable() {
  const search = ($('campaigns-search')?.value ?? '').toLowerCase();
  const filterStatus  = $('campaigns-filter-status')?.value ?? '';
  const filterChannel = $('campaigns-filter-channel')?.value ?? '';

  const filtered = campaignsData.filter(c => {
    if (filterStatus  && c.state   !== filterStatus)  return false;
    if (filterChannel && c.channel !== filterChannel) return false;
    if (search) {
      const haystack = `${c.campaignId} ${c.templateSlug} ${c.channel} ${c.state}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    $('campaigns-tbody').innerHTML = `<tr><td colspan="7"><div class="state-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
      <h3>${campaignsData.length ? 'No Matching Campaigns' : 'No Campaigns Scheduled'}</h3>
      <p>${campaignsData.length ? 'Try clearing or modifying your active filters.' : 'Use the campaign API endpoint to schedule your first bulk dispatch.'}</p>
    </div></td></tr>`;
    return;
  }

  $('campaigns-tbody').innerHTML = filtered.map(c => {
    const canPause  = ['queued','running'].includes(c.state);
    const canResume = c.state === 'paused';
    const canCancel = ['queued','running','paused'].includes(c.state);

    return `
      <tr data-campaign-id="${escHtml(c.campaignId)}" style="cursor:pointer;" title="Click to view details">
        <td>
          <div style="font-weight:600;font-size:14px;" class="truncate" style="max-width:220px;">${escHtml(c.templateSlug || '—')}</div>
          <div class="text-mono text-muted" style="font-size:11px;margin-top:2px;">${escHtml(c.campaignId)}</div>
        </td>
        <td>${channelChip(c.channel)}</td>
        <td>${c.campaignId?.startsWith('cmp_demo_') ? '<span class="badge badge-warning">SIMULATED</span>' : statusBadge(c.state)}</td>
        <td>${progressHtml(c)}</td>
        <td>
          <div style="font-weight:600;">${(c.total ?? 0).toLocaleString()}</div>
          <div class="text-sm text-muted">
            <span style="color:var(--success)">${(c.successful ?? 0).toLocaleString()} ok</span> ·
            <span style="color:var(--error)">${(c.failed ?? 0).toLocaleString()} err</span>
          </div>
        </td>
        <td class="text-muted text-sm">${fmtDate(c.createdAt)}</td>
        <td style="text-align:right;">
          <div style="display:flex;gap:6px;justify-content:flex-end;" onclick="event.stopPropagation()">
            ${canPause  ? `<button class="btn btn-secondary btn-sm campaign-action-btn" data-id="${escHtml(c.campaignId)}" data-action="pause" aria-label="Pause campaign">Pause</button>` : ''}
            ${canResume ? `<button class="btn btn-primary btn-sm campaign-action-btn" data-id="${escHtml(c.campaignId)}" data-action="resume" aria-label="Resume campaign">Resume</button>` : ''}
            ${canCancel ? `<button class="btn btn-danger btn-sm campaign-action-btn" data-id="${escHtml(c.campaignId)}" data-action="cancel" aria-label="Cancel campaign">Cancel</button>` : ''}
          </div>
        </td>
      </tr>`;
  }).join('');

  $('campaigns-tbody').querySelectorAll('tr[data-campaign-id]').forEach(row => {
    row.addEventListener('click', () => openCampaignDetail(row.dataset.campaignId));
  });

  $('campaigns-tbody').querySelectorAll('.campaign-action-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleCampaignAction(btn.dataset.id, btn.dataset.action);
    });
  });
}

async function handleCampaignAction(campaignId, action) {
  const labels = { pause: 'Pause', resume: 'Resume', cancel: 'Cancel' };
  const descriptions = {
    pause:  'Pausing will halt pending recipient processing until explicitly resumed.',
    resume: 'Resuming will requeue the campaign for worker processing.',
    cancel: 'Cancelling is a destructive action that terminates recipient processing permanently.',
  };
  const confirmed = await confirm(
    `${labels[action]} Campaign`,
    descriptions[action],
    labels[action],
  );
  if (!confirmed) return;

  if (isDemoMode) {
    const targetState = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled';
    const idx = campaignsData.findIndex(c => c.campaignId === campaignId);
    if (idx !== -1) campaignsData[idx].state = targetState;
    toast(`Campaign ${action}d (demo state updated).`, 'success');
    renderCampaignsTable();
    return;
  }

  try {
    const result = await apiKeyRequest(`/v1/campaigns/${campaignId}/${action}`, 'POST');
    toast(`Campaign ${action}d successfully.`, 'success');
    const idx = campaignsData.findIndex(c => c.campaignId === campaignId);
    if (idx !== -1) campaignsData[idx].state = result.state;
    renderCampaignsTable();
    await loadCampaigns();
  } catch (err) {
    toast(friendlyError(err), 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Campaign Detail
// ─────────────────────────────────────────────────────────────────────────────
async function openCampaignDetail(campaignId) {
  navigateTo('campaign-detail');
  $('campaign-detail-heading').textContent = 'Campaign Detail';
  $('campaign-detail-actions').innerHTML = '';
  $('campaign-detail-content').innerHTML = `<div class="state-loading"><div class="spinner"></div><span>Loading campaign…</span></div>`;

  if (isDemoMode) {
    const mock = MOCK_DATA.campaigns.find(c => c.campaignId === campaignId) || campaignsData.find(c => c.campaignId === campaignId);
    if (mock) {
      renderCampaignDetail(mock);
      return;
    }
  }

  try {
    const c = await apiKeyRequest(`/v1/campaigns/${campaignId}`);
    renderCampaignDetail(c);
    if (['queued', 'running'].includes(c.state)) {
      clearInterval(campaignPollTimer);
      campaignPollTimer = setInterval(() => openCampaignDetail(campaignId), 10000);
    }
  } catch (err) {
    $('campaign-detail-content').innerHTML = `<div class="state-empty"><h3>${escHtml(friendlyError(err))}</h3></div>`;
  }
}

function renderCampaignDetail(c) {
  $('campaign-detail-heading').textContent = c.templateSlug || c.campaignId;

  const actions = $('campaign-detail-actions');
  actions.innerHTML = '';
  if (['queued','running'].includes(c.state)) {
    actions.append(el('button', { className:'btn btn-secondary btn-sm', onclick: () => handleDetailAction(c.campaignId, 'pause') }, text('Pause')));
  }
  if (c.state === 'paused') {
    actions.append(el('button', { className:'btn btn-primary btn-sm', onclick: () => handleDetailAction(c.campaignId, 'resume') }, text('Resume')));
  }
  if (['queued','running','paused'].includes(c.state)) {
    actions.append(el('button', { className:'btn btn-danger btn-sm', onclick: () => handleDetailAction(c.campaignId, 'cancel') }, text('Cancel')));
  }
  const refreshBtn = el('button', { className:'btn btn-secondary btn-sm', 'aria-label':'Refresh', onclick: () => openCampaignDetail(c.campaignId) });
  refreshBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.5"/></svg> Refresh`;
  actions.append(refreshBtn);

  const pct = c.total > 0 ? Math.round((c.processed / c.total) * 100) : 0;

  $('campaign-detail-content').innerHTML = `
    <div class="detail-grid">
      <div class="detail-stat">
        <div class="detail-stat-label">Status</div>
        <div style="margin-top:6px;">${statusBadge(c.state)}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Channel</div>
        <div style="margin-top:6px;">${channelChip(c.channel)}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Total Recipients</div>
        <div class="detail-stat-value">${(c.total ?? 0).toLocaleString()}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Processed</div>
        <div class="detail-stat-value">${(c.processed ?? 0).toLocaleString()}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Successful</div>
        <div class="detail-stat-value" style="color:var(--success)">${(c.successful ?? 0).toLocaleString()}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Failed</div>
        <div class="detail-stat-value" style="color:var(--error)">${(c.failed ?? 0).toLocaleString()}</div>
      </div>
      <div class="detail-stat">
        <div class="detail-stat-label">Pending Queue</div>
        <div class="detail-stat-value" style="color:var(--neutral)">${(c.pending ?? 0).toLocaleString()}</div>
      </div>
    </div>

    <!-- Progress card -->
    <div class="card" style="margin-bottom:20px;">
      <div class="card-header">
        <span class="card-title">Delivery Progress</span>
        <span class="text-sm text-muted">${pct}% completed</span>
      </div>
      <div class="progress-wrap" style="height:6px;">
        <div class="progress-fill ${c.failed > 0 ? 'warning' : ''}" style="width:${pct}%"></div>
      </div>
      ${c.failed > 0 ? `<p class="text-sm" style="margin-top:12px;color:var(--error);">${c.failed} delivery failures detected in this campaign.</p>` : ''}
    </div>

    <!-- Metadata card -->
    <div class="card">
      <div class="card-header"><span class="card-title">Campaign Specification</span></div>
      <div style="display:flex;flex-direction:column;gap:12px;" class="text-sm">
        <div class="flex gap-12"><span class="text-muted" style="min-width:140px;">Campaign ID</span><span class="text-mono">${escHtml(c.campaignId)}</span></div>
        <div class="flex gap-12"><span class="text-muted" style="min-width:140px;">Project ID</span><span class="text-mono">${escHtml(c.projectId || '—')}</span></div>
        <div class="flex gap-12"><span class="text-muted" style="min-width:140px;">Template Slug</span><span class="text-mono">${escHtml(c.templateSlug || '—')} (v${escHtml(String(c.templateVersion ?? 1))})</span></div>
        <div class="flex gap-12"><span class="text-muted" style="min-width:140px;">Created Date</span><span>${escHtml(fmtDate(c.createdAt))}</span></div>
        <div class="flex gap-12"><span class="text-muted" style="min-width:140px;">Last Updated</span><span>${escHtml(fmtDate(c.updatedAt))}</span></div>
      </div>
    </div>`;
}

async function handleDetailAction(campaignId, action) {
  const labels = { pause:'Pause', resume:'Resume', cancel:'Cancel' };
  const descriptions = {
    pause:  'Pausing will stop worker processing until resumed.',
    resume: 'Resuming will requeue this campaign for SQS delivery.',
    cancel: 'Cancelling is permanent and stops further deliveries.',
  };
  const confirmed = await confirm(`${labels[action]} Campaign`, descriptions[action], labels[action]);
  if (!confirmed) return;

  if (isDemoMode) {
    const targetState = action === 'pause' ? 'paused' : action === 'resume' ? 'running' : 'cancelled';
    const idx = campaignsData.findIndex(c => c.campaignId === campaignId);
    if (idx !== -1) campaignsData[idx].state = targetState;
    const mIdx = MOCK_DATA.campaigns.findIndex(c => c.campaignId === campaignId);
    if (mIdx !== -1) MOCK_DATA.campaigns[mIdx].state = targetState;
    toast(`Campaign ${action}d (demo state updated).`, 'success');
    renderCampaignsTable();
    await openCampaignDetail(campaignId);
    return;
  }

  try {
    await apiKeyRequest(`/v1/campaigns/${campaignId}/${action}`, 'POST');
    toast(`Campaign ${action}d.`, 'success');
    await loadCampaigns();
    await openCampaignDetail(campaignId);
  } catch (err) {
    toast(friendlyError(err), 'error');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Delivery History
// ─────────────────────────────────────────────────────────────────────────────
async function loadNotifications(append = false) {
  const signedIn = Boolean(accessToken());
  const projectId = storedProjectId();
  const notice = $('ntf-auth-notice');

  notice.classList.toggle('hidden', signedIn || isDemoMode);

  if (isDemoMode && (!signedIn || !projectId)) {
    ntfAllItems = [...MOCK_DATA.notifications];
    renderNtfTable();
    $('ntf-load-more-btn').classList.add('hidden');
    return;
  }

  if (!signedIn || !projectId) {
    $('ntf-tbody').innerHTML = `<tr><td colspan="7"><div class="state-empty"><h3>Sign In and Set a Project ID</h3><p>Protected telemetry requires an active Cognito session and a selected project.</p></div></td></tr>`;
    $('ntf-load-more-btn').classList.add('hidden');
    return;
  }

  if (!append) {
    ntfAllItems = [];
    ntfNextCursor = null;
    $('ntf-tbody').innerHTML = `<tr><td colspan="7"><div class="state-loading"><div class="spinner"></div><span>Loading notifications from DynamoDB…</span></div></td></tr>`;
  }

  try {
    const qs = ntfNextCursor
      ? `?limit=50&cursor=${encodeURIComponent(ntfNextCursor)}`
      : '?limit=50';
    const data = await adminRequest(`/v1/projects/${projectId}/notifications${qs}`);
    ntfAllItems = append ? [...ntfAllItems, ...(data.notifications || [])] : (data.notifications || []);
    ntfNextCursor = data.nextCursor || null;
    renderNtfTable();
    $('ntf-load-more-btn').classList.toggle('hidden', !ntfNextCursor);
  } catch (err) {
    $('ntf-tbody').innerHTML = `<tr><td colspan="7"><div class="state-empty"><h3>${escHtml(friendlyError(err))}</h3></div></td></tr>`;
    $('ntf-load-more-btn').classList.add('hidden');
  }
}

function renderNtfTable() {
  const search  = ($('ntf-search')?.value ?? '').toLowerCase();
  const fStatus  = $('ntf-filter-status')?.value ?? '';
  const fChannel = $('ntf-filter-channel')?.value ?? '';

  const filtered = ntfAllItems.filter(n => {
    if (fStatus  && n.status  !== fStatus)  return false;
    if (fChannel && n.channel !== fChannel) return false;
    if (search) {
      const hay = `${n.notificationId} ${n.recipient} ${n.templateSlug} ${n.status} ${n.channel}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    $('ntf-tbody').innerHTML = `<tr><td colspan="7"><div class="state-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      <h3>${ntfAllItems.length ? 'No Matching Records' : 'No Delivery Records'}</h3>
      <p>${ntfAllItems.length ? 'Try modifying your search or channel filters.' : 'Deliveries dispatched through the public endpoint will show here.'}</p>
    </div></td></tr>`;
    return;
  }

  $('ntf-tbody').innerHTML = filtered.map(n => `
    <tr>
      <td class="text-mono" style="font-size:12px;">${escHtml(n.notificationId || '—')}</td>
      <td class="text-mono truncate" style="max-width:180px;" title="${escHtml(n.recipient || '')}">${escHtml(n.recipient || '—')}</td>
      <td>${channelChip(n.channel)}</td>
      <td class="text-mono" style="font-size:12px;">${escHtml(n.templateSlug || '—')}</td>
      <td>${statusBadge(n.status)}</td>
      <td class="text-muted text-sm">${fmtDate(n.createdAt)}</td>
      <td class="text-muted text-sm">${n.updatedAt !== n.createdAt ? fmtDate(n.updatedAt) : '—'}</td>
    </tr>`).join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Templates
// ─────────────────────────────────────────────────────────────────────────────
async function loadTemplates() {
  if (isDemoMode) {
    templateLoadError = null;
    sessionTemplates = [...MOCK_DATA.templates];
    renderTemplatesGrid();
    return;
  }
  const projectId = storedProjectId();
  if (!accessToken() || !projectId) {
    templateLoadError = null;
    sessionTemplates = [];
    renderTemplatesGrid();
    return;
  }
  templateLoadError = null;
  $('templates-grid').innerHTML = '<div class="state-loading"><div class="spinner"></div><span>Loading persisted templates…</span></div>';
  try {
    const data = await adminRequest(`/v1/projects/${encodeURIComponent(projectId)}/templates`);
    sessionTemplates = Array.isArray(data.templates) ? data.templates : [];
  } catch (err) {
    sessionTemplates = [];
    templateLoadError = friendlyError(err);
  }
  renderTemplatesGrid();
}

function renderTemplatesGrid() {
  const grid = $('templates-grid');
  if (templateLoadError) {
    grid.innerHTML = `<div class="state-empty"><h3>Templates unavailable</h3><p>${escHtml(templateLoadError)}</p></div>`;
    return;
  }
  if (!sessionTemplates.length) {
    grid.innerHTML = `<div class="state-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <h3>No Templates Created</h3>
      <p>Click "New Template" above to define your first Handlebars message template.</p>
    </div>`;
    return;
  }
  grid.innerHTML = sessionTemplates.map(t => `
    <div class="template-card">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span class="template-slug">${escHtml(t.slug)}</span>
        ${statusBadge(t.state)}
      </div>
      <div class="template-subject" title="${escHtml(t.subject)}">${escHtml(t.subject)}</div>
      <div class="template-vars">
        ${(t.variables || []).map(v => `<span class="template-var">{{${escHtml(v)}}}</span>`).join('')}
      </div>
      <div class="text-sm text-muted" style="margin-top:4px;">v${t.version || 1} · Created ${fmtRelative(t.createdAt)}</div>
      <div class="template-actions" style="display:flex;gap:8px;margin-top:14px;">
        <button class="btn btn-secondary btn-sm" data-template-action="view" data-template-slug="${escHtml(t.slug)}">View</button>
        <button class="btn btn-secondary btn-sm" data-template-action="edit" data-template-slug="${escHtml(t.slug)}" ${isDemoMode ? 'disabled title="Demo templates are read-only"' : ''}>Edit</button>
        <button class="btn btn-danger btn-sm" data-template-action="delete" data-template-slug="${escHtml(t.slug)}" ${isDemoMode || deletingTemplateSlugs.has(t.slug) ? 'disabled title="Demo templates are read-only"' : ''}>${deletingTemplateSlugs.has(t.slug) ? 'Deleting…' : 'Delete'}</button>
      </div>
    </div>`).join('');
}

function templateBySlug(slug) {
  return sessionTemplates.find(template => template.slug === slug);
}

function openTemplateView(template) {
  $('template-view-title').textContent = template.slug;
  $('template-view-body').innerHTML = `<p><strong>Status:</strong> ${escHtml(template.state)}</p><p><strong>Version:</strong> ${escHtml(template.version || 1)}</p><p><strong>Subject:</strong> ${escHtml(template.subject)}</p><p><strong>HTML:</strong></p><pre style="white-space:pre-wrap;max-height:260px;overflow:auto;">${escHtml(template.html)}</pre>`;
  $('template-view-modal').classList.add('open');
}

async function deleteTemplate(template) {
  if (isDemoMode) { toast('Demo templates are read-only. Turn Demo Data off to manage persisted templates.', 'info'); return; }
  if (!(await confirm('Delete Template', `Delete "${template.slug}"? Existing version history is retained for delivery records.`, 'Delete'))) return;
  deletingTemplateSlugs.add(template.slug);
  renderTemplatesGrid();
  try {
    await adminRequest(`/v1/projects/${encodeURIComponent(storedProjectId())}/templates/${encodeURIComponent(template.slug)}`, 'DELETE');
    await loadTemplates();
    toast(`Template "${template.slug}" deleted.`, 'success');
  } catch (err) {
    toast(friendlyError(err), 'error');
  } finally {
    deletingTemplateSlugs.delete(template.slug);
    renderTemplatesGrid();
  }
}

async function submitTemplate() {
  const signedIn = Boolean(accessToken());
  const projectId = storedProjectId();
  if (!signedIn) { toast('Please sign in first.', 'error'); return; }
  if (!projectId) { toast('Please set a Project ID in Project & API Keys first.', 'error'); return; }

  const slug    = $('tpl-slug').value.trim();
  const subject = $('tpl-subject').value.trim();
  const html    = $('tpl-html').value.trim();
  const state   = $('tpl-state').value;

  $('tpl-error').textContent = '';

  if (!/^[a-z0-9-]+$/.test(slug)) { $('tpl-error').textContent = 'Slug must contain only lowercase letters, digits, and hyphens.'; return; }
  if (!subject) { $('tpl-error').textContent = 'Subject is required.'; return; }
  if (!html)    { $('tpl-error').textContent = 'HTML body is required.'; return; }

  const btn = $('tpl-modal-submit');
  btn.disabled = true;
   btn.textContent = 'Saving…';

  try {
    const isEdit = templateMode === 'edit';
    const path = isEdit
      ? `/v1/projects/${encodeURIComponent(projectId)}/templates/${encodeURIComponent(editingTemplate.slug)}`
      : `/v1/projects/${encodeURIComponent(projectId)}/templates`;
    const data = await adminRequest(path, isEdit ? 'PUT' : 'POST', isEdit
      ? { subject, html, state, expectedVersion: editingTemplate.version }
      : { slug, subject, html, state });
    await loadTemplates();
    closeTemplateModal();
    toast(isEdit ? `Template "${slug}" updated as ${state}.` : (state === 'published' ? `Template "${slug}" published.` : `Template "${slug}" saved as a draft.`), 'success');

    templateVariables = data.template.variables?.length ? data.template.variables : ['name'];
    renderSendFormVars();
  } catch (err) {
    $('tpl-error').textContent = friendlyError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = templateMode === 'edit' ? 'Save Changes' : 'Create Template';
  }
}

function openTemplateModal(template = null) {
  templateMode = template ? 'edit' : 'create';
  editingTemplate = templateMode === 'edit' ? template : null;
  $('tpl-error').textContent = '';
  $('template-modal-title').textContent = templateMode === 'edit' ? `Edit Template: ${template.slug}` : 'Create Template';
  $('tpl-modal-submit').textContent = templateMode === 'edit' ? 'Save Changes' : 'Create Template';
  $('tpl-slug').value = template?.slug || 'welcome';
  $('tpl-slug').disabled = Boolean(template);
  $('tpl-subject').value = template?.subject || 'Welcome, {{name}}';
  $('tpl-html').value = template?.html || '<p>Hello {{name}}, welcome to our platform!</p>';
  $('tpl-state').value = template?.state || 'published';
  $('template-modal').classList.add('open');
  (template ? $('tpl-subject') : $('tpl-slug')).focus();
}

function closeTemplateModal() {
  $('template-modal').classList.remove('open');
  templateMode = 'create';
  editingTemplate = null;
  $('tpl-slug').disabled = false;
  $('template-modal-title').textContent = 'Create Template';
  $('tpl-modal-submit').textContent = 'Create Template';
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Project & Keys
// ─────────────────────────────────────────────────────────────────────────────
async function createProject() {
  const signedIn = Boolean(accessToken());
  if (!signedIn) { toast('Please sign in with Cognito first.', 'error'); return; }

  const name = $('proj-name-input').value.trim() || 'Ember Workspace';
  $('proj-error').textContent = '';
  $('proj-success').classList.add('hidden');
  $('proj-create-btn').disabled = true;

  try {
    const data = await adminRequest('/v1/projects', 'POST', { name });
    $('proj-id-input').value = data.projectId;
    sessionStorage.setItem(SESSION.projectId, data.projectId);
    sessionStorage.removeItem(SESSION.apiKey);
    sessionStorage.removeItem(SESSION.apiKeyProjectId);
    $('proj-success-msg').textContent = `Project "${name}" registered: ${data.projectId}`;
    $('proj-success').classList.remove('hidden');
    updateAuthUi();
    toast('Project created successfully.', 'success');
  } catch (err) {
    $('proj-error').textContent = friendlyError(err);
  } finally {
    $('proj-create-btn').disabled = false;
  }
}

async function deleteProject() {
  const projectId = storedProjectId();
  const project = authorizedProjects.find((item) => item.projectId === projectId);
  if (!project || !projectId) return;
  if (!(await confirm('Delete Project', `Permanently delete project "${project.name || projectId}" (${projectId}) and all campaigns, notifications, delivery history, API keys, devices, custom templates, and template history? The built-in invoice-receipt, otp-verification, and welcome-onboarding templates will remain available to other projects. This cannot be undone.`, 'Delete Project'))) return;
  const button = $('proj-delete-btn');
  button.disabled = true;
  button.textContent = 'Deleting…';
  $('proj-error').textContent = '';
  try {
    await adminRequest(`/v1/projects/${encodeURIComponent(projectId)}`, 'DELETE');
    authorizedProjects = authorizedProjects.filter((item) => item.projectId !== projectId);
    sessionStorage.removeItem(SESSION.projectId);
    sessionStorage.removeItem(SESSION.apiKey);
    sessionStorage.removeItem(SESSION.apiKeyProjectId);
    sessionTemplates = [];
    campaignsData = [];
    ntfAllItems = [];
    sessionDevices = [];
    updateAuthUi();
    await loadAuthorizedProjects();
    const nextProjectId = storedProjectId();
    if (nextProjectId) await switchProject(nextProjectId);
    $('proj-success-msg').textContent = `Project "${project.name || projectId}" was deleted.`;
    $('proj-success').classList.remove('hidden');
    toast('Project deleted successfully.', 'success');
  } catch (err) {
    $('proj-error').textContent = friendlyError(err);
    button.disabled = false;
  } finally {
    button.textContent = 'Delete Selected Project';
  }
}

function saveProjectId() {
  const id = $('proj-id-input').value.trim();
  if (!id) { toast('Please enter a Project ID.', 'error'); return; }
  const previousId = storedProjectId();
  const hadApiKeyForDifferentProject = Boolean(storedApiKey() && storedApiKeyProjectId() !== id);
  sessionStorage.setItem(SESSION.projectId, id);
  if ((previousId && previousId !== id) || hadApiKeyForDifferentProject) {
    sessionStorage.removeItem(SESSION.apiKey);
    sessionStorage.removeItem(SESSION.apiKeyProjectId);
    toast('Project changed. Create a new API key for this project.', 'warning');
  }
  loadTemplates();
  updateAuthUi();
  if (!hadApiKeyForDifferentProject && (!previousId || previousId === id)) toast('Project ID saved to local session.', 'success');
}

async function createApiKey() {
  const signedIn = Boolean(accessToken());
  const projectId = storedProjectId();
  if (!signedIn) { toast('Please sign in with Cognito first.', 'error'); return; }
  if (!projectId) { toast('Please register or enter a Project ID first.', 'error'); return; }

  $('key-error').textContent = '';
  $('key-reveal-wrap').classList.add('hidden');
  $('key-create-btn').disabled = true;

  try {
    const data = await adminRequest(`/v1/projects/${projectId}/api-keys`, 'POST', { label: 'dashboard key' });
    sessionStorage.setItem(SESSION.apiKey, data.apiKey);
    sessionStorage.setItem(SESSION.apiKeyProjectId, projectId);
    $('key-reveal-value').textContent = data.apiKey;
    $('key-id-label').textContent = `Key ID: ${data.keyId}`;
    $('key-reveal-wrap').classList.remove('hidden');
    updateAuthUi();
    toast('API key created. Save it securely.', 'warning', 8000);
  } catch (err) {
    $('key-error').textContent = friendlyError(err);
  } finally {
    $('key-create-btn').disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page: Send Notification
// ─────────────────────────────────────────────────────────────────────────────
function updateSendChannel() {
  const channel = $('send-channel').value;
  const config = {
    email: { label: 'Recipient Email Address', type: 'email', placeholder: 'verified-user@example.com', hint: 'For SES sandbox testing, use an address verified in your AWS account.' },
    sms: { label: 'Recipient Phone Number', type: 'tel', placeholder: '+14155552671', hint: 'Use an E.164 number, for example +14155552671.' },
    push: { label: 'Recipient User Email', type: 'email', placeholder: 'user@example.com', hint: 'The recipient must have a registered FCM device.' },
  }[channel];
  $('send-recipient-label').textContent = config.label;
  $('send-recipient').type = config.type;
  $('send-recipient').placeholder = config.placeholder;
  $('send-recipient-hint').textContent = config.hint;
  $('send-push-fields').classList.toggle('hidden', channel !== 'push');
}

function renderSendFormVars() {
  const container = $('send-template-vars');
  container.innerHTML = '';
  if (!templateVariables.length) return;
  templateVariables.forEach(v => {
    const group = document.createElement('div');
    group.className = 'form-group';
    group.innerHTML = `
      <label class="form-label" for="send-var-${escHtml(v)}">${escHtml(v.replace(/([A-Z])/g, ' $1').replace(/^./, l => l.toUpperCase()))}</label>
      <input class="form-input" id="send-var-${escHtml(v)}" placeholder="Value for ${escHtml(v)}" required>`;
    container.append(group);
  });
}

function variablesFromSendTemplate() {
  const slug = $('send-template').value.trim();
  const match = sessionTemplates.find(t => t.slug === slug);
  if (match && match.variables?.length) {
    templateVariables = match.variables;
  } else {
    templateVariables = ['name'];
  }
  renderSendFormVars();
}

async function sendNotification() {
  const apiKey = storedApiKey();
  if (!apiKey && !isDemoMode) { toast('No API key in session. Create one in Project & API Keys.', 'error'); return; }

  const channel = $('send-channel').value;
  const recipient = $('send-recipient').value.trim();
  const template  = $('send-template').value.trim();
  if (!template)  { toast('Enter a template slug.', 'error'); return; }

  const data = {};
  for (const v of templateVariables) {
    const val = ($(`send-var-${v}`)?.value ?? '').trim();
    if (!val) { toast(`Please provide a value for variable "${v}".`, 'error'); return; }
    data[v] = val;
  }

  let requestBody;
  try {
    const push = channel === 'push' ? buildPushPayload({
      title: $('send-push-title').value,
      body: $('send-push-body').value,
      deepLink: $('send-push-deeplink').value,
      data: parseObjectJson($('send-push-data').value, 'Push custom data'),
    }) : undefined;
    requestBody = buildNotificationPayload({ template, channel, recipient, data, push });
  } catch (err) {
    toast(err.message, 'error');
    return;
  }

  $('send-btn').disabled = true;
  $('send-status').innerHTML = '';

  try {
    const result = isDemoMode
      ? { notificationId: `ntf_demo_${Date.now()}` }
      : await payload(await fetch(`${requireApiUrl()}/v1/notifications`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': crypto.randomUUID(),
        },
        body: JSON.stringify(requestBody),
      }));
    $('send-status').innerHTML = `
      <div class="alert alert-success" style="margin-top:16px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
        <span>Notification <strong>${escHtml(result.notificationId)}</strong> queued successfully. Dispatched via SQS.</span>
      </div>`;
    toast('Notification dispatched.', 'success');
  } catch (err) {
    $('send-status').innerHTML = `
      <div class="alert alert-error" style="margin-top:16px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        <span>${escHtml(friendlyError(err))}</span>
      </div>`;
  } finally {
    $('send-btn').disabled = false;
  }
}

// Campaign creation and device registration use the same session API key as dispatch.
function updateCampaignChannel() {
  $('cmp-push-fields').classList.toggle('hidden', $('cmp-channel').value !== 'push');
  $('cmp-dlt-fields').classList.toggle('hidden', $('cmp-channel').value !== 'sms');
  campaignSummaryReady = false;
  $('cmp-modal-submit').textContent = 'Review Campaign';
}

function closeCampaignModal() {
  $('campaign-modal').classList.remove('open');
  $('cmp-error').textContent = '';
  $('cmp-summary').classList.add('hidden');
  campaignSummaryReady = false;
  $('cmp-modal-submit').textContent = 'Create & Launch Campaign';
}

function openCampaignModal() {
  $('cmp-error').textContent = '';
  $('cmp-summary').classList.add('hidden');
  campaignSummaryReady = false;
  $('cmp-modal-submit').textContent = 'Review Campaign';
  updateCampaignChannel();
  $('campaign-modal').classList.add('open');
  $('cmp-template').focus();
}

function campaignFormPayload() {
  const channel = $('cmp-channel').value;
  const data = parseObjectJson($('cmp-data').value, 'Template variables data');
  const dltVariableMapping = channel === 'sms' ? $('cmp-dlt-mapping').value.split(',').map(value => value.trim()).filter(Boolean) : undefined;
  if (channel === 'sms' && dltVariableMapping.some(name => typeof data[name] !== 'string' || !data[name].length)) throw new Error('Every mapped DLT variable must exist as a non-empty string in Template Variables Data JSON.');
  const push = channel === 'push' ? buildPushPayload({
    title: $('cmp-push-title').value,
    body: $('cmp-push-body').value,
    deepLink: $('cmp-push-deeplink').value,
    data: parseObjectJson($('cmp-push-data').value, 'Push custom data'),
  }) : undefined;
  return buildCampaignPayload({
    template: $('cmp-template').value,
    channel,
    recipients: $('cmp-recipients').value,
    data,
    push,
    dltVariableMapping,
  });
}

function showCampaignSummary() {
  try {
    const body = campaignFormPayload();
    $('cmp-summary-content').innerHTML = `<strong>Ready to launch</strong><br>${body.recipients.length.toLocaleString()} unique ${escHtml(body.channel)} recipients will receive <span class="text-mono">${escHtml(body.template)}</span>.`;
    $('cmp-summary').classList.remove('hidden');
    $('cmp-error').textContent = '';
    return body;
  } catch (err) {
    $('cmp-summary').classList.add('hidden');
    $('cmp-error').textContent = err.message;
    return null;
  }
}

async function submitCampaign() {
  if (!campaignSummaryReady) {
    if (showCampaignSummary()) {
      campaignSummaryReady = true;
      $('cmp-modal-submit').textContent = 'Confirm & Launch';
    }
    return;
  }
  const body = campaignFormPayload();
  if (!storedApiKey() && !isDemoMode) { $('cmp-error').textContent = 'No API key in session. Create one in Project & API Keys.'; return; }
  if (!isDemoMode && storedApiKeyProjectId() !== storedProjectId()) {
    $('cmp-error').textContent = 'The API key belongs to a different project. Create a new API key for the selected project.';
    return;
  }
  const button = $('cmp-modal-submit');
  button.disabled = true;
  button.textContent = 'Launching...';
  try {
    let result;
    if (isDemoMode) {
      const campaignId = `cmp_demo_${Date.now()}`;
      const now = new Date().toISOString();
      result = { campaignId, state: 'queued', total: body.recipients.length };
      campaignsData.unshift({ campaignId, projectId: 'prj_ember_studio_demo', templateSlug: body.template, templateVersion: 1, channel: body.channel, state: result.state, total: result.total, processed: 0, successful: 0, failed: 0, pending: result.total, createdAt: now, updatedAt: now });
    } else {
      result = await apiKeyRequest('/v1/campaigns', 'POST', body);
    }
    closeCampaignModal();
    toast(`Campaign ${result.campaignId} queued for ${result.total.toLocaleString()} recipients.`, 'success');
    await loadCampaigns();
  } catch (err) {
    $('cmp-error').textContent = friendlyError(err);
  } finally {
    button.disabled = false;
    button.textContent = 'Create & Launch Campaign';
  }
}

function renderDevices() {
  $('dev-count-label').textContent = `${sessionDevices.length} device${sessionDevices.length === 1 ? '' : 's'}`;
  $('dev-list').innerHTML = sessionDevices.length ? sessionDevices.map(device => `
    <div class="flex items-center" style="justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--border);">
      <div><div class="text-mono">${escHtml(device.recipient)}</div><div class="text-sm text-muted">${escHtml(device.platform)} · ${escHtml(device.maskedToken)}</div></div>
      <span class="badge badge-delivered">Registered</span>
    </div>`).join('') : '<div class="state-empty" style="padding:24px 0;"><p>No devices registered in this session.</p></div>';
}

function validateDeviceForm() {
  const recipient = validateRecipient('email', $('dev-recipient').value);
  const token = $('dev-token').value.trim();
  const platform = $('dev-platform').value;
  if (token.length < 20 || token.length > 4096) throw new Error('Device token must be between 20 and 4096 characters.');
  if (!['ios', 'android', 'web'].includes(platform)) throw new Error('Choose a valid device platform.');
  return { recipient, token, platform };
}

async function registerDevice() {
  try {
    const device = validateDeviceForm();
    if (!storedApiKey() && !isDemoMode) throw new Error('No API key in session. Create one in Project & API Keys.');
    if (!isDemoMode) await apiKeyRequest('/v1/devices', 'POST', device);
    sessionDevices = [{ recipient: device.recipient, platform: device.platform, maskedToken: maskToken(device.token) }, ...sessionDevices];
    renderDevices();
    $('dev-status').innerHTML = '<div class="alert alert-success"><span>Device registered successfully. The token is masked in this session.</span></div>';
    $('dev-token').value = '';
  } catch (err) {
    $('dev-status').innerHTML = `<div class="alert alert-error"><span>${escHtml(friendlyError(err))}</span></div>`;
  }
}

async function removeDevice() {
  try {
    const device = validateDeviceForm();
    if (!storedApiKey() && !isDemoMode) throw new Error('No API key in session. Create one in Project & API Keys.');
    if (!isDemoMode) await apiKeyRequest('/v1/devices', 'DELETE', device);
    const maskedToken = maskToken(device.token);
    sessionDevices = sessionDevices.filter(item => !(item.recipient === device.recipient && item.maskedToken === maskedToken));
    renderDevices();
    $('dev-status').innerHTML = '<div class="alert alert-success"><span>Device removed successfully.</span></div>';
    $('dev-token').value = '';
  } catch (err) {
    $('dev-status').innerHTML = `<div class="alert alert-error"><span>${escHtml(friendlyError(err))}</span></div>`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Page router
// ─────────────────────────────────────────────────────────────────────────────
function onPageLoad(pageId) {
  switch (pageId) {
    case 'overview':      loadOverview(); break;
    case 'campaigns':     loadCampaigns(); break;
    case 'notifications': loadNotifications(); break;
    case 'templates':     loadTemplates(); break;
    case 'project':       updateAuthUi(); break;
    case 'send':          variablesFromSendTemplate(); break;
    case 'devices':       renderDevices(); break;
    case 'settings':      updateAuthUi(); break;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API status ping
// ─────────────────────────────────────────────────────────────────────────────
async function pingApi() {
  const dot = $('api-status-dot');
  try {
    const r = await fetch(`${requireApiUrl()}/v1/dashboard-config`, { signal: AbortSignal.timeout(4000) });
    const ok = r.status < 500;
    dot.style.background = ok ? 'var(--success)' : 'var(--warning)';
    dot.title = ok ? 'API stage active and reachable' : 'API returned unexpected error';
    if (ok && !oauthConfig) {
      const data = await r.json().catch(() => null);
      if (data?.cognitoClientId) oauthConfig = data;
    }
  } catch {
    dot.style.background = 'var(--error)';
    dot.title = 'API gateway unreachable';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event listeners
// ─────────────────────────────────────────────────────────────────────────────
$('sidebar-auth-action').addEventListener('click', () => {
  if ($('sidebar-auth-action').dataset.auth === 'logout') {
    triggerLogout();
  } else {
    loadOAuthConfig().then(triggerLogin).catch(err => toast(friendlyError(err), 'error'));
  }
});

$('overview-refresh-btn').addEventListener('click', loadOverview);
$('project-selector')?.addEventListener('change', (event) => switchProject(event.target.value));
$('overview-login-btn').addEventListener('click', () => {
  loadOAuthConfig().then(triggerLogin).catch(err => toast(friendlyError(err), 'error'));
});

$('campaigns-refresh-btn').addEventListener('click', loadCampaigns);
$('campaign-create-btn').addEventListener('click', openCampaignModal);
$('cmp-channel').addEventListener('change', updateCampaignChannel);
$('campaign-modal').querySelectorAll('input, textarea, select').forEach(field => {
  field.addEventListener('input', () => {
    campaignSummaryReady = false;
    $('cmp-modal-submit').textContent = 'Review Campaign';
  });
});
$('cmp-modal-submit').addEventListener('click', submitCampaign);
$('cmp-modal-cancel').addEventListener('click', closeCampaignModal);
$('campaign-modal-close').addEventListener('click', closeCampaignModal);
$('campaign-modal').addEventListener('click', (e) => { if (e.target === $('campaign-modal')) closeCampaignModal(); });
$('campaigns-search').addEventListener('input', renderCampaignsTable);
$('campaigns-filter-status').addEventListener('change', renderCampaignsTable);
$('campaigns-filter-channel').addEventListener('change', renderCampaignsTable);

$('campaign-back-btn').addEventListener('click', () => navigateTo('campaigns'));

$('ntf-refresh-btn').addEventListener('click', () => loadNotifications(false));
$('ntf-load-more-btn').addEventListener('click', () => loadNotifications(true));
$('ntf-search').addEventListener('input', renderNtfTable);
$('ntf-filter-status').addEventListener('change', renderNtfTable);
$('ntf-filter-channel').addEventListener('change', renderNtfTable);

$('template-create-btn').addEventListener('click', () => openTemplateModal());
$('templates-refresh-btn').addEventListener('click', loadTemplates);
$('templates-grid').addEventListener('click', (event) => {
  const button = event.target.closest('[data-template-action]');
  if (!button) return;
  const template = templateBySlug(button.dataset.templateSlug);
  if (!template) return;
  if (button.dataset.templateAction === 'view') openTemplateView(template);
  if (button.dataset.templateAction === 'edit' && !isDemoMode) openTemplateModal(template);
  if (button.dataset.templateAction === 'delete' && !isDemoMode) deleteTemplate(template);
});
$('tpl-modal-submit').addEventListener('click', submitTemplate);
$('tpl-modal-cancel').addEventListener('click', closeTemplateModal);
$('template-modal-close').addEventListener('click', closeTemplateModal);
$('template-modal').addEventListener('click', (e) => { if (e.target === $('template-modal')) closeTemplateModal(); });
$('template-view-close').addEventListener('click', () => $('template-view-modal').classList.remove('open'));
$('template-view-modal').addEventListener('click', (e) => { if (e.target === $('template-view-modal')) $('template-view-modal').classList.remove('open'); });

$('proj-create-btn').addEventListener('click', createProject);
$('proj-save-btn').addEventListener('click', saveProjectId);
$('proj-delete-btn').addEventListener('click', deleteProject);
$('key-create-btn').addEventListener('click', createApiKey);
$('key-copy-btn').addEventListener('click', async () => {
  const val = $('key-reveal-value').textContent;
  try {
    await navigator.clipboard.writeText(val);
    toast('API key copied to clipboard.', 'success');
  } catch { toast('Please copy the key manually.', 'error'); }
});

$('send-btn').addEventListener('click', sendNotification);
$('send-channel').addEventListener('change', updateSendChannel);
$('send-template').addEventListener('change', variablesFromSendTemplate);

$('dev-register-btn').addEventListener('click', registerDevice);
$('dev-remove-btn').addEventListener('click', removeDevice);

$('settings-login-btn').addEventListener('click', () => {
  loadOAuthConfig().then(triggerLogin).catch(err => toast(friendlyError(err), 'error'));
});
$('settings-logout-btn').addEventListener('click', triggerLogout);
$('settings-save-url-btn').addEventListener('click', () => {
  const url = $('settings-api-url').value.trim();
  if ($('api-url-input')) $('api-url-input').value = url;
  toast('API URL endpoint updated.', 'success');
  pingApi();
});
$('settings-clear-btn').addEventListener('click', async () => {
  const confirmed = await confirm(
    'Clear Local Session',
    'This will remove stored tokens, project IDs, and API keys from this browser session.',
    'Clear',
  );
  if (confirmed) {
    sessionStorage.clear();
    updateAuthUi();
    toast('Session state cleared.', 'info');
  }
});

// Demo toggle button
$('demo-toggle-btn').addEventListener('click', () => {
  isDemoMode = !isDemoMode;
  $('demo-toggle-label').textContent = `Demo Data: ${isDemoMode ? 'ON' : 'OFF'}`;
  $('demo-toggle-btn').classList.toggle('btn-primary', isDemoMode);
  $('demo-toggle-btn').classList.toggle('btn-secondary', !isDemoMode);
  toast(`Demo Mode ${isDemoMode ? 'enabled' : 'disabled'}.`, 'info');
  // Refresh current view
  const activePage = document.querySelector('.page.active')?.id?.replace('page-', '') || 'overview';
  onPageLoad(activePage);
});

// Modal close & Escape key support
$('confirm-modal').addEventListener('click', (e) => {
  if (e.target === $('confirm-modal')) $('confirm-modal').classList.remove('open');
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if ($('confirm-modal').classList.contains('open')) $('confirm-modal').classList.remove('open');
  if ($('template-modal').classList.contains('open')) closeTemplateModal();
  if ($('campaign-modal').classList.contains('open')) closeCampaignModal();
});

$('api-url-input').addEventListener('change', () => {
  if ($('settings-api-url')) $('settings-api-url').value = $('api-url-input').value;
  pingApi();
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  const savedProjectId = sessionStorage.getItem(SESSION.projectId);
  if (savedProjectId && $('proj-id-input')) $('proj-id-input').value = savedProjectId;

  renderSendFormVars();
  updateSendChannel();
  updateCampaignChannel();
  renderDevices();
  updateAuthUi();

  try {
    await pingApi();
    if (!oauthConfig) await loadOAuthConfig();
    await completeLogin();
    await loadAuthorizedProjects();
  } catch (err) {
    console.warn('Boot initialization warning:', err?.message ?? err);
    toast(friendlyError(err), 'error');
  }

  updateAuthUi();
  navigateTo('overview');
})();
