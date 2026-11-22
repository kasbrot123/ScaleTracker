// Tolerante Eingabe-Parser für Formular, API und CSV.

export const DEFAULT_TIME = '08:00';
const MIN_GRAMS = 20000;
const MAX_GRAMS = 400000;

const pad = (n) => String(n).padStart(2, '0');

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Akzeptiert 2026-11-22, 22.11.2026, 22.11.26 und 22/11/2026. */
export function parseDate(value) {
  const s = String(value ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2}|\d{4})$/);
  if (m) {
    const year = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return validDate(year, +m[2], +m[1]);
  }
  return null;
}

export function parseTime(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${pad(+m[1])}:${m[2]}`;
}

/** Trennt "22.11.2026 07:30" oder ISO "2026-11-22T07:30:00" in Datum und Zeit. */
export function parseDateTime(value) {
  const s = String(value ?? '').trim();
  const [datePart, timePart] = s.split(/[T ]+/);
  const date = parseDate(datePart);
  if (!date) return null;
  if (!timePart) return { date, time: null };
  const time = parseTime(timePart.replace(/(Z|[+-]\d{2}:?\d{2})$/, ''));
  return time ? { date, time } : null;
}

const RANGE_ISO = /^(\d{4}-\d{1,2}-\d{1,2})\s*(?:-|–|—|bis)\s*(\d{4}-\d{1,2}-\d{1,2})$/i;
const RANGE_DE = /^(\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})?)\s*(?:-|–|—|bis)\s*(\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2}))$/i;

/**
 * Erkennt 12.11.2026-17.11.2026, 12.11.-17.11.2026 und ISO-Bereiche.
 * Liefert null, wenn es kein Bereich ist, sonst { startDate, endDate } oder { error }.
 */
export function parseDateRange(value) {
  const s = String(value ?? '').trim();
  const m = s.match(RANGE_ISO) ?? s.match(RANGE_DE);
  if (!m) return null;
  const endDate = parseDate(m[2]);
  const startText = m[1].endsWith('.') && endDate ? `${m[1]}${endDate.slice(0, 4)}` : m[1];
  const startDate = parseDate(startText);
  if (!startDate || !endDate) return { error: `Bereich nicht lesbar: "${s}"` };
  if (startDate > endDate) {
    return { error: `Start liegt nach dem Ende: "${s}". Über den Jahreswechsel bitte beide Jahre angeben.` };
  }
  return { startDate, endDate };
}

/** Platzhalter für "kein Gewicht": leer, NaN, NA oder ein Strich. */
export function isBlankWeight(value) {
  return /^(|nan|na|n\/a|-|–|—)$/i.test(String(value ?? '').trim());
}

/** Akzeptiert 82.5, "82,5" und "82,5 kg". Liefert Gramm oder null. */
export function parseWeight(value) {
  const s = String(value ?? '').trim().replace(/\s*kg$/i, '').replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(s)) return null;
  const grams = Math.round(Number(s) * 1000);
  return grams >= MIN_GRAMS && grams <= MAX_GRAMS ? grams : null;
}

export function parseTags(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(',');
  const seen = new Map();
  for (const raw of list) {
    const name = String(raw).replace(/,/g, ' ').trim().slice(0, 40);
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()];
}

export function parseBool(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'ja', 'yes', 'x', '*', '★'].includes(String(value ?? '').trim().toLowerCase());
}

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function dayNumber(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}
