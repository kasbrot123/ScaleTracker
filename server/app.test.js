import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from './app.js';
import { parseCsv } from './csv.js';
import { parseDate, parseWeight } from './parse.js';
import { seedDemo } from './seed.js';
import { aggregateDays, computeForecast, computeTrend } from './stats.js';
import { openStore } from './store.js';

const PASSWORD = 'test-passwort';
let server;
let base;
let store;
let cookie;

const call = (path, { method = 'GET', body, headers = {}, session = true } = {}) => fetch(`${base}${path}`, {
  method,
  headers: {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(session && cookie ? { Cookie: cookie, 'X-Requested-With': 'gewicht' } : {}),
    ...headers,
  },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});

before(async () => {
  store = openStore(':memory:');
  const app = createApp({ store, password: PASSWORD, now: () => new Date(2026, 10, 22, 12) });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); store.close(); });

test('Parser verstehen deutsche und ISO-Formate', () => {
  assert.equal(parseDate('22.11.2026'), '2026-11-22');
  assert.equal(parseDate('22.11.26'), '2026-11-22');
  assert.equal(parseDate('2026-11-22'), '2026-11-22');
  assert.equal(parseDate('31.02.2026'), null);
  assert.equal(parseWeight('82,5 kg'), 82500);
  assert.equal(parseWeight(82.35), 82350);
  assert.equal(parseWeight('8'), null);
});

test('CSV: Trennzeichen, Dezimalkomma, Standardzeit, Stern', () => {
  const a = parseCsv('01.11.2026,82,5\n02.11.2026,82.4,Notiz');
  assert.equal(a.rows.length, 2);
  assert.equal(a.rows[0].grams, 82500);
  assert.equal(a.rows[0].time, '08:00');
  assert.equal(a.rows[1].note, 'Notiz');

  const b = parseCsv('Datum;Uhrzeit;Gewicht;Notiz\n03.11.2026;21:15;83,1;*Wichtig\nkaputt;;1;');
  assert.equal(b.rows[0].time, '21:15');
  assert.equal(b.rows[0].starred, true);
  assert.equal(b.rows[0].note, 'Wichtig');
  assert.equal(b.errors.length, 1);
  assert.equal(b.errors[0].line, 3);
});

test('CSV: Bereiche als Von-Bis-Zeile', () => {
  const r = parseCsv([
    'Datum;Gewicht;Notiz',
    '12.11.2026-17.11.2026;;Urlaub',
    '20.11.-22.11.2026;NaN;Kur',
    '28.12.2026 bis 03.01.2027;-;Ski',
    '13.11.2026;83,4;Messung im Urlaub',
    '28.12.-03.01.2027;;Falsch',
    '01.12.2026-02.12.2026;80;Mit Gewicht',
    '05.12.2026-06.12.2026;;',
  ].join('\n'));
  assert.deepEqual(r.periods, [
    { tag: 'Urlaub', startDate: '2026-11-12', endDate: '2026-11-17' },
    { tag: 'Kur', startDate: '2026-11-20', endDate: '2026-11-22' },
    { tag: 'Ski', startDate: '2026-12-28', endDate: '2027-01-03' },
  ]);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].note, 'Messung im Urlaub');
  assert.equal(r.errors.length, 3);
});

test('CSV: einzelne Tage werden zu einem Bereich, Lücken trennen', () => {
  const r = parseCsv([
    '14.11.2026;NaN;Urlaub',
    '12.11.2026;NaN;Urlaub',
    '13.11.2026;-;urlaub',
    '16.11.2026;;Urlaub',
    '13.11.2026;nan;Krank',
    '31.12.2026;NaN;Silvester',
    '01.01.2027;NaN;Silvester',
  ].join('\n'));
  assert.deepEqual(r.periods, [
    { tag: 'Urlaub', startDate: '2026-11-12', endDate: '2026-11-14' },
    { tag: 'Krank', startDate: '2026-11-13', endDate: '2026-11-13' },
    { tag: 'Urlaub', startDate: '2026-11-16', endDate: '2026-11-16' },
    { tag: 'Silvester', startDate: '2026-12-31', endDate: '2027-01-01' },
  ]);
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 0);
});

test('CSV: Zeilen ohne Gewicht und ohne Text werden ignoriert', () => {
  const r = parseCsv([
    'Datum;Gewicht;Notiz',
    '10.11.2026;NaN;',
    '11.11.2026;nan',
    '12.11.2026;-;',
    '13.11.2026;;',
    '14.11.2026;82,5;Echt',
    'kaputt;NaN;',
    '15.11.2026;abc;',
  ].join('\n'));
  assert.equal(r.rows.length, 1);
  assert.equal(r.periods.length, 0);
  assert.deepEqual(r.errors.map((e) => e.line), [7, 8]);
});

test('Import von Bereichen: kein Duplikat, Überlappung wird zusammengeführt', () => {
  const s = openStore(':memory:');
  const run = (list) => s.importPeriods(list);
  const urlaub = (startDate, endDate) => ({ tag: 'Urlaub', startDate, endDate });
  assert.equal(run([urlaub('2026-11-12', '2026-11-17')]).created, 1);
  assert.equal(run([urlaub('2026-11-12', '2026-11-17')]).duplicates, 1);
  assert.equal(run([urlaub('2026-11-13', '2026-11-14')]).duplicates, 1);
  assert.equal(run([urlaub('2026-11-20', '2026-11-22')]).created, 1);
  assert.equal(run([urlaub('2026-11-18', '2026-11-19')]).extended, 1);
  const periods = s.listPeriods();
  assert.equal(periods.length, 1);
  assert.deepEqual([periods[0].startDate, periods[0].endDate], ['2026-11-12', '2026-11-22']);
  s.close();
});

test('Tageswerte und Trend', () => {
  const days = aggregateDays([
    { date: '2026-11-01', time: '07:00', grams: 80000, weight: 80, starred: false },
    { date: '2026-11-01', time: '21:00', grams: 82000, weight: 82, starred: true },
    { date: '2026-11-02', time: '07:00', grams: 79000, weight: 79, starred: false },
  ]);
  assert.deepEqual([days[0].first, days[0].mean, days[0].min, days[0].max, days[0].count], [80, 81, 80, 82, 2]);
  assert.equal(days[0].starred, true);
  assert.equal(computeTrend(days).at(-1).value, 79.5);
});

test('Prognose bei gleichmäßiger Abnahme', () => {
  const days = Array.from({ length: 21 }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    first: 90 - i * 0.1,
  }));
  const f = computeForecast(days, 87);
  assert.equal(f.status, 'on-track');
  assert.equal(f.slopePerWeek, -0.7);
  assert.equal(f.daysLeft, 10);
  assert.equal(computeForecast(days, 95).status, 'wrong-direction');
  assert.equal(computeForecast(days.slice(0, 3), 87).status, 'not-enough-data');
});

test('API verlangt Login und lehnt falsches Passwort ab', async () => {
  assert.equal((await call('/api/measurements', { session: false })).status, 401);
  assert.equal((await call('/api/login', { method: 'POST', body: { password: 'falsch' }, session: false })).status, 401);
  const res = await call('/api/login', { method: 'POST', body: { password: PASSWORD }, session: false });
  assert.equal(res.status, 200);
  cookie = res.headers.get('set-cookie').split(';')[0];
});

test('Session-Schreibzugriff braucht CSRF-Header', async () => {
  const res = await fetch(`${base}/api/measurements`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ date: '2026-11-01', weight: 80 }),
  });
  assert.equal(res.status, 403);
});

test('Messung anlegen, Duplikat, bearbeiten, löschen', async () => {
  const created = await call('/api/measurements', { method: 'POST', body: { date: '2026-11-10', weight: '82,5', note: 'Test', tags: 'Sport, sport' } });
  assert.equal(created.status, 201);
  const m = await created.json();
  assert.equal(m.time, '08:00');
  assert.deepEqual(m.tags, ['Sport']);

  const dup = await call('/api/measurements', { method: 'POST', body: { date: '2026-11-10', weight: 82.5 } });
  assert.equal(dup.status, 200);
  assert.equal((await dup.json()).duplicate, true);

  const patched = await (await call(`/api/measurements/${m.id}`, { method: 'PATCH', body: { starred: true } })).json();
  assert.equal(patched.starred, true);
  assert.equal(patched.weight, 82.5);
  assert.equal(patched.note, 'Test');
  assert.deepEqual(patched.tags, ['Sport']);

  assert.equal((await call(`/api/measurements/${m.id}`, { method: 'DELETE' })).status, 204);
  assert.equal((await call(`/api/measurements/${m.id}`)).status, 404);
});

test('API-Token kann schreiben und lesen, aber keine Tokens verwalten', async () => {
  const { id, token } = await (await call('/api/tokens', { method: 'POST', body: { name: 'Skript' } })).json();
  const auth = { Authorization: `Bearer ${token}` };
  const post = await call('/api/measurements', { method: 'POST', session: false, headers: auth, body: { date: '2026-11-11', weight: 81 } });
  assert.equal(post.status, 201);
  assert.equal((await post.json()).source, 'api');
  assert.equal((await call('/api/measurements?from=2026-11-11', { session: false, headers: auth })).status, 200);
  assert.equal((await call('/api/tokens', { session: false, headers: auth })).status, 403);
  await call(`/api/tokens/${id}`, { method: 'DELETE' });
  assert.equal((await call('/api/measurements', { session: false, headers: auth })).status, 401);
});

test('Gelöschte Demo-Daten kommen nicht zurück, eigenes Ziel bleibt', () => {
  const s = openStore(':memory:');
  assert.ok(seedDemo(s, '2026-11-22') > 0);
  s.setSetting('goal', '75');
  s.deleteSetting('demo_goal');
  s.deleteDemo();
  assert.equal(s.countMeasurements(), 0);
  assert.equal(s.listPeriods().length, 0);
  assert.equal(s.getSetting('goal'), '75');
  assert.equal(seedDemo(s, '2026-11-22'), 0);
  s.close();
});

test('Import ist wiederholbar und Export lässt sich reimportieren', async () => {
  const csv = '12.11.2026;80,5;Eins\n13.11.2026;80,2;Zwei\n14.11.2026;80,125;Drei';
  const first = await (await call('/api/import', { method: 'POST', body: { csv } })).json();
  assert.equal(first.imported, 3);
  const second = await (await call('/api/import', { method: 'POST', body: { csv } })).json();
  assert.deepEqual([second.imported, second.duplicates], [0, 3]);

  const exported = await (await call('/api/export.csv')).text();
  const again = await (await call('/api/import', { method: 'POST', body: { csv: exported } })).json();
  assert.equal(again.imported, 0);
  assert.equal(again.errors.length, 0);
});
