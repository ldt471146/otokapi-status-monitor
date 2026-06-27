const DATA_URL = './data/status.json';
const REFRESH_MS = 30000;

const state = {
  data: null,
  provider: 'all',
  timer: null,
  lastLoadedAt: null
};

const elements = {
  statusStrip: document.getElementById('statusStrip'),
  metricGrid: document.getElementById('metricGrid'),
  providerFilters: document.getElementById('providerFilters'),
  channelGrid: document.getElementById('channelGrid'),
  channelSubtitle: document.getElementById('channelSubtitle'),
  subscriptionGrid: document.getElementById('subscriptionGrid'),
  subscriptionSubtitle: document.getElementById('subscriptionSubtitle'),
  quotaList: document.getElementById('quotaList'),
  fetchPanel: document.getElementById('fetchPanel'),
  fetchSubtitle: document.getElementById('fetchSubtitle'),
  refreshButton: document.getElementById('refreshButton')
};

elements.refreshButton.addEventListener('click', () => loadData({ manual: true }));
window.addEventListener('focus', () => loadData());

loadData();
state.timer = window.setInterval(() => loadData(), REFRESH_MS);

async function loadData({ manual = false } = {}) {
  if (manual) elements.refreshButton.disabled = true;
  try {
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.lastLoadedAt = new Date();
    render();
  } catch (error) {
    renderLoadFailure(error);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

function render() {
  const data = state.data || {};
  renderStatus(data);
  renderMetrics(data);
  renderProviderFilters(data.channels || []);
  renderChannels(data.channels || []);
  renderSubscriptions(data.subscriptions || [], data.subscription_summary || {});
  renderQuotas(data.platform_quotas || []);
  renderFetchPanel(data);
}

function renderStatus(data) {
  const summary = data.channel_summary || {};
  const overall = data.ok === false ? 'error' : summary.overall_status || 'unknown';
  const title = {
    operational: '渠道整体正常',
    degraded: '渠道存在降级',
    failed: '渠道存在失败',
    error: '状态抓取异常',
    unknown: '等待状态数据'
  }[overall] || '等待状态数据';

  elements.statusStrip.innerHTML = `
    <div class="status-main">
      <span class="status-dot ${escapeHtml(overall)}" aria-hidden="true"></span>
      <div class="truncate">
        <p class="status-title">${escapeHtml(title)}</p>
        <p class="status-meta truncate">数据时间 ${escapeHtml(formatDateTime(data.generated_at))} · 页面刷新 ${escapeHtml(formatDateTime(state.lastLoadedAt))}</p>
      </div>
    </div>
    <div class="status-counters">
      <span class="pill good">${number(summary.operational)} 正常</span>
      <span class="pill warn">${number(summary.degraded + summary.unknown)} 降级/未知</span>
      <span class="pill bad">${number(summary.failed)} 失败</span>
      <span class="pill">${number(summary.total)} 总渠道</span>
    </div>
  `;
}

function renderMetrics(data) {
  const usage = data.usage || {};
  const subs = data.subscription_summary || {};
  const summary = data.channel_summary || {};
  const metrics = [
    {
      label: '今日实际费用',
      value: money(usage.today_actual_cost),
      foot: `总实际费用 ${money(usage.total_actual_cost)}`
    },
    {
      label: '今日请求',
      value: compact(usage.today_requests),
      foot: `累计 ${compact(usage.total_requests)} 次`
    },
    {
      label: '今日 Token',
      value: compact(usage.today_tokens),
      foot: `输入 ${compact(usage.today_input_tokens)} / 输出 ${compact(usage.today_output_tokens)}`
    },
    {
      label: '活跃订阅',
      value: number(subs.active_count),
      foot: `${number(summary.total)} 个渠道监控项`
    }
  ];

  elements.metricGrid.innerHTML = metrics.map((metric) => `
    <article class="metric">
      <div class="metric-top">
        <span class="metric-label">${escapeHtml(metric.label)}</span>
      </div>
      <p class="metric-value">${escapeHtml(metric.value)}</p>
      <p class="metric-foot">${escapeHtml(metric.foot)}</p>
    </article>
  `).join('');
}

function renderProviderFilters(channels) {
  const providers = ['all', ...Array.from(new Set(channels.map((item) => item.provider || 'unknown'))).sort()];
  if (!providers.includes(state.provider)) state.provider = 'all';
  elements.providerFilters.innerHTML = providers.map((provider) => `
    <button class="segment ${provider === state.provider ? 'active' : ''}" type="button" data-provider="${escapeHtml(provider)}" role="tab" aria-selected="${provider === state.provider}">
      ${escapeHtml(provider === 'all' ? '全部' : provider)}
    </button>
  `).join('');

  elements.providerFilters.querySelectorAll('button').forEach((button) => {
    button.addEventListener('click', () => {
      state.provider = button.dataset.provider || 'all';
      renderChannels(state.data?.channels || []);
      renderProviderFilters(state.data?.channels || []);
    });
  });
}

function renderChannels(channels) {
  const filtered = channels.filter((item) => state.provider === 'all' || item.provider === state.provider);
  elements.channelSubtitle.textContent = `${filtered.length} / ${channels.length} 个监控项`;
  if (filtered.length === 0) {
    elements.channelGrid.innerHTML = '<div class="empty">暂无渠道状态。配置 token 后等待 Actions 抓取。</div>';
    return;
  }

  elements.channelGrid.innerHTML = filtered.map((channel) => {
    const status = statusBucket(channel.primary_status);
    const availability = preferredAvailability(channel);
    return `
      <article class="channel-card">
        <div class="channel-head">
          <div class="truncate">
            <h3 class="truncate" title="${escapeAttr(channel.name)}">${escapeHtml(channel.name || '-')}</h3>
            <p class="channel-model truncate" title="${escapeAttr(channel.primary_model)}">${escapeHtml(channel.primary_model || '-')}</p>
            <span class="provider">${escapeHtml(channel.provider || 'unknown')}</span>
          </div>
          <span class="pill ${statusClass(status)}">${escapeHtml(statusText(channel.primary_status))}</span>
        </div>
        <div class="latency-grid">
          <div class="latency-box"><span>模型延迟</span><strong>${escapeHtml(latency(channel.primary_latency_ms))}</strong></div>
          <div class="latency-box"><span>端点 Ping</span><strong>${escapeHtml(latency(channel.primary_ping_latency_ms))}</strong></div>
        </div>
        <div class="availability">
          <div class="row-between">
            <span class="muted">可用率</span>
            <strong>${escapeHtml(percent(availability))}</strong>
          </div>
          <div class="bar" aria-hidden="true"><div class="bar-fill" style="width:${clampPercent(availability)}%"></div></div>
        </div>
        ${renderTimeline(channel.timeline || [])}
      </article>
    `;
  }).join('');
}

function renderTimeline(points) {
  const visible = points.slice(-60);
  if (visible.length === 0) return '<div class="timeline" aria-label="暂无历史点"></div>';
  return `
    <div class="timeline" aria-label="最近状态历史">
      ${visible.map((point) => {
        const status = statusBucket(point.status);
        const height = status === 'operational' ? 100 : status === 'degraded' ? 68 : status === 'failed' ? 38 : 18;
        const title = `${formatDateTime(point.checked_at)} · ${statusText(point.status)} · ${latency(point.latency_ms)}`;
        return `<span class="${escapeHtml(status)}" style="height:${height}%" title="${escapeAttr(title)}"></span>`;
      }).join('')}
    </div>
  `;
}

function renderSubscriptions(subscriptions, summary) {
  elements.subscriptionSubtitle.textContent = `${number(summary.active_count)} 个活跃订阅`;
  if (subscriptions.length === 0) {
    elements.subscriptionGrid.innerHTML = '<div class="empty">暂无订阅数据。</div>';
    return;
  }

  elements.subscriptionGrid.innerHTML = subscriptions.map((subscription) => {
    const group = subscription.group || {};
    const usage = subscription.usage || {};
    return `
      <article class="subscription-card">
        <div class="row-between">
          <div class="truncate">
            <h3 class="truncate">${escapeHtml(group.name || '-')}</h3>
            <p class="subscription-meta">${escapeHtml(group.platform || 'unknown')} · ${escapeHtml(subscription.status || '-')}</p>
          </div>
          <span class="pill ${subscription.status === 'active' ? 'good' : 'warn'}">${escapeHtml(subscription.status || '-')}</span>
        </div>
        <p class="subscription-meta">到期 ${escapeHtml(formatDateTime(subscription.expires_at))}</p>
        ${limitRow('日额度', usage.daily_usage_usd, group.daily_limit_usd)}
        ${limitRow('周额度', usage.weekly_usage_usd, group.weekly_limit_usd)}
        ${limitRow('月额度', usage.monthly_usage_usd, group.monthly_limit_usd)}
      </article>
    `;
  }).join('');
}

function renderQuotas(quotas) {
  if (quotas.length === 0) {
    elements.quotaList.innerHTML = '<div class="empty">暂无平台额度数据。</div>';
    return;
  }

  elements.quotaList.innerHTML = quotas.map((quota) => `
    <div class="quota-item">
      <div class="row-between">
        <strong>${escapeHtml(quota.platform || 'unknown')}</strong>
      </div>
      ${limitRow('日', quota.daily_usage_usd, quota.daily_limit_usd)}
      ${limitRow('周', quota.weekly_usage_usd, quota.weekly_limit_usd)}
      ${limitRow('月', quota.monthly_usage_usd, quota.monthly_limit_usd)}
    </div>
  `).join('');
}

function renderFetchPanel(data) {
  const errors = Object.entries(data.errors || {});
  elements.fetchSubtitle.textContent = data.ok ? '最近一次抓取完成' : '需要处理抓取异常';

  const warningHtml = (data.warnings || []).map((warning) => `
    <div class="fetch-error">${escapeHtml(warning)}</div>
  `).join('');

  const errorHtml = errors.map(([key, error]) => `
    <div class="fetch-error">
      <strong>${escapeHtml(key)}</strong>
      <p>${escapeHtml(error?.message || 'Unknown error')}</p>
    </div>
  `).join('');

  const topError = data.error ? `
    <div class="fetch-error">
      <strong>${escapeHtml(data.error.code || 'ERROR')}</strong>
      <p>${escapeHtml(data.error.message || 'Unknown error')}</p>
    </div>
  ` : '';

  elements.fetchPanel.innerHTML = `
    <div class="row-between"><span>源站</span><strong class="truncate">${escapeHtml(data.source || '-')}</strong></div>
    <div class="row-between"><span>耗时</span><strong>${number(data.duration_ms)} ms</strong></div>
    <div class="row-between"><span>认证配置</span><strong>${data.auth_configured ? '已配置' : '未配置'}</strong></div>
    <div class="row-between"><span>下次页面刷新</span><strong>${Math.round(REFRESH_MS / 1000)} s</strong></div>
    ${topError}${warningHtml}${errorHtml}
  `;
}

function renderLoadFailure(error) {
  elements.statusStrip.innerHTML = `
    <div class="status-main">
      <span class="status-dot error" aria-hidden="true"></span>
      <div>
        <p class="status-title">无法读取状态文件</p>
        <p class="status-meta">${escapeHtml(error.message)}</p>
      </div>
    </div>
  `;
}

function limitRow(label, used, limit) {
  const hasLimit = Number.isFinite(Number(limit)) && Number(limit) > 0;
  const pct = hasLimit ? Math.min(100, Math.max(0, Number(used || 0) / Number(limit) * 100)) : 0;
  const fillColor = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--teal)';
  return `
    <div class="limit-row">
      <div class="row-between">
        <span class="muted">${escapeHtml(label)}</span>
        <strong>${hasLimit ? `${money(used)} / ${money(limit)}` : '无限制或未配置'}</strong>
      </div>
      <div class="bar" aria-hidden="true"><div class="bar-fill" style="width:${pct}%;background:${fillColor}"></div></div>
    </div>
  `;
}

function preferredAvailability(channel) {
  if (Number.isFinite(Number(channel.availability_7d))) return Number(channel.availability_7d);
  const model = (channel.models || []).find((item) => item.model === channel.primary_model) || channel.models?.[0];
  return Number.isFinite(Number(model?.availability_7d)) ? Number(model.availability_7d) : null;
}

function statusBucket(status) {
  const value = String(status || '').toLowerCase();
  if (['operational', 'success', 'healthy'].includes(value)) return 'operational';
  if (['failed', 'error', 'down'].includes(value)) return 'failed';
  if (['unknown', 'empty', ''].includes(value)) return 'unknown';
  return 'degraded';
}

function statusText(status) {
  const bucket = statusBucket(status);
  return {
    operational: '正常',
    degraded: '降级',
    failed: '失败',
    unknown: '未知'
  }[bucket];
}

function statusClass(status) {
  return status === 'operational' ? 'good' : status === 'failed' ? 'bad' : 'warn';
}

function money(value) {
  const numberValue = Number(value || 0);
  return `$${numberValue.toFixed(numberValue >= 10 ? 2 : 4)}`;
}

function latency(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '-';
  return `${Math.round(numberValue)}ms`;
}

function percent(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '-';
  return `${numberValue.toFixed(2)}%`;
}

function clampPercent(value) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.min(100, Math.max(0, numberValue));
}

function compact(value) {
  const numberValue = Number(value || 0);
  return new Intl.NumberFormat('en-US', { notation: numberValue >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(numberValue);
}

function number(value) {
  const numberValue = Number(value || 0);
  return new Intl.NumberFormat('en-US').format(numberValue);
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

