import { addDays, localDate } from './parse.js';

// Kleiner deterministischer Zufallsgenerator, damit die Demo-Daten reproduzierbar sind.
function mulberry32(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NOTES = {
  3: { note: 'Start der Ernährungsumstellung', starred: true, tags: ['Diät'] },
  11: { note: 'Abends Pizza mit Freunden', tags: ['Essen gehen'] },
  18: { note: 'Erste Woche mit 3x Sport geschafft', starred: true, tags: ['Sport'] },
  24: { note: 'Schlecht geschlafen', tags: [] },
  31: { note: 'Neuer Tiefstand', starred: true, tags: [] },
};

export function seedDemo(store, today = localDate()) {
  // Nur einmal im Leben der Datenbank, damit gelöschte Demo-Daten nicht zurückkommen.
  if (store.getSetting('demo_seeded')) return 0;
  store.setSetting('demo_seeded', '1');
  if (store.countMeasurements() > 0) return 0;

  const DAYS = 35;
  const random = mulberry32(20261122);
  const start = addDays(today, -(DAYS - 1));
  const rows = [];

  for (let i = 0; i < DAYS; i++) {
    const date = addDays(start, i);
    const base = 85.4 - i * 0.075 + Math.sin(i / 2.3) * 0.28;
    const skip = random() < 0.1 && i !== DAYS - 1 && !NOTES[i];
    const noise = (random() - 0.5) * 0.5;
    const evening = random() < 0.3;
    const minute = String(Math.floor(random() * 45)).padStart(2, '0');
    if (skip) continue;

    const extra = NOTES[i] ?? {};
    rows.push({
      date,
      time: `07:${minute}`,
      grams: Math.round((base + noise) * 10) * 100,
      note: extra.note ?? '',
      starred: !!extra.starred,
      tags: extra.tags ?? [],
    });
    if (evening) {
      rows.push({
        date,
        time: `21:${minute}`,
        grams: Math.round((base + noise + 0.8 + random() * 0.9) * 10) * 100,
        note: '',
        starred: false,
        tags: [],
      });
    }
  }

  store.importRows(rows, 'demo');
  const periods = [
    store.createPeriod({ tag: 'Diät', startDate: addDays(start, 3), endDate: today }),
    store.createPeriod({ tag: 'Urlaub', startDate: addDays(start, 13), endDate: addDays(start, 16) }),
  ];
  store.setSetting('demo_period_ids', JSON.stringify(periods.map((p) => p.id)));
  store.setSetting('goal', '80');
  store.setSetting('demo_goal', '1');
  return rows.length;
}
