const DATA_URL = './data/status.json';
const REFRESH_MS = 30000;

const state = {
  data: null,
  range: 7,
  refreshTimer: null,
  countdownTimer: null,
  nextRefreshAt: 0,
  lastLoadedAt: null
};

const elements = {
  channelGrid: document.getElementById('channelGrid'),
  overallPill: document.getElementById('overallPill'),
  refreshButton: document.getElementById('refreshButton'),
  refreshPill: document.getElementById('refreshPill'),
  footnote: document.getElementById('footnote'),
  rangeTabs: Array.from(document.querySelectorAll('.range-tab'))
};

elements.refreshButton.addEventListener('click', () => loadData({ manual: true }));
elements.rangeTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    state.range = Number(tab.dataset.range || 7);
    updateRangeTabs();
    render();
  });
});

loadData();
state.refreshTimer = window.setInterval(() => loadData(), REFRESH_MS);
state.countdownTimer = window.setInterval(updateCountdown, 1000);

async function loadData({ manual = false } = {}) {
  if (manual) elements.refreshButton.disabled = true;
  try {
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
    state.lastLoadedAt = new Date();
    state.nextRefreshAt = Date.now() + REFRESH_MS;
    render();
  } catch (error) {
    renderError(error);
  } finally {
    elements.refreshButton.disabled = false;
    updateCountdown();
  }
}

function render() {
  const data = state.data || {};
  const channels = Array.isArray(data.channels) ? data.channels : [];
  renderOverall(data);
  renderChannels(channels);
  renderFootnote(data, channels);
}

function renderOverall(data) {
  const summary = data.channel_summary || {};
  const status = data.ok === false ? 'failed' : summary.overall_status || 'unknown';
  elements.overallPill.className = `overall-pill ${escapeHtml(statusBucket(status))}`;
  elements.overallPill.innerHTML = `<span></span>${escapeHtml(statusLabel(status).toUpperCase())}`;
}

function renderChannels(channels) {
  if (channels.length === 0) {
    elements.channelGrid.innerHTML = `
      <article class="empty-card">
        <strong>暂无渠道状态</strong>
        <span>等待下一次成功抓取。</span>
      </article>
    `;
    return;
  }

  elements.channelGrid.innerHTML = channels.map((channel) => {
    const status = statusBucket(channel.primary_status);
    const availability = availabilityForRange(channel, state.range);
    const timeline = Array.isArray(channel.timeline) ? channel.timeline.slice(-60) : [];
    return `
      <article class="channel-card">
        <div class="card-head">
          <div class="provider-icon" aria-hidden="true">◎</div>
          <div class="title-block">
            <h2 title="${escapeAttr(channel.name)}">${escapeHtml(channel.name || '-')}</h2>
            <p>
              <span>${escapeHtml(channel.provider || 'unknown')}</span>
              <code>${escapeHtml(channel.primary_model || '-')}</code>
            </p>
          </div>
          <strong class="status-badge ${escapeHtml(status)}">${escapeHtml(statusText(channel.primary_status))}</strong>
        </div>

        <div class="latency-grid">
          <div class="latency-box">
            <span>对话延迟</span>
            <strong>${escapeHtml(latency(channel.primary_latency_ms))}</strong>
          </div>
          <div class="latency-box">
            <span>端点 PING</span>
            <strong>${escapeHtml(latency(channel.primary_ping_latency_ms))}</strong>
          </div>
        </div>

        <div class="availability-row">
          <span>可用性 · ${number(state.range)} 天</span>
          <strong>${escapeHtml(percent(availability))}</strong>
        </div>

        <div class="history-head">
          <span>近 60 次记录</span>
          <span>${secondsUntilRefresh()}S 后刷新</span>
        </div>
        ${renderTimeline(timeline)}
        <div class="history-labels"><span>PAST</span><span>NOW</span></div>
      </article>
    `;
  }).join('');
}

function renderTimeline(points) {
  if (points.length === 0) return '<div class="timeline empty-timeline"></div>';
  return `
    <div class="timeline" aria-label="最近 60 次状态记录">
      ${points.map((point) => {
        const status = statusBucket(point.status);
        const title = `${formatDateTime(point.checked_at)} · ${statusText(point.status)} · ${latency(point.latency_ms)}`;
        return `<span class="${escapeHtml(status)}" title="${escapeAttr(title)}"></span>`;
      }).join('')}
    </div>
  `;
}

function renderFootnote(data, channels) {
  if (data.error) {
    elements.footnote.textContent = `抓取异常：${data.error.message || data.error.code || '未知错误'}`;
    return;
  }
  const loadedAt = data.generated_at ? formatDateTime(data.generated_at) : '-';
  elements.footnote.textContent = `${channels.length} 个渠道 · 数据时间 ${loadedAt}`;
}

function renderError(error) {
  elements.overallPill.className = 'overall-pill failed';
  elements.overallPill.innerHTML = '<span></span>ERROR';
  elements.channelGrid.innerHTML = `
    <article class="empty-card">
      <strong>无法读取状态</strong>
      <span>${escapeHtml(error.message)}</span>
    </article>
  `;
  elements.footnote.textContent = '请稍后刷新页面。';
}

function updateRangeTabs() {
  elements.rangeTabs.forEach((tab) => {
    const active = Number(tab.dataset.range || 7) === state.range;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
}

function updateCountdown() {
  elements.refreshPill.textContent = `自动刷新: ${secondsUntilRefresh()}s`;
}

function secondsUntilRefresh() {
  if (!state.nextRefreshAt) return '--';
  return Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
}

function availabilityForRange(channel, range) {
  const key = `availability_${range}d`;
  if (Number.isFinite(Number(channel[key]))) return Number(channel[key]);
  const model = (channel.models || []).find((item) => item.model === channel.primary_model) || channel.models?.[0];
  return Number.isFinite(Number(model?.[key])) ? Number(model[key]) : null;
}

function statusBucket(status) {
  const value = String(status || '').toLowerCase();
  if (['operational', 'success', 'healthy'].includes(value)) return 'operational';
  if (['failed', 'error', 'down'].includes(value)) return 'failed';
  if (['unknown', 'empty', ''].includes(value)) return 'unknown';
  return 'degraded';
}

function statusLabel(status) {
  const bucket = statusBucket(status);
  return {
    operational: 'operational',
    degraded: 'degraded',
    failed: 'failed',
    unknown: 'unknown'
  }[bucket];
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

function number(value) {
  const numberValue = Number(value || 0);
  return new Intl.NumberFormat('zh-CN').format(numberValue);
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
