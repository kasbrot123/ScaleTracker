const $ = (id) => document.getElementById(id);
const JUMP_WARNING_KG = 3;
const METRIC_LABEL = { first: 'Erster Wert', mean: 'Mittelwert', min: 'Niedrigster Wert', max: 'Höchster Wert' };

function readPref(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : value === '1';
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* Einstellung gilt dann nur bis zum Neuladen */ }
}

const state = {
  view: 'overview',
  days: '30',
  metric: 'first',
  showExtra: readPref('gewicht.showExtra', true),
  showBand: readPref('gewicht.showBand', false),
  from: null,
  to: null,
  data: null,
  entries: [],
  tags: [],
  entriesMode: 'entries',
  editing: null,
  jumpConfirmed: false,
  deleteArmed: false,
};

let chart = null;

/* ---------- Helfer ---------- */

const fmtKg = (v, digits = 1) => (v === null || v === undefined ? '–' : v.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const parseIso = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };
const fmtDate = (d) => parseIso(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fmtDateLong = (d) => parseIso(d).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: 'long', year: 'numeric' });
const fmtShort = (d) => parseIso(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (dt) => `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
const addDays = (d, n) => { const dt = parseIso(d); dt.setDate(dt.getDate() + n); return isoOf(dt); };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

async function api(url, { method = 'GET', body, raw } = {}) {
  const headers = { 'X-Requested-With': 'gewicht' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (res.status === 401 && url !== '/api/login') { showLogin(); throw new Error('Bitte anmelden.'); }
  if (res.status === 204) return null;
  const data = raw ? await res.text() : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Fehler ${res.status}`);
  return data;
}

let toastTimer;
function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

const guard = (fn) => async (...args) => {
  try { await fn(...args); } catch (e) { toast(e.message); }
};

function setMessage(node, text) {
  node.textContent = text ?? '';
  node.hidden = !text;
}

/* ---------- Login und Navigation ---------- */

function showLogin() {
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-password').value = '';
  $('login-password').focus();
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  await refresh();
}

function setView(view) {
  state.view = view;
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  for (const name of ['overview', 'entries', 'data', 'settings']) $(`view-${name}`).hidden = name !== view;
  window.scrollTo(0, 0);
  guard(refresh)();
}

async function refresh() {
  const [data, entries, tags] = await Promise.all([
    api(state.days === 'custom' && state.from && state.to
      ? `/api/dashboard?from=${state.from}&to=${state.to}`
      : `/api/dashboard?days=${state.days === 'custom' ? 30 : state.days}`),
    api('/api/measurements'),
    api('/api/tags'),
  ]);
  state.data = data;
  state.entries = entries;
  state.tags = tags;
  renderTagOptions();
  if (state.view === 'overview') renderOverview();
  if (state.view === 'entries') renderTable();
  if (state.view === 'data') renderData();
  if (state.view === 'settings') await renderSettings();
}

/* ---------- Übersicht ---------- */

const RANGE_LABEL = { 7: '7 Tage', 30: '30 Tage', 90: '90 Tage', 365: '1 Jahr', all: 'Gesamt' };

const rangeLabel = () => (state.days === 'custom'
  ? `${fmtShort(state.data.range.from)} bis ${fmtShort(state.data.range.to)}`
  : RANGE_LABEL[state.days]);

function renderOverview() {
  const { stats, days } = state.data;
  const r = stats.range;

  $('hero-now').replaceChildren(
    el('div', { class: 'hero-label' }, 'Aktuell'),
    el('div', { class: 'hero-value' }, fmtKg(stats.latest), el('small', {}, ' kg')),
    el('div', { class: 'hero-sub' }, stats.latestDate ? fmtDateLong(stats.latestDate) : 'Noch keine Messung'),
  );

  renderSpan(stats, r);

  $('hero-deltas').replaceChildren(
    deltaTile('7 Tage', stats.changes.week),
    deltaTile('30 Tage', stats.changes.month),
    deltaTile('Im Zeitraum', r?.change ?? null),
  );

  $('chart-title').textContent = `${METRIC_LABEL[state.metric]} pro Tag`;
  renderChart(days);
}

function renderSpan(stats, r) {
  const box = $('hero-span');
  const title = el('div', { class: 'hero-label' }, `Min und Max, ${rangeLabel()}`);
  if (!r) {
    box.replaceChildren(title, el('div', { class: 'hero-sub' }, 'Keine Messung im Zeitraum'));
    return;
  }
  const width = r.max - r.min;
  const last = state.data.days.at(-1).last;
  const pos = width ? Math.max(0, Math.min(100, ((last - r.min) / width) * 100)) : 50;
  const end = (label, value, date, cls) => el('div', { class: `span-end ${cls}` },
    el('span', { class: 'span-tag' }, label),
    el('b', {}, `${fmtKg(value)} kg`),
    el('span', { class: 'span-date' }, fmtShort(date)));

  box.replaceChildren(title,
    el('div', { class: 'span-ends' }, end('Min', r.min, r.minDate, ''), end('Max', r.max, r.maxDate, 'right')),
    el('div', { class: 'span-track', role: 'img', 'aria-label': `Letzter Wert ${fmtKg(last)} kg zwischen ${fmtKg(r.min)} und ${fmtKg(r.max)} kg` },
      el('i', { style: `left:${pos}%` })));
}

function deltaTile(label, value) {
  const dir = value === null || value === undefined ? 'none' : value < 0 ? 'down' : value > 0 ? 'up' : 'flat';
  const arrow = { down: '▼', up: '▲', flat: '=', none: '' }[dir];
  const word = { down: 'Abnahme', up: 'Zunahme', flat: 'Unverändert', none: 'Noch keine Daten' }[dir];
  return el('div', { class: `delta ${dir}` },
    el('div', { class: 'delta-label' }, label),
    el('div', { class: 'delta-value' },
      arrow ? el('span', { class: 'delta-arrow', 'aria-hidden': 'true' }, arrow) : null,
      dir === 'none' ? '–' : fmtKg(Math.abs(value)),
      dir === 'none' ? null : el('small', {}, ' kg')),
    el('div', { class: 'delta-word' }, word));
}

function interpolate(values) {
  const out = [...values];
  let prev = -1;
  for (let i = 0; i < out.length; i++) {
    if (out[i] === null) continue;
    if (prev >= 0 && i - prev > 1) {
      for (let j = prev + 1; j < i; j++) out[j] = out[prev] + ((out[i] - out[prev]) * (j - prev)) / (i - prev);
    }
    prev = i;
  }
  return out;
}

function tooltipHtml(date, dayMap) {
  const day = dayMap.get(date);
  let html = `<div class="tt"><div class="tt-date">${esc(fmtDateLong(date))}</div>`;
  const row = (label, value) => `<div class="tt-row"><span>${esc(label)}</span><b>${esc(fmtKg(value, 2))} kg</b></div>`;
  if (day) {
    html += day.count > 1
      ? row('Erster', day.first) + row('Mittel', day.mean) + row('Min', day.min) + row('Max', day.max)
      : row('Gewicht', day.first);
  } else {
    html += '<div class="tt-note">Keine Messung</div>';
  }
  const periods = state.data.periods.filter((p) => p.startDate <= date && p.endDate >= date);
  if (periods.length) html += `<div class="tt-note">${periods.map((p) => esc(p.tag)).join(', ')}</div>`;
  const details = day?.entries.filter((e) => e.note || e.starred || e.tags.length || day.count > 1) ?? [];
  if (details.length) {
    html += '<div class="tt-sep"></div>';
    for (const e of details) {
      html += `<div class="tt-entry">${e.starred ? '<span class="tt-star">★</span> ' : ''}<b>${esc(e.time)}</b> ${esc(fmtKg(e.weight))} kg`;
      if (e.note) html += `<div class="tt-note">${esc(e.note)}</div>`;
      if (e.tags.length) html += `<div class="tt-note">${e.tags.map(esc).join(', ')}</div>`;
      html += '</div>';
    }
  }
  return `${html}</div>`;
}

function renderChart(days) {
  if (!window.echarts) return;
  if (!chart) chart = echarts.init($('chart'));
  const { range, goal, periods } = state.data;
  const chartStyle = getComputedStyle($('chart'));
  const token = (name) => chartStyle.getPropertyValue(name).trim();
  const c = {
    ink: token('--ink'), ink2: token('--ink-2'), axis: token('--axis'), grid: token('--grid'), baseline: token('--baseline'),
    surface: token('--surface'), s1: token('--series-1'), s4: token('--series-4'), band: token('--band'), period: token('--period'),
  };
  const { showExtra, showBand } = state;
  const narrow = $('chart').clientWidth < 560;

  const dates = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) dates.push(d);

  const dayMap = new Map(days.map((d) => [d.date, d]));
  const lows = interpolate(dates.map((d) => dayMap.get(d)?.min ?? null));
  const highs = interpolate(dates.map((d) => dayMap.get(d)?.max ?? null));
  const spread = highs.map((h, i) => (h === null || lows[i] === null ? null : +(h - lows[i]).toFixed(3)));

  // Weitere Messungen: alles außer dem Wert, der als Punkt schon auf der Linie liegt.
  const extraPoints = days.flatMap((d) => {
    const onLine = d.entries.findIndex((e) => Math.abs(e.weight - d[state.metric]) < 0.006);
    return d.entries.filter((_, i) => i !== onLine).map((e) => [d.date, e.weight]);
  });
  const starPoints = days.flatMap((d) => d.entries.filter((e) => e.starred).map((e) => [d.date, e.weight]));

  const visible = days.flatMap((d) => [d.min, d.max]);
  if (goal !== null) visible.push(goal);
  const yMin = visible.length ? Math.floor((Math.min(...visible) - 0.5) / 2) * 2 : 60;
  const yMax = visible.length ? Math.ceil((Math.max(...visible) + 0.5) / 2) * 2 : 100;

  const markLines = [];
  if (goal !== null) {
    markLines.push({
      yAxis: goal,
      lineStyle: { color: c.ink2, width: 1, type: 'solid', opacity: 0.7 },
      label: { show: true, position: 'insideEndTop', formatter: `Ziel ${fmtKg(goal)} kg`, color: c.ink2, fontSize: 12 },
    });
  }

  // Überlappende Zeiträume bekommen eigene Beschriftungszeilen.
  const laneEnds = [];
  const pixelsPerDay = Math.max(1, ($('chart').clientWidth - 52) / dates.length);
  const periodBars = periods.map((p) => {
    const start = p.startDate < range.from ? range.from : p.startDate;
    const end = p.endDate > range.to ? range.to : p.endDate;
    const startIndex = dates.indexOf(start);
    const endIndex = dates.indexOf(end);
    // Bereiche nahe am rechten Rand werden rechtsbündig beschriftet, sonst wird der Text abgeschnitten.
    const nearEnd = startIndex > dates.length * 0.85;
    // Die Zeile richtet sich nach der Textbreite, damit sich Beschriftungen nicht überlappen.
    const labelDays = Math.ceil((p.tag.length * 6.4 + 12) / pixelsPerDay);
    const labelStart = nearEnd ? endIndex - labelDays + 1 : startIndex;
    const labelEnd = nearEnd ? endIndex : startIndex + labelDays - 1;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd < labelStart);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = labelEnd;
    return { tag: p.tag, lane, startIndex, endIndex, nearEnd };
  });

  // Zeichnet jeden Bereich über ganze Tagesspalten, damit auch ein einzelner Tag sichtbar ist.
  const renderPeriod = (params, api) => {
    const bar = periodBars[params.dataIndex];
    const grid = params.coordSys;
    const bandWidth = api.size([1, 0])[0];
    const from = api.coord([bar.startIndex, yMax]);
    const to = api.coord([bar.endIndex, yMin]);
    const left = Math.max(from[0] - bandWidth / 2, grid.x);
    const right = Math.min(to[0] + bandWidth / 2, grid.x + grid.width);
    if (right <= left) return null;
    return {
      type: 'group',
      children: [
        { type: 'rect', shape: { x: left, y: from[1], width: right - left, height: to[1] - from[1] }, style: { fill: c.period } },
        {
          type: 'text',
          style: {
            text: bar.tag,
            x: bar.nearEnd ? right - 5 : left + 5,
            y: from[1] + 5 + bar.lane * 15,
            align: bar.nearEnd ? 'right' : 'left',
            fill: c.ink2,
            fontSize: 11,
            fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          },
        },
      ],
    };
  };

  const dotSize = dates.length > 200 ? 3 : dates.length > 90 ? 4 : dates.length > 45 ? 5 : 7;

  chart.setOption({
    backgroundColor: 'transparent',
    animationDuration: 350,
    textStyle: { fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif' },
    grid: narrow ? { left: 28, right: 4, top: 28, bottom: 42 } : { left: 40, right: 12, top: 38, bottom: 54 },
    legend: {
      top: 4, left: 2, right: 2, itemWidth: 18, itemHeight: 9, itemGap: 12, textStyle: { color: c.ink2, fontSize: 12 },
      data: [
        { name: METRIC_LABEL[state.metric], itemStyle: { opacity: 0 } },
        ...(showExtra && extraPoints.length ? [{ name: 'Weitere Messungen', icon: 'circle', itemStyle: { color: 'transparent', borderColor: '#ffffff', borderWidth: 1.5 } }] : []),
        ...(showBand ? [{ name: 'Min–Max', icon: 'roundRect', itemStyle: { color: c.band } }] : []),
        ...(starPoints.length ? [{ name: 'Stern' }] : []),
      ],
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      triggerOn: 'mousemove|click',
      backgroundColor: c.surface,
      borderColor: c.baseline,
      textStyle: { color: c.ink },
      extraCssText: 'box-shadow:0 8px 24px rgba(0,0,0,.45);border-radius:10px;',
      axisPointer: { type: 'line', lineStyle: { color: c.axis, width: 1, type: 'solid' } },
      formatter: (params) => tooltipHtml(params[0].axisValue, dayMap),
    },
    xAxis: {
      // Jeder Tag bekommt eine eigene Spalte, damit auch Ein-Tages-Bereiche sichtbar sind.
      type: 'category', data: dates, boundaryGap: true,
      axisLine: { lineStyle: { color: c.baseline } }, axisTick: { show: false },
      axisLabel: { color: c.axis, fontSize: 11, hideOverlap: true, formatter: (v) => fmtShort(v) },
    },
    yAxis: {
      type: 'value', min: yMin, max: yMax,
      axisLabel: { color: c.axis, fontSize: 11 },
      splitLine: { lineStyle: { color: c.grid, width: 1 } },
    },
    dataZoom: [
      // Am Handy bleibt das Wischen über den Graphen zum Scrollen frei, gezoomt wird mit dem Regler.
      { type: 'inside', disabled: narrow, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseMove: true, preventDefaultMouseMove: false },
      { type: 'slider', filterMode: 'none', height: narrow ? 14 : 18, bottom: narrow ? 2 : 6, borderColor: 'transparent', backgroundColor: c.period, fillerColor: c.band, showDetail: false, showDataShadow: false,
        handleStyle: { color: c.s1, borderColor: c.surface }, moveHandleStyle: { color: c.baseline } },
    ],
    series: [
      ...(showBand ? [
        { name: 'MinBase', type: 'line', stack: 'band', data: lows, symbol: 'none', lineStyle: { opacity: 0 }, silent: true, tooltip: { show: false } },
        { name: 'Min–Max', type: 'line', stack: 'band', data: spread, symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: c.band }, itemStyle: { color: c.band }, silent: true },
      ] : []),
      {
        name: METRIC_LABEL[state.metric], type: 'line', data: dates.map((d) => dayMap.get(d)?.[state.metric] ?? null),
        connectNulls: true, symbol: 'circle', symbolSize: dotSize, showSymbol: true, showAllSymbol: true, smooth: 0.25, z: 6,
        lineStyle: { color: c.s1, width: 2.5, shadowColor: c.s1, shadowBlur: 10 },
        itemStyle: { color: '#ffffff', borderColor: c.s1, borderWidth: 1 },
        markLine: { silent: true, symbol: 'none', animation: false, data: markLines },
      },
      ...(showExtra ? [{
        name: 'Weitere Messungen', type: 'scatter', data: extraPoints, symbolSize: Math.max(4, dotSize), z: 8, silent: true,
        itemStyle: { color: 'transparent', borderColor: '#ffffff', borderWidth: 1.5 },
      }] : []),
      {
        name: 'Stern', type: 'scatter', data: starPoints, symbol: 'path://M12 2l3 6.6 7 .8-5.2 4.8 1.4 7L12 17.6 5.8 21.2l1.4-7L2 9.4l7-.8z',
        symbolSize: 18, z: 10, silent: true, itemStyle: { color: c.s4, borderColor: c.surface, borderWidth: 1.5 },
      },
      {
        name: 'Bereiche', type: 'custom', z: 1, silent: true, animation: false, tooltip: { show: false },
        data: periodBars.map((b) => [b.startIndex, b.endIndex]), encode: { x: [0, 1] }, renderItem: renderPeriod,
      },
    ],
  }, true);
}

/* ---------- Tabelle ---------- */

function currentFilter(list) {
  const star = $('filter-star').checked;
  const tag = $('filter-tag').value;
  return list.filter((m) => (!star || m.starred) && (!tag || m.tags.includes(tag)));
}

function renderTable() {
  const wrap = $('table');
  if (state.entriesMode === 'days') { renderDaysTable(wrap); return; }
  const rows = currentFilter(state.entries).slice().reverse();
  if (!rows.length) { wrap.replaceChildren(el('div', { class: 'empty' }, 'Keine Messungen gefunden.')); return; }
  const tbody = el('tbody');
  for (const m of rows) {
    const starBtn = el('button', {
      class: `star-btn${m.starred ? ' on' : ''}`, 'aria-label': m.starred ? 'Stern entfernen' : 'Stern setzen', 'aria-pressed': String(m.starred),
      onclick: guard(async (e) => { e.stopPropagation(); await api(`/api/measurements/${m.id}`, { method: 'PATCH', body: { starred: !m.starred } }); await refresh(); }),
    }, m.starred ? '★' : '☆');
    const noteCell = el('td', { class: 'note' }, m.note);
    if (m.tags.length) noteCell.append(' ', ...m.tags.map((t) => el('span', { class: 'chip' }, t)));
    tbody.append(el('tr', { class: 'clickable', tabIndex: 0, onclick: () => openEntry(m), onkeydown: (e) => { if (e.key === 'Enter') openEntry(m); } },
      el('td', {}, starBtn),
      el('td', { class: 'nowrap' }, fmtDate(m.date)),
      el('td', { class: 'nowrap' }, m.time),
      el('td', { class: 'num' }, `${fmtKg(m.weight, m.grams % 100 ? 2 : 1)} kg`),
      noteCell));
  }
  const head = el('tr', {}, el('th', {}, ''), el('th', {}, 'Datum'), el('th', {}, 'Uhrzeit'), el('th', { class: 'num' }, 'Gewicht'), el('th', {}, 'Notiz'));
  wrap.replaceChildren(el('table', {}, el('thead', {}, head), tbody));
}

function renderDaysTable(wrap) {
  const byDate = new Map();
  for (const m of currentFilter(state.entries)) {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  }
  if (!byDate.size) { wrap.replaceChildren(el('div', { class: 'empty' }, 'Keine Messungen gefunden.')); return; }
  const tbody = el('tbody');
  for (const [date, list] of [...byDate.entries()].reverse()) {
    const w = list.map((m) => m.weight);
    tbody.append(el('tr', {},
      el('td', { class: 'nowrap' }, `${list.some((m) => m.starred) ? '★ ' : ''}${fmtDate(date)}`),
      el('td', { class: 'num' }, fmtKg(w[0], 2)),
      el('td', { class: 'num' }, fmtKg(w.reduce((a, b) => a + b, 0) / w.length, 2)),
      el('td', { class: 'num' }, fmtKg(Math.min(...w), 2)),
      el('td', { class: 'num' }, fmtKg(Math.max(...w), 2)),
      el('td', { class: 'num' }, String(w.length))));
  }
  const head = el('tr', {}, el('th', {}, 'Datum'), ...['Erster', 'Mittel', 'Min', 'Max', 'Anzahl'].map((h) => el('th', { class: 'num' }, h)));
  wrap.replaceChildren(el('table', {}, el('thead', {}, head), tbody));
}

function renderTagOptions() {
  $('tag-list').replaceChildren(...state.tags.map((t) => el('option', { value: t.name })));
  const select = $('filter-tag');
  const value = select.value;
  select.replaceChildren(el('option', { value: '' }, 'Alle Tags'), ...state.tags.map((t) => el('option', { value: t.name }, t.name)));
  select.value = state.tags.some((t) => t.name === value) ? value : '';
}

/* ---------- Messung erfassen ---------- */

function openEntry(m = null) {
  state.editing = m;
  state.jumpConfirmed = false;
  state.deleteArmed = false;
  const now = new Date();
  const last = state.entries.at(-1);
  $('entry-title').textContent = m ? 'Messung bearbeiten' : 'Neue Messung';
  $('entry-weight').value = m ? String(m.weight).replace('.', ',') : last ? String(last.weight).replace('.', ',') : '';
  $('entry-date').value = m?.date ?? isoOf(now);
  $('entry-time').value = m?.time ?? `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  $('entry-note').value = m?.note ?? '';
  $('entry-tags').value = m?.tags.join(', ') ?? '';
  $('entry-star').checked = m?.starred ?? false;
  $('entry-delete').hidden = !m;
  $('entry-delete').textContent = 'Löschen';
  setMessage($('entry-warn'), '');
  setMessage($('entry-error'), '');
  $('entry-dialog').showModal();
  $('entry-weight').focus();
  $('entry-weight').select();
}

async function saveEntry(e) {
  e.preventDefault();
  setMessage($('entry-error'), '');
  const weight = Number($('entry-weight').value.trim().replace(',', '.'));
  if (!Number.isFinite(weight) || weight < 20 || weight > 400) {
    setMessage($('entry-error'), 'Bitte ein Gewicht zwischen 20 und 400 kg eingeben.');
    return;
  }
  const date = $('entry-date').value;
  if (!date) { setMessage($('entry-error'), 'Bitte ein Datum wählen.'); return; }

  const reference = state.entries.filter((m) => m.id !== state.editing?.id && m.date <= date).at(-1);
  if (reference && Math.abs(reference.weight - weight) > JUMP_WARNING_KG && !state.jumpConfirmed) {
    state.jumpConfirmed = true;
    setMessage($('entry-warn'), `Das sind ${fmtKg(Math.abs(reference.weight - weight))} kg Unterschied zur Messung vom ${fmtDate(reference.date)}. Zum Bestätigen nochmal auf Speichern tippen.`);
    return;
  }

  const body = {
    weight,
    date,
    time: $('entry-time').value || null,
    note: $('entry-note').value,
    tags: $('entry-tags').value,
    starred: $('entry-star').checked,
  };
  try {
    let result;
    if (state.editing) result = await api(`/api/measurements/${state.editing.id}`, { method: 'PATCH', body });
    else result = await api('/api/measurements', { method: 'POST', body });
    $('entry-dialog').close();
    toast(result.duplicate ? 'Diese Messung gibt es schon.' : 'Gespeichert.');
    await refresh();
  } catch (err) {
    setMessage($('entry-error'), err.message);
  }
}

async function deleteEntry() {
  if (!state.deleteArmed) {
    state.deleteArmed = true;
    $('entry-delete').textContent = 'Wirklich löschen?';
    return;
  }
  await api(`/api/measurements/${state.editing.id}`, { method: 'DELETE' });
  $('entry-dialog').close();
  toast('Gelöscht.');
  await refresh();
}

/* ---------- Daten ---------- */

function renderData() {
  const count = state.data.demoCount;
  $('demo-card').hidden = !count;
  $('demo-text').textContent = `${count} erfundene Messungen sind gespeichert. Das Löschen entfernt nur diese, plus Demo-Zeiträume und Demo-Ziel.`;
}

async function runImport(e) {
  e.preventDefault();
  const file = $('import-file').files[0];
  const csv = file ? await file.text() : $('import-text').value;
  if (!csv.trim()) { toast('Bitte eine Datei wählen oder Daten einfügen.'); return; }
  const r = await api('/api/import', { method: 'POST', body: { csv } });
  const box = $('import-result');
  const p = r.periods;
  const parts = [`${r.imported} Messungen importiert`, `${r.duplicates} doppelt`];
  if (p.created) parts.push(`${p.created} ${p.created === 1 ? 'Bereich' : 'Bereiche'} neu`);
  if (p.extended) parts.push(`${p.extended} ${p.extended === 1 ? 'Bereich' : 'Bereiche'} erweitert`);
  if (p.duplicates) parts.push(`${p.duplicates} ${p.duplicates === 1 ? 'Bereich' : 'Bereiche'} schon vorhanden`);
  parts.push(`${r.errors.length} mit Fehler`);
  box.replaceChildren(el('p', {}, `${parts.join(', ')}.`));
  if (r.errors.length) {
    const ul = el('ul', { class: 'list' });
    r.errors.slice(0, 20).forEach((x) => ul.append(el('li', {}, `Zeile ${x.line}: ${x.message}`)));
    box.append(ul);
  }
  $('import-file').value = '';
  $('import-text').value = '';
  await refresh();
}

/* ---------- Einstellungen ---------- */

function listItem(label, buttonText, onClick) {
  return el('li', {}, el('span', {}, label), el('button', { type: 'button', class: 'danger', onclick: guard(onClick) }, buttonText));
}

function armed(fn) {
  let primed = false;
  return async function handler(e) {
    if (!primed) { primed = true; e.currentTarget.textContent = 'Sicher?'; return; }
    await fn();
  };
}

async function renderSettings() {
  const goal = state.data.goal;
  if (document.activeElement !== $('goal-input')) $('goal-input').value = goal === null ? '' : String(goal).replace('.', ',');

  const [periods, tokens] = await Promise.all([api('/api/periods'), api('/api/tokens')]);
  $('period-list').replaceChildren(...periods.map((p) => listItem(`${p.tag}: ${fmtDate(p.startDate)} bis ${fmtDate(p.endDate)}`, 'Entfernen',
    armed(async () => { await api(`/api/periods/${p.id}`, { method: 'DELETE' }); await refresh(); }))));
  $('tag-manage').replaceChildren(...(state.tags.length
    ? state.tags.map((t) => listItem(`${t.name} (${t.measurements})`, 'Löschen',
      armed(async () => { await api(`/api/tags/${t.id}`, { method: 'DELETE' }); await refresh(); })))
    : [el('li', { class: 'muted' }, 'Noch keine Tags.')]));
  $('token-list').replaceChildren(...tokens.map((t) => listItem(`${t.name}${t.lastUsedAt ? `, zuletzt ${t.lastUsedAt.slice(0, 10)}` : ', unbenutzt'}`, 'Widerrufen',
    armed(async () => { await api(`/api/tokens/${t.id}`, { method: 'DELETE' }); $('token-new').hidden = true; await refresh(); }))));
}

/* ---------- Ereignisse ---------- */

function segmented(id, attr, onChange) {
  $(id).addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
    onChange(btn.dataset[attr]);
  });
}

segmented('range', 'days', (v) => {
  if (v === 'custom') {
    state.from = state.from ?? state.data?.range.from ?? null;
    state.to = state.to ?? state.data?.range.to ?? null;
    $('range-from').value = state.from ?? '';
    $('range-to').value = state.to ?? '';
  }
  state.days = v;
  $('custom-range').hidden = v !== 'custom';
  guard(refresh)();
});

function applyCustomRange() {
  let from = $('range-from').value;
  let to = $('range-to').value;
  if (!from || !to) return;
  if (from > to) [from, to] = [to, from];
  $('range-from').value = from;
  $('range-to').value = to;
  state.from = from;
  state.to = to;
  guard(refresh)();
}
$('range-from').addEventListener('change', applyCustomRange);
$('range-to').addEventListener('change', applyCustomRange);
$('range-first').addEventListener('click', () => {
  const first = state.entries[0]?.date;
  if (!first) return;
  $('range-from').value = first;
  applyCustomRange();
});

function bindToggle(id, key, prefKey) {
  const button = $(id);
  button.setAttribute('aria-pressed', String(state[key]));
  button.addEventListener('click', () => {
    state[key] = !state[key];
    writePref(prefKey, state[key]);
    button.setAttribute('aria-pressed', String(state[key]));
    if (state.data) renderChart(state.data.days);
  });
}
bindToggle('toggle-extra', 'showExtra', 'gewicht.showExtra');
bindToggle('toggle-band', 'showBand', 'gewicht.showBand');
segmented('metric', 'metric', (v) => { state.metric = v; renderOverview(); });
segmented('entries-mode', 'mode', (v) => { state.entriesMode = v; renderTable(); });
$('filter-star').addEventListener('change', renderTable);
$('filter-tag').addEventListener('change', renderTable);

document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('add-top').addEventListener('click', () => openEntry());
$('add-bottom').addEventListener('click', () => openEntry());
$('entry-form').addEventListener('submit', saveEntry);
$('entry-cancel').addEventListener('click', () => $('entry-dialog').close());
$('entry-delete').addEventListener('click', guard(deleteEntry));
$('entry-weight').addEventListener('input', () => { state.jumpConfirmed = false; setMessage($('entry-warn'), ''); });

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMessage($('login-error'), '');
  try {
    await api('/api/login', { method: 'POST', body: { password: $('login-password').value } });
    await showApp();
  } catch (err) {
    setMessage($('login-error'), err.message);
  }
});

$('logout').addEventListener('click', guard(async () => { await api('/api/logout', { method: 'POST' }); showLogin(); }));
$('import-form').addEventListener('submit', guard(runImport));

$('goal-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const raw = $('goal-input').value.trim();
  if (!raw) { $('goal-msg').textContent = 'Bitte einen Wert eingeben.'; return; }
  const r = await api('/api/goal', { method: 'PUT', body: { goal: raw } });
  $('goal-msg').textContent = `Ziel: ${fmtKg(r.goal)} kg`;
  $('goal-input').blur();
  await refresh();
}));
$('goal-clear').addEventListener('click', guard(async () => {
  await api('/api/goal', { method: 'PUT', body: { goal: null } });
  $('goal-input').value = '';
  $('goal-msg').textContent = 'Ziel entfernt.';
  await refresh();
}));

$('period-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  setMessage($('period-msg'), '');
  try {
    await api('/api/periods', { method: 'POST', body: { tag: $('period-tag').value, startDate: $('period-start').value, endDate: $('period-end').value } });
    e.target.reset();
    await refresh();
  } catch (err) {
    setMessage($('period-msg'), err.message);
  }
});

$('token-form').addEventListener('submit', guard(async (e) => {
  e.preventDefault();
  const t = await api('/api/tokens', { method: 'POST', body: { name: $('token-name').value } });
  $('token-value').textContent = t.token;
  $('token-new').hidden = false;
  $('token-name').value = '';
  await refresh();
}));

$('demo-delete').addEventListener('click', guard(armedDemo()));
function armedDemo() {
  let primed = false;
  return async (e) => {
    if (!primed) { primed = true; e.currentTarget.textContent = 'Wirklich alle Demo-Daten löschen?'; return; }
    primed = false;
    e.currentTarget.textContent = 'Demo-Daten löschen';
    const r = await api('/api/demo', { method: 'DELETE' });
    toast(`${r.removed} Demo-Messungen gelöscht.`);
    await refresh();
  };
}

window.addEventListener('resize', () => chart?.resize());
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('app').hidden && !$('entry-dialog').open) guard(refresh)(); });

(async () => {
  try {
    const s = await api('/api/session');
    if (s.authenticated) await showApp();
    else showLogin();
  } catch (e) {
    showLogin();
    setMessage($('login-error'), e.message);
  }
})();
