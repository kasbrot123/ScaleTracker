import {
  addDays, isBlankWeight, parseBool, parseDateRange, parseDateTime, parseTags, parseTime, parseWeight, DEFAULT_TIME,
} from './parse.js';

const HEADERS = {
  date: ['datum', 'date', 'tag', 'day', 'zeitpunkt', 'datetime', 'timestamp'],
  time: ['uhrzeit', 'zeit', 'time'],
  weight: ['gewicht', 'weight', 'kg', 'wert', 'value'],
  note: ['notiz', 'note', 'text', 'kommentar', 'comment'],
  starred: ['stern', 'star', 'starred', 'highlight'],
  tags: ['tags', 'tag_liste', 'labels'],
};

function detectDelimiter(line) {
  if (line.includes(';')) return ';';
  if (line.includes('\t')) return '\t';
  return ',';
}

function splitLine(line, delimiter) {
  // Dezimalkomma bei Komma-getrennten Dateien schützen: 01.11.2026,82,5
  const src = delimiter === ',' ? line.replace(/(^|,)(\d{2,3}),(\d{1,3})(?=\s*(?:kg)?\s*(?:,|$))/i, '$1$2.$3') : line;
  const fields = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { fields.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  fields.push(cur.trim());
  return fields;
}

function readHeader(fields) {
  const map = {};
  fields.forEach((f, i) => {
    const key = f.toLowerCase().replace(/\(.*\)/, '').trim();
    for (const [name, aliases] of Object.entries(HEADERS)) {
      if (aliases.includes(key) && map[name] === undefined) map[name] = i;
    }
  });
  return map.date !== undefined && map.weight !== undefined ? map : null;
}

/** Ohne Kopfzeile: Datum, optional Uhrzeit, Gewicht, optional Notiz. */
function positionalMap(fields) {
  return parseTime(fields[1]) ? { date: 0, time: 1, weight: 2, note: 3 } : { date: 0, weight: 1, note: 2 };
}

/** Fasst überlappende und direkt aufeinanderfolgende Tage mit gleichem Text zusammen. */
function mergePeriods(list) {
  const byTag = new Map();
  for (const p of list) {
    const key = p.tag.toLowerCase();
    if (!byTag.has(key)) byTag.set(key, []);
    byTag.get(key).push(p);
  }
  const merged = [];
  for (const group of byTag.values()) {
    const sorted = [...group].sort((a, b) => a.startDate.localeCompare(b.startDate));
    let current = null;
    for (const p of sorted) {
      if (current && p.startDate <= addDays(current.endDate, 1)) {
        if (p.endDate > current.endDate) current.endDate = p.endDate;
      } else {
        current = { tag: group[0].tag, startDate: p.startDate, endDate: p.endDate };
        merged.push(current);
      }
    }
  }
  return merged.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

export function parseCsv(text) {
  const lines = String(text ?? '').replace(/^﻿/, '').split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => l.trim());
  if (firstIdx < 0) return { rows: [], periods: [], errors: [] };

  const delimiter = detectDelimiter(lines[firstIdx]);
  const header = readHeader(splitLine(lines[firstIdx], delimiter));
  const rows = [];
  const periods = [];
  const errors = [];

  for (let i = header ? firstIdx + 1 : firstIdx; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const fields = splitLine(lines[i], delimiter);
    const map = header ?? positionalMap(fields);

    const range = parseDateRange(fields[map.date]);
    const blankWeight = isBlankWeight(fields[map.weight]);
    const rawLabel = (map.note !== undefined ? fields[map.note] : '')
      || (header ? '' : fields.slice(map.weight + 1).find(Boolean) || '');
    const [label] = parseTags([rawLabel.replace(/^[*★]\s*/, '')]);

    if (range) {
      if (range.error) errors.push({ line: i + 1, message: range.error });
      else if (!blankWeight) errors.push({ line: i + 1, message: 'Ein Bereich darf kein Gewicht haben.' });
      else if (!label) errors.push({ line: i + 1, message: 'Für den Bereich fehlt der Text.' });
      else periods.push({ tag: label, startDate: range.startDate, endDate: range.endDate });
      continue;
    }

    // Einzelner Tag ohne Gewicht, aber mit Text: wird Teil eines Bereichs.
    if (blankWeight && label) {
      const day = parseDateTime(fields[map.date]);
      if (!day) errors.push({ line: i + 1, message: `Datum nicht lesbar: "${fields[map.date] ?? ''}"` });
      else periods.push({ tag: label, startDate: day.date, endDate: day.date });
      continue;
    }

    const when = parseDateTime(fields[map.date]);
    // Tag ohne Gewicht und ohne Text: nichts zu speichern, also kein Fehler.
    if (when && blankWeight) continue;
    const grams = parseWeight(fields[map.weight]);
    if (!when) { errors.push({ line: i + 1, message: `Datum nicht lesbar: "${fields[map.date] ?? ''}"` }); continue; }
    if (grams === null) { errors.push({ line: i + 1, message: `Gewicht nicht lesbar: "${fields[map.weight] ?? ''}"` }); continue; }

    const explicitTime = map.time !== undefined && fields[map.time] ? parseTime(fields[map.time]) : null;
    if (map.time !== undefined && fields[map.time] && !explicitTime) {
      errors.push({ line: i + 1, message: `Uhrzeit nicht lesbar: "${fields[map.time]}"` });
      continue;
    }

    let note = map.note !== undefined ? fields[map.note] ?? '' : '';
    let starred = map.starred !== undefined ? parseBool(fields[map.starred]) : false;
    if (/^[*★]/.test(note)) { starred = true; note = note.replace(/^[*★]\s*/, ''); }

    rows.push({
      date: when.date,
      time: explicitTime ?? when.time ?? DEFAULT_TIME,
      grams,
      note,
      starred,
      tags: map.tags !== undefined ? parseTags(fields[map.tags]) : [],
    });
  }
  return { rows, periods: mergePeriods(periods), errors };
}

function quote(value) {
  const s = String(value ?? '');
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(measurements) {
  const head = 'Datum;Uhrzeit;Gewicht;Notiz;Stern;Tags';
  const body = measurements.map((m) => [
    m.date,
    m.time,
    String(m.grams / 1000).replace('.', ','),
    quote(m.note),
    m.starred ? 'ja' : '',
    quote(m.tags.join(', ')),
  ].join(';'));
  return `﻿${[head, ...body].join('\r\n')}\r\n`;
}
