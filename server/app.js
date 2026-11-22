import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { parseCsv, toCsv } from './csv.js';
import { addDays, localDate, parseDate, parseWeight } from './parse.js';
import { buildDashboard } from './stats.js';
import { ApiError } from './store.js';

const SESSION_COOKIE = 'gewicht_session';
const SESSION_TTL = 90 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 10;

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const samePassword = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

const idParam = (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ApiError(400, 'Ungültige ID.');
  return id;
};

const dateQuery = (value, label) => {
  if (value === undefined || value === '') return undefined;
  const date = parseDate(value);
  if (!date) throw new ApiError(400, `${label} ist ungültig.`);
  return date;
};

export function createApp({ store, password, cookieSecure = false, now = () => new Date() }) {
  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use(express.json({ limit: '2mb' }));
  app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '10mb' }));

  const failures = new Map();
  const cookieOptions = { httpOnly: true, sameSite: 'lax', secure: cookieSecure, path: '/' };

  app.post('/api/login', (req, res) => {
    const key = req.ip;
    const entry = failures.get(key);
    if (entry && Date.now() - entry.since > LOGIN_WINDOW) failures.delete(key);
    if ((failures.get(key)?.count ?? 0) >= LOGIN_MAX_FAILS) {
      throw new ApiError(429, 'Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen.');
    }
    if (typeof req.body?.password !== 'string' || !samePassword(req.body.password, password)) {
      const cur = failures.get(key) ?? { count: 0, since: Date.now() };
      cur.count++;
      failures.set(key, cur);
      throw new ApiError(401, 'Passwort ist falsch.');
    }
    failures.delete(key);
    res.cookie(SESSION_COOKIE, store.createSession(SESSION_TTL), { ...cookieOptions, maxAge: SESSION_TTL });
    res.json({ authenticated: true });
  });

  app.get('/api/session', (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    res.json({ authenticated: !!token && store.hasSession(token) });
  });

  // Alles ab hier braucht Sitzung oder API-Token.
  app.use('/api', (req, _res, next) => {
    const bearer = (req.headers.authorization ?? '').match(/^Bearer\s+(.+)$/i)?.[1];
    if (bearer) {
      if (!store.useToken(bearer)) throw new ApiError(401, 'API-Token ist ungültig.');
      req.viaToken = true;
      return next();
    }
    const token = readCookie(req, SESSION_COOKIE);
    if (!token || !store.hasSession(token)) throw new ApiError(401, 'Bitte anmelden.');
    req.sessionToken = token;
    // Schutz gegen CSRF: fremde Seiten können diesen Header nicht ohne CORS setzen.
    if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-requested-with'] !== 'gewicht') {
      throw new ApiError(403, 'Anfrage abgelehnt.');
    }
    next();
  });

  const sessionOnly = (req, _res, next) => {
    if (req.viaToken) throw new ApiError(403, 'Nur in der Web-Oberfläche möglich.');
    next();
  };

  app.post('/api/logout', sessionOnly, (req, res) => {
    store.deleteSession(req.sessionToken);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ authenticated: false });
  });

  const readGoal = () => {
    const v = store.getSetting('goal');
    return v === null ? null : Number(v);
  };

  app.get('/api/dashboard', (req, res) => {
    const today = localDate(now());
    const to = dateQuery(req.query.to, 'Enddatum') ?? today;
    let from = dateQuery(req.query.from, 'Startdatum');
    if (!from && req.query.days && req.query.days !== 'all') {
      const days = Number(req.query.days);
      if (!Number.isInteger(days) || days < 1 || days > 36500) throw new ApiError(400, 'days ist ungültig.');
      from = addDays(to, -(days - 1));
    }
    if (from && from > to) throw new ApiError(400, 'Der Start liegt nach dem Ende.');
    res.json({
      today,
      ...buildDashboard({ measurements: store.listMeasurements(), periods: store.listPeriods(), goal: readGoal(), from, to }),
      demoCount: store.countDemo(),
    });
  });

  app.get('/api/measurements', (req, res) => {
    res.json(store.listMeasurements({
      from: dateQuery(req.query.from, 'Startdatum'),
      to: dateQuery(req.query.to, 'Enddatum'),
      tag: req.query.tag ? String(req.query.tag) : undefined,
      starred: req.query.starred === 'true' || req.query.starred === '1',
    }));
  });

  app.post('/api/measurements', (req, res) => {
    const source = req.viaToken ? 'api' : 'manual';
    if (Array.isArray(req.body)) {
      const results = store.transaction(() => req.body.map((item) => store.createMeasurement(item, source)));
      return res.status(201).json({
        imported: results.filter((r) => r.created).length,
        duplicates: results.filter((r) => !r.created).length,
        measurements: results.map((r) => r.measurement),
      });
    }
    if (!req.body || typeof req.body !== 'object') throw new ApiError(400, 'JSON-Daten fehlen.');
    const result = store.createMeasurement(req.body, source);
    res.status(result.created ? 201 : 200).json({ ...result.measurement, duplicate: !result.created });
  });

  app.get('/api/measurements/:id', (req, res) => {
    const m = store.getMeasurement(idParam(req));
    if (!m) throw new ApiError(404, 'Messung nicht gefunden.');
    res.json(m);
  });

  app.patch('/api/measurements/:id', (req, res) => {
    res.json(store.updateMeasurement(idParam(req), req.body ?? {}));
  });

  app.delete('/api/measurements/:id', (req, res) => {
    store.deleteMeasurement(idParam(req));
    res.status(204).end();
  });

  app.post('/api/import', (req, res) => {
    const text = typeof req.body === 'string' ? req.body : req.body?.csv;
    if (typeof text !== 'string' || !text.trim()) throw new ApiError(400, 'CSV-Inhalt fehlt.');
    const { rows, periods, errors } = parseCsv(text);
    const result = store.transaction(() => ({
      ...store.importRows(rows, 'csv'),
      periods: store.importPeriods(periods),
    }));
    res.json({ ...result, errors });
  });

  app.get('/api/export.csv', (_req, res) => {
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="scaletracker-${localDate(now())}.csv"`,
    });
    res.send(toCsv(store.listMeasurements()));
  });

  app.get('/api/goal', (_req, res) => res.json({ goal: readGoal() }));
  app.put('/api/goal', (req, res) => {
    const value = req.body?.goal;
    if (value === null || value === '') {
      store.deleteSetting('goal');
      store.deleteSetting('demo_goal');
      return res.json({ goal: null });
    }
    const grams = parseWeight(value);
    if (grams === null) throw new ApiError(400, 'Zielgewicht muss zwischen 20 und 400 kg liegen.');
    store.setSetting('goal', grams / 1000);
    // Ab jetzt ist es dein Ziel und wird beim Löschen der Demo-Daten nicht mehr entfernt.
    store.deleteSetting('demo_goal');
    res.json({ goal: grams / 1000 });
  });

  app.get('/api/tags', (_req, res) => res.json(store.listTags()));
  app.delete('/api/tags/:id', (req, res) => {
    store.deleteTag(idParam(req));
    res.status(204).end();
  });

  app.get('/api/periods', (_req, res) => res.json(store.listPeriods()));
  app.post('/api/periods', (req, res) => res.status(201).json(store.createPeriod(req.body ?? {})));
  app.delete('/api/periods/:id', (req, res) => {
    store.deletePeriod(idParam(req));
    res.status(204).end();
  });

  app.delete('/api/demo', sessionOnly, (_req, res) => res.json({ removed: store.deleteDemo() }));

  app.get('/api/tokens', sessionOnly, (_req, res) => res.json(store.listTokens()));
  app.post('/api/tokens', sessionOnly, (req, res) => res.status(201).json(store.createToken(req.body?.name)));
  app.delete('/api/tokens/:id', sessionOnly, (req, res) => {
    store.deleteToken(idParam(req));
    res.status(204).end();
  });

  app.use('/api', () => { throw new ApiError(404, 'Unbekannter Endpunkt.'); });

  app.get('/vendor/echarts.min.js', (_req, res) => {
    res.sendFile(require.resolve('echarts/dist/echarts.min.js'), { maxAge: '7d' });
  });
  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));

  app.use((err, _req, res, _next) => {
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON ist ungültig.' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Datei ist zu groß.' });
    console.error(err);
    res.status(500).json({ error: 'Interner Fehler.' });
  });

  return app;
}
