const DEFAULT_BASE_URL = 'https://otokapi.com';
const TIMEZONE = 'Asia/Shanghai';
const MAX_CHANNEL_DETAILS = 80;
const MAX_TIMELINE_POINTS = 80;

export default {
  async fetch(request, env) {
    const corsHeaders = makeCorsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/status') {
      return jsonResponse({ error: 'NOT_FOUND' }, 404, corsHeaders);
    }

    try {
      const payload = await buildStatus(env);
      return jsonResponse(payload, 200, {
        ...corsHeaders,
        'Cache-Control': 'no-store'
      });
    } catch (error) {
      return jsonResponse({
        ok: false,
        error: sanitizeError(error)
      }, 500, corsHeaders);
    }
  }
};

async function buildStatus(env) {
  const startedAt = Date.now();
  let token = cleanSecret(env.OTOKAPI_BEARER_TOKEN);

  if (!token && cleanSecret(env.OTOKAPI_REFRESH_TOKEN)) {
    const refreshed = await refreshAccessToken(env);
    token = refreshed.accessToken;
  }

  if (!token) {
    const error = new Error('Missing OTOKAPI_BEARER_TOKEN or OTOKAPI_REFRESH_TOKEN.');
    error.code = 'AUTH_NOT_CONFIGURED';
    throw error;
  }

  const client = createApiClient(env, token);
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

  const channels = normalizeChannels(channelItems, detailResults);
  const subscriptions = normalizeSubscriptions(subscriptionsResult.data);

  return {
    ok: [channelsResult, subscriptionsResult, usageResult, quotasResult, availableResult, subscriptionSummaryResult]
      .some((result) => result.ok),
    generated_at: new Date().toISOString(),
    generated_at_unix_ms: Date.now(),
    duration_ms: Date.now() - startedAt,
    source: trimTrailingSlash(env.OTOKAPI_BASE_URL || DEFAULT_BASE_URL),
    auth_configured: true,
    errors: collectErrors({
      channels: channelsResult,
      subscriptions: subscriptionsResult,
      usage: usageResult,
      platform_quotas: quotasResult,
      available_channels: availableResult,
      subscription_summary: subscriptionSummaryResult
    }),
    channel_summary: summarizeChannels(channels),
    channels,
    subscription_summary: normalizeSubscriptionSummary(subscriptionSummaryResult.data, subscriptions),
    subscriptions,
    usage: normalizeUsage(usageResult.data),
    platform_quotas: normalizePlatformQuotas(quotasResult.data),
    available_channels: summarizeAvailableChannels(availableResult.data)
  };
}

function createApiClient(env, token) {
  return {
    request(apiPath, options = {}) {
      return requestOnce(env, apiPath, options, token);
    }
  };
}

async function requestOnce(env, apiPath, options = {}, token) {
  const baseUrl = trimTrailingSlash(env.OTOKAPI_BASE_URL || DEFAULT_BASE_URL);
  const url = new URL(`/api/v1${apiPath}`, baseUrl);
  if ((options.method || 'GET').toUpperCase() === 'GET') {
    url.searchParams.set('timezone', TIMEZONE);
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
    'User-Agent': 'otokapi-status-proxy/1.0'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const json = parseJson(text);

  if (!response.ok) {
    throw makeHttpError(response.status, json, text, apiPath);
  }

  return unwrapEnvelope(json, apiPath);
}

async function refreshAccessToken(env) {
  const refreshToken = cleanSecret(env.OTOKAPI_REFRESH_TOKEN);
  const raw = await requestOnce(env, '/auth/refresh', {
    method: 'POST',
    body: { refresh_token: refreshToken }
  }, null);

  if (!raw || typeof raw.access_token !== 'string' || raw.access_token.trim() === '') {
    throw new Error('OpenToken refresh response did not contain access_token.');
  }

  return {
    accessToken: raw.access_token.trim()
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
      availability_15d: numberOrNull(item.availability_15d),
      availability_30d: numberOrNull(item.availability_30d),
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

  summary.overall_status = summary.failed > 0 ? 'failed' : summary.degraded > 0 || summary.unknown > 0 ? 'degraded' : 'operational';
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
    today_actual_cost: numberOrZero(source.today_actual_cost),
    total_actual_cost: numberOrZero(source.total_actual_cost)
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
    monthly_limit_usd: numberOrNull(item.monthly_limit_usd)
  }));
}

function summarizeAvailableChannels(data) {
  const rows = normalizeArray(data);
  return {
    total_families: rows.length,
    rows: rows.map((row) => ({
      name: stringValue(row.name),
      description: stringValue(row.description)
    }))
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

function makeCorsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowedOrigin = env.ALLOWED_ORIGIN || '*';
  const responseOrigin = allowedOrigin === '*' || origin === allowedOrigin || origin.startsWith(`${allowedOrigin}/`)
    ? origin || allowedOrigin
    : allowedOrigin;
  return {
    'Access-Control-Allow-Origin': responseOrigin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin'
  };
}

function jsonResponse(payload, status, headers) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
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
