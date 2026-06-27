import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_BASE_URL = 'https://otokapi.com';
const DEFAULT_OUTPUT = 'public/data/status.json';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_CHANNEL_DETAILS = 80;
const MAX_TIMELINE_POINTS = 80;

const config = {
  baseUrl: trimTrailingSlash(process.env.OTOKAPI_BASE_URL || DEFAULT_BASE_URL),
  bearerToken: cleanSecret(process.env.OTOKAPI_BEARER_TOKEN),
  refreshToken: cleanSecret(process.env.OTOKAPI_REFRESH_TOKEN),
  cookie: cleanSecret(process.env.OTOKAPI_COOKIE),
  output: process.env.OTOKAPI_STATUS_OUTPUT || DEFAULT_OUTPUT,
  timeoutMs: Number(process.env.OTOKAPI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  timezone: process.env.OTOKAPI_TIMEZONE || 'Asia/Shanghai'
};

const startedAt = new Date();
const warnings = [];

main().catch(async (error) => {
  const payload = makeBasePayload();
  payload.ok = false;
  payload.error = sanitizeError(error);
  await writeJson(config.output, payload);
  console.error(payload.error.message);
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.exitCode = 1;
  }
});

async function main() {
  let token = config.bearerToken;
  let refreshTokenRotated = false;

  if (!token && config.refreshToken) {
    const refreshed = await refreshAccessToken(config.refreshToken);
    token = refreshed.accessToken;
    refreshTokenRotated = refreshed.refreshTokenRotated;
    if (refreshTokenRotated) {
      warnings.push('OpenToken returned a rotated refresh token. The new token is not written to Pages output.');
    }
  }

  if (!token && !config.cookie) {
    const payload = makeBasePayload();
    payload.ok = false;
    payload.auth_configured = false;
    payload.error = {
      code: 'AUTH_NOT_CONFIGURED',
      message: 'Missing OTOKAPI_REFRESH_TOKEN, OTOKAPI_BEARER_TOKEN, or OTOKAPI_COOKIE.'
    };
    await writeJson(config.output, payload);
    return;
  }

  const client = createApiClient({ token, cookie: config.cookie, refreshToken: config.refreshToken });

  const [channelsResult, subscriptionsResult, usageResult, quotasResult, availableResult, subscriptionSummaryResult] =
    await Promise.all([
      safeGet(client, '/channel-monitors'),
      safeGet(client, '/subscriptions'),
      safeGet(client, '/usage/dashboard/stats'),
      safeGet(client, '/user/platform-quotas'),
      safeGet(client, '/channels/available'),
      safeGet(client, '/subscriptions/summary')
    ]);

  const channelItems = normalizeArray(channelsResult.data, 'items').slice(0, MAX_CHANNEL_DETAILS);
  const detailResults = await Promise.all(
    channelItems.map((channel) => safeGet(client, `/channel-monitors/${encodeURIComponent(channel.id)}/status`))
  );

  const payload = makeBasePayload();
  payload.ok = [
    channelsResult,
    subscriptionsResult,
    usageResult,
    quotasResult,
    availableResult,
    subscriptionSummaryResult
  ].some((result) => result.ok);
  payload.auth_configured = true;
  payload.refresh_token_rotated = refreshTokenRotated;
  payload.warnings = warnings;
  payload.errors = collectErrors({
    channels: channelsResult,
    subscriptions: subscriptionsResult,
    usage: usageResult,
    platform_quotas: quotasResult,
    available_channels: availableResult,
    subscription_summary: subscriptionSummaryResult
  });
  payload.channels = normalizeChannels(channelItems, detailResults);
  payload.channel_summary = summarizeChannels(payload.channels);
  payload.subscriptions = normalizeSubscriptions(subscriptionsResult.data);
  payload.subscription_summary = normalizeSubscriptionSummary(subscriptionSummaryResult.data, payload.subscriptions);
  payload.usage = normalizeUsage(usageResult.data);
  payload.platform_quotas = normalizePlatformQuotas(quotasResult.data);
  payload.available_channels = summarizeAvailableChannels(availableResult.data);

  await writeJson(config.output, payload);
  if (!payload.ok && process.env.GITHUB_ACTIONS === 'true') {
    console.error('All OpenToken API requests failed; refusing to deploy empty status data.');
    process.exitCode = 1;
  }
}

function createApiClient({ token, cookie, refreshToken }) {
  let activeToken = token;

  async function request(apiPath, options = {}) {
    try {
      return await requestOnce(apiPath, options, activeToken, cookie);
    } catch (error) {
      if (error.status === 401 && refreshToken) {
        const refreshed = await refreshAccessToken(refreshToken);
        activeToken = refreshed.accessToken;
        if (refreshed.refreshTokenRotated) {
          warnings.push('OpenToken rotated the refresh token during a retry.');
        }
        return requestOnce(apiPath, options, activeToken, cookie);
      }
      throw error;
    }
  }

  return { request };
}

async function requestOnce(apiPath, options = {}, token, cookie) {
  const url = new URL(`/api/v1${apiPath}`, config.baseUrl);
  if ((options.method || 'GET').toUpperCase() === 'GET') {
    url.searchParams.set('timezone', config.timezone);
    for (const [key, value] of Object.entries(options.params || {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {
    Accept: 'application/json',
    'Accept-Language': 'zh-CN',
    'Content-Type': 'application/json',
    'User-Agent': 'otokapi-status-monitor/1.0'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(config.timeoutMs)
  });

  const text = await response.text();
  const json = parseJson(text);

  if (!response.ok) {
    throw makeHttpError(response.status, json, text, apiPath);
  }

  return unwrapEnvelope(json, apiPath);
}

async function refreshAccessToken(refreshToken) {
  const raw = await requestOnce('/auth/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken }
  }, null, null);

  if (!raw || typeof raw.access_token !== 'string' || raw.access_token.trim() === '') {
    throw new Error('OpenToken refresh response did not contain access_token.');
  }

  return {
    accessToken: raw.access_token.trim(),
    refreshTokenRotated: typeof raw.refresh_token === 'string' && raw.refresh_token.trim() !== refreshToken
  };
}

async function safeGet(client, apiPath, params) {
  try {
    return { ok: true, data: await client.request(apiPath, { params }) };
  } catch (error) {
    return { ok: false, error: sanitizeError(error) };
  }
}

function normalizeChannels(items, detailResults) {
  return items.map((item, index) => {
    const detail = detailResults[index]?.ok ? detailResults[index].data : null;
    const detailModels = normalizeArray(detail, 'models').map((model) => ({
      model: stringValue(model.model),
      latest_status: stringValue(model.latest_status),
      latest_latency_ms: numberOrNull(model.latest_latency_ms),
      availability_7d: numberOrNull(model.availability_7d),
      availability_15d: numberOrNull(model.availability_15d),
      availability_30d: numberOrNull(model.availability_30d),
      avg_latency_7d_ms: numberOrNull(model.avg_latency_7d_ms)
    }));

    return {
      id: item.id,
      name: stringValue(item.name),
      provider: stringValue(item.provider),
      group_name: stringValue(item.group_name),
      primary_model: stringValue(item.primary_model),
      primary_status: stringValue(item.primary_status || item.status || 'unknown'),
      primary_latency_ms: numberOrNull(item.primary_latency_ms),
      primary_ping_latency_ms: numberOrNull(item.primary_ping_latency_ms),
      availability_7d: numberOrNull(item.availability_7d),
      latest_checked_at: stringValue(item.latest_checked_at || item.checked_at),
      extra_models: Array.isArray(item.extra_models) ? item.extra_models.map(stringValue).filter(Boolean) : [],
      timeline: normalizeArray(item.timeline).slice(-MAX_TIMELINE_POINTS).map((point) => ({
        status: stringValue(point.status || 'empty'),
        latency_ms: numberOrNull(point.latency_ms),
        checked_at: stringValue(point.checked_at)
      })),
      models: detailModels,
      detail_error: detailResults[index]?.ok ? null : detailResults[index]?.error || null
    };
  });
}

function summarizeChannels(channels) {
  const summary = {
    total: channels.length,
    operational: 0,
    degraded: 0,
    failed: 0,
    unknown: 0,
    by_provider: {}
  };

  if (channels.length === 0) {
    summary.overall_status = 'unknown';
    return summary;
  }

  for (const channel of channels) {
    const bucket = statusBucket(channel.primary_status);
    summary[bucket] += 1;
    const provider = channel.provider || 'unknown';
    summary.by_provider[provider] ||= { total: 0, operational: 0, degraded: 0, failed: 0, unknown: 0 };
    summary.by_provider[provider].total += 1;
    summary.by_provider[provider][bucket] += 1;
  }

  summary.overall_status = channels.every((channel) => channel.primary_status === 'operational') ? 'operational' : 'degraded';
  return summary;
}

function normalizeSubscriptions(data) {
  return normalizeArray(data, 'items').map((item) => {
    const group = item.group || {};
    return {
      id: item.id,
      status: stringValue(item.status),
      starts_at: stringValue(item.starts_at),
      expires_at: stringValue(item.expires_at),
      group_id: item.group_id,
      group: {
        name: stringValue(group.name || `Group #${item.group_id ?? '-'}`),
        platform: stringValue(group.platform),
        description: stringValue(group.description),
        daily_limit_usd: numberOrNull(group.daily_limit_usd),
        weekly_limit_usd: numberOrNull(group.weekly_limit_usd),
        monthly_limit_usd: numberOrNull(group.monthly_limit_usd)
      },
      usage: {
        daily_usage_usd: numberOrNull(item.daily_usage_usd),
        weekly_usage_usd: numberOrNull(item.weekly_usage_usd),
        monthly_usage_usd: numberOrNull(item.monthly_usage_usd)
      },
      windows: {
        daily_window_start: stringValue(item.daily_window_start),
        weekly_window_start: stringValue(item.weekly_window_start),
        monthly_window_start: stringValue(item.monthly_window_start)
      }
    };
  });
}

function normalizeSubscriptionSummary(data, subscriptions) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return {
      active_count: numberOrNull(data.active_count) ?? subscriptions.filter((item) => item.status === 'active').length,
      expired_count: numberOrNull(data.expired_count),
      raw_available: true
    };
  }
  return {
    active_count: subscriptions.filter((item) => item.status === 'active').length,
    expired_count: subscriptions.filter((item) => item.status === 'expired').length,
    raw_available: false
  };
}

function normalizeUsage(data) {
  const source = data && typeof data === 'object' ? data : {};
  return {
    today_requests: numberOrZero(source.today_requests),
    total_requests: numberOrZero(source.total_requests),
    today_tokens: numberOrZero(source.today_tokens),
    total_tokens: numberOrZero(source.total_tokens),
    today_input_tokens: numberOrZero(source.today_input_tokens),
    today_output_tokens: numberOrZero(source.today_output_tokens),
    total_input_tokens: numberOrZero(source.total_input_tokens),
    total_output_tokens: numberOrZero(source.total_output_tokens),
    today_cost: numberOrZero(source.today_cost),
    total_cost: numberOrZero(source.total_cost),
    today_actual_cost: numberOrZero(source.today_actual_cost),
    total_actual_cost: numberOrZero(source.total_actual_cost),
    rpm: numberOrZero(source.rpm),
    tpm: numberOrZero(source.tpm),
    average_duration_ms: numberOrZero(source.average_duration_ms),
    by_platform: normalizeArray(source.by_platform).map((item) => ({
      platform: stringValue(item.platform),
      today_actual_cost: numberOrZero(item.today_actual_cost),
      total_actual_cost: numberOrZero(item.total_actual_cost),
      total_requests: numberOrZero(item.total_requests),
      total_tokens: numberOrZero(item.total_tokens)
    }))
  };
}

function normalizePlatformQuotas(data) {
  return normalizeArray(data, 'platform_quotas').map((item) => ({
    platform: stringValue(item.platform),
    daily_usage_usd: numberOrNull(item.daily_usage_usd),
    daily_limit_usd: numberOrNull(item.daily_limit_usd),
    weekly_usage_usd: numberOrNull(item.weekly_usage_usd),
    weekly_limit_usd: numberOrNull(item.weekly_limit_usd),
    monthly_usage_usd: numberOrNull(item.monthly_usage_usd),
    monthly_limit_usd: numberOrNull(item.monthly_limit_usd),
    daily_window_resets_at: stringValue(item.daily_window_resets_at),
    weekly_window_resets_at: stringValue(item.weekly_window_resets_at),
    monthly_window_resets_at: stringValue(item.monthly_window_resets_at)
  }));
}

function summarizeAvailableChannels(data) {
  const rows = normalizeArray(data);
  return {
    total_families: rows.length,
    rows: rows.map((row) => ({
      name: stringValue(row.name),
      description: stringValue(row.description),
      platforms: normalizeArray(row.platforms).map((platform) => ({
        platform: stringValue(platform.platform),
        groups_count: normalizeArray(platform.groups).length,
        supported_models_count: normalizeArray(platform.supported_models).length,
        groups: normalizeArray(platform.groups).map((group) => ({
          id: group.id,
          name: stringValue(group.name),
          platform: stringValue(group.platform),
          subscription_type: stringValue(group.subscription_type)
        }))
      }))
    }))
  };
}

function makeBasePayload() {
  return {
    ok: false,
    generated_at: new Date().toISOString(),
    generated_at_unix_ms: Date.now(),
    duration_ms: Date.now() - startedAt.getTime(),
    source: trimTrailingSlash(config.baseUrl),
    auth_configured: Boolean(config.bearerToken || config.refreshToken || config.cookie),
    refresh_token_rotated: false,
    warnings: [],
    errors: {},
    channel_summary: summarizeChannels([]),
    channels: [],
    subscription_summary: { active_count: 0, expired_count: 0, raw_available: false },
    subscriptions: [],
    usage: normalizeUsage({}),
    platform_quotas: [],
    available_channels: { total_families: 0, rows: [] }
  };
}

function collectErrors(results) {
  const errors = {};
  for (const [key, result] of Object.entries(results)) {
    if (!result.ok) errors[key] = result.error;
  }
  return errors;
}

function statusBucket(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'operational' || value === 'success' || value === 'healthy') return 'operational';
  if (value === 'failed' || value === 'error' || value === 'down') return 'failed';
  if (value === 'unknown' || value === 'empty' || value === '') return 'unknown';
  return 'degraded';
}

function unwrapEnvelope(json, apiPath) {
  if (json && typeof json === 'object' && !Array.isArray(json) && 'code' in json) {
    if (json.code === 0) return json.data;
    const error = new Error(json.message || json.detail || `OpenToken API returned code ${json.code}`);
    error.code = json.code;
    error.apiPath = apiPath;
    throw error;
  }
  return json;
}

function makeHttpError(status, json, text, apiPath) {
  const message = json?.message || json?.detail || text || `HTTP ${status}`;
  const error = new Error(message);
  error.status = status;
  error.code = json?.code;
  error.apiPath = apiPath;
  return error;
}

function sanitizeError(error) {
  return {
    status: error?.status || null,
    code: stringValue(error?.code || error?.name || 'ERROR'),
    path: stringValue(error?.apiPath),
    message: stripSecretLikeText(error?.message || 'Unknown error')
  };
}

function stripSecretLikeText(value) {
  return String(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/sk-[A-Za-z0-9._-]+/g, 'sk-[redacted]')
    .slice(0, 500);
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeJson(output, payload) {
  payload.duration_ms = Date.now() - startedAt.getTime();
  const fullPath = path.resolve(output);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${fullPath}`);
}

function normalizeArray(value, preferredKey) {
  if (Array.isArray(value)) return value;
  if (preferredKey && Array.isArray(value?.[preferredKey])) return value[preferredKey];
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.data)) return value.data;
  if (Array.isArray(value?.platform_quotas)) return value.platform_quotas;
  return [];
}

function stringValue(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrZero(value) {
  return numberOrNull(value) ?? 0;
}

function cleanSecret(value) {
  const trimmed = String(value || '').trim();
  return trimmed.length > 0 ? trimmed : '';
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}
