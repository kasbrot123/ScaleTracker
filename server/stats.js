import { addDays, dayNumber } from './parse.js';

const TREND_WINDOW = 7;
const FORECAST_WINDOW = 28;
const FORECAST_MIN_DAYS = 7;
const FORECAST_MIN_SPAN = 10;
const FORECAST_MAX_DAYS = 730;
const FORECAST_CHART_DAYS = 90;

const kg = (grams) => Math.round(grams / 10) / 100;
const round2 = (v) => Math.round(v * 100) / 100;
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;

/** Fasst sortierte Messungen je Kalendertag zusammen. */
export function aggregateDays(measurements) {
  const byDate = new Map();
  for (const m of measurements) {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  }
  return [...byDate.entries()].map(([date, entries]) => {
    const grams = entries.map((e) => e.grams);
    return {
      date,
      first: kg(grams[0]),
      last: kg(grams[grams.length - 1]),
      mean: kg(mean(grams)),
      min: kg(Math.min(...grams)),
      max: kg(Math.max(...grams)),
      count: entries.length,
      starred: entries.some((e) => e.starred),
      entries: entries.map(({ grams: _g, ...rest }) => rest),
    };
  });
}

/** Gleitender 7-Tage-Schnitt auf dem ersten Wert des Tages. */
export function computeTrend(days) {
  if (!days.length) return [];
  const byDay = new Map(days.map((d) => [d.date, d.first]));
  const out = [];
  const last = days[days.length - 1].date;
  for (let date = days[0].date; date <= last; date = addDays(date, 1)) {
    const windowValues = [];
    for (let i = 0; i < TREND_WINDOW; i++) {
      const v = byDay.get(addDays(date, -i));
      if (v !== undefined) windowValues.push(v);
    }
    if (windowValues.length) out.push({ date, value: round2(mean(windowValues)) });
  }
  return out;
}

function regression(points) {
  const mx = mean(points.map((p) => p.x));
  const my = mean(points.map((p) => p.y));
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) ** 2;
  }
  const slope = den ? num / den : 0;
  return { slope, at: (x) => my + slope * (x - mx) };
}

export function computeForecast(days, goal) {
  if (!days.length) return { status: 'no-data' };
  const lastDate = days[days.length - 1].date;
  const lastX = dayNumber(lastDate);
  const recent = days
    .filter((d) => dayNumber(d.date) > lastX - FORECAST_WINDOW)
    .map((d) => ({ x: dayNumber(d.date), y: d.first }));

  if (recent.length < FORECAST_MIN_DAYS || lastX - recent[0].x < FORECAST_MIN_SPAN) {
    return { status: 'not-enough-data' };
  }

  const { slope, at } = regression(recent);
  const current = at(lastX);
  const base = { slopePerWeek: round2(slope * 7), current: round2(current) };
  if (goal === null) return { status: 'no-goal', ...base };

  const remaining = goal - current;
  const losing = days[0].first >= goal;
  const reached = losing ? current <= goal : current >= goal;
  if (reached) return { status: 'reached', ...base, remainingKg: round2(remaining) };
  if (slope === 0 || slope * remaining < 0) return { status: 'wrong-direction', ...base, remainingKg: round2(remaining) };

  const daysLeft = Math.ceil(remaining / slope);
  if (daysLeft > FORECAST_MAX_DAYS) return { status: 'too-far', ...base, remainingKg: round2(remaining) };

  const points = [];
  for (let i = 0; i <= Math.min(daysLeft, FORECAST_CHART_DAYS); i++) {
    points.push({ date: addDays(lastDate, i), value: round2(current + slope * i) });
  }
  return {
    status: 'on-track',
    ...base,
    remainingKg: round2(remaining),
    daysLeft,
    etaDate: addDays(lastDate, daysLeft),
    points,
  };
}

function changeSince(trend, n) {
  if (!trend.length) return null;
  const latest = trend[trend.length - 1];
  const target = addDays(latest.date, -n);
  const past = trend.find((t) => t.date === target);
  return past ? round2(latest.value - past.value) : null;
}

/** Veränderung im Zeitraum, auf derselben geglätteten Basis wie die 7- und 30-Tage-Werte. */
function rangeChange(trend, start, endDate) {
  const end = trend.find((t) => t.date === endDate);
  const base = trend.find((t) => t.date === addDays(start, -1)) ?? trend.find((t) => t.date >= start);
  return end && base ? round2(end.value - base.value) : null;
}

export function computeStats(allDays, rangeDays, trend, start) {
  const changes = {
    week: changeSince(trend, 7),
    month: changeSince(trend, 30),
    year: changeSince(trend, 365),
  };
  if (!rangeDays.length) return { changes, range: null, latest: allDays.at(-1)?.last ?? null, trend: trend.at(-1)?.value ?? null };

  const low = rangeDays.reduce((a, d) => (d.min < a.min ? d : a));
  const high = rangeDays.reduce((a, d) => (d.max > a.max ? d : a));
  return {
    changes,
    latest: allDays.at(-1).last,
    latestDate: allDays.at(-1).date,
    trend: trend.at(-1)?.value ?? null,
    range: {
      mean: round2(mean(rangeDays.map((d) => d.mean))),
      min: low.min,
      minDate: low.date,
      max: high.max,
      maxDate: high.date,
      change: rangeChange(trend, start, rangeDays.at(-1).date),
      daysMeasured: rangeDays.length,
      measurements: rangeDays.reduce((a, d) => a + d.count, 0),
    },
  };
}

export function buildDashboard({ measurements, periods, goal, from, to }) {
  const allDays = aggregateDays(measurements);
  const trend = computeTrend(allDays);
  const start = from ?? allDays[0]?.date ?? to;
  const rangeDays = allDays.filter((d) => d.date >= start && d.date <= to);
  return {
    range: { from: start, to },
    days: rangeDays,
    trend: trend.filter((t) => t.date >= start && t.date <= to),
    periods: periods.filter((p) => p.endDate >= start && p.startDate <= to),
    goal,
    forecast: computeForecast(allDays, goal),
    stats: computeStats(allDays, rangeDays, trend, start),
  };
}
