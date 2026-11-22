import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { addDays, DEFAULT_TIME, parseBool, parseDate, parseTags, parseTime, parseWeight } from './parse.js';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  grams INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  starred INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (date, time, grams)
);
CREATE INDEX IF NOT EXISTS idx_measurements_date ON measurements (date, time);
CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS measurement_tags (
  measurement_id INTEGER NOT NULL REFERENCES measurements(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (measurement_id, tag_id)
);
CREATE TABLE IF NOT EXISTS periods (
  id INTEGER PRIMARY KEY,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);
`;

const SELECT = `
SELECT m.id, m.date, m.time, m.grams, m.note, m.starred, m.source,
  (SELECT json_group_array(t.name) FROM measurement_tags mt JOIN tags t ON t.id = mt.tag_id
   WHERE mt.measurement_id = m.id) AS tags
FROM measurements m`;

const toMeasurement = (r) => ({
  id: r.id,
  date: r.date,
  time: r.time,
  grams: r.grams,
  weight: r.grams / 1000,
  note: r.note,
  starred: !!r.starred,
  source: r.source,
  tags: JSON.parse(r.tags),
});

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export function normalizeMeasurement(input, existing = null) {
  const pick = (key) => (input[key] !== undefined ? input[key] : existing?.[key]);

  const date = parseDate(pick('date'));
  if (!date) throw new ApiError(400, 'Datum fehlt oder ist ungültig.');

  const rawTime = pick('time');
  const time = rawTime === undefined || rawTime === null || rawTime === '' ? DEFAULT_TIME : parseTime(rawTime);
  if (!time) throw new ApiError(400, 'Uhrzeit ist ungültig.');

  const grams = parseWeight(input.weight !== undefined ? input.weight : existing?.weight);
  if (grams === null) throw new ApiError(400, 'Gewicht muss zwischen 20 und 400 kg liegen.');

  const note = String(pick('note') ?? '').trim().slice(0, 1000);
  return { date, time, grams, note, starred: parseBool(pick('starred')), tags: parseTags(pick('tags') ?? []) };
}

export function openStore(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);

  const tagId = (name) => {
    db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
    return db.prepare('SELECT id FROM tags WHERE name = ?').get(name).id;
  };

  const setTags = (id, tags) => {
    db.prepare('DELETE FROM measurement_tags WHERE measurement_id = ?').run(id);
    const add = db.prepare('INSERT OR IGNORE INTO measurement_tags (measurement_id, tag_id) VALUES (?, ?)');
    for (const name of tags) add.run(id, tagId(name));
  };

  const getMeasurement = (id) => {
    const row = db.prepare(`${SELECT} WHERE m.id = ?`).get(id);
    return row ? toMeasurement(row) : null;
  };

  const insertRow = (row, source) => {
    const res = db.prepare(`INSERT OR IGNORE INTO measurements (date, time, grams, note, starred, source)
      VALUES (@date, @time, @grams, @note, @starred, @source)`)
      .run({ date: row.date, time: row.time, grams: row.grams, note: row.note, starred: row.starred ? 1 : 0, source });
    if (!res.changes) return null;
    const id = Number(res.lastInsertRowid);
    setTags(id, row.tags);
    return id;
  };

  return {
    db,
    close: () => db.close(),
    transaction: (fn) => db.transaction(fn)(),

    listMeasurements({ from, to, tag, starred } = {}) {
      const where = [];
      const params = {};
      if (from) { where.push('m.date >= @from'); params.from = from; }
      if (to) { where.push('m.date <= @to'); params.to = to; }
      if (starred) where.push('m.starred = 1');
      if (tag) {
        where.push(`EXISTS (SELECT 1 FROM measurement_tags mt JOIN tags t ON t.id = mt.tag_id
          WHERE mt.measurement_id = m.id AND t.name = @tag)`);
        params.tag = tag;
      }
      const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      return db.prepare(`${SELECT}${clause} ORDER BY m.date, m.time, m.id`).all(params).map(toMeasurement);
    },

    getMeasurement,

    /** Legt eine Messung an. Identische Messungen werden nicht doppelt gespeichert. */
    createMeasurement(input, source = 'manual') {
      const row = normalizeMeasurement(input);
      return db.transaction(() => {
        const id = insertRow(row, source);
        if (id !== null) return { created: true, measurement: getMeasurement(id) };
        const existing = db.prepare('SELECT id FROM measurements WHERE date = ? AND time = ? AND grams = ?')
          .get(row.date, row.time, row.grams);
        return { created: false, measurement: getMeasurement(existing.id) };
      })();
    },

    importRows(rows, source = 'csv') {
      return db.transaction(() => {
        let imported = 0;
        for (const row of rows) if (insertRow(row, source) !== null) imported++;
        return { imported, duplicates: rows.length - imported };
      })();
    },

    updateMeasurement(id, input) {
      const existing = getMeasurement(id);
      if (!existing) throw new ApiError(404, 'Messung nicht gefunden.');
      const row = normalizeMeasurement(input, existing);
      const clash = db.prepare('SELECT id FROM measurements WHERE date = ? AND time = ? AND grams = ? AND id != ?')
        .get(row.date, row.time, row.grams, id);
      if (clash) throw new ApiError(409, 'Eine identische Messung existiert bereits.');
      return db.transaction(() => {
        db.prepare(`UPDATE measurements SET date = @date, time = @time, grams = @grams, note = @note, starred = @starred
          WHERE id = @id`).run({ id, date: row.date, time: row.time, grams: row.grams, note: row.note, starred: row.starred ? 1 : 0 });
        setTags(id, row.tags);
        return getMeasurement(id);
      })();
    },

    deleteMeasurement(id) {
      if (!db.prepare('DELETE FROM measurements WHERE id = ?').run(id).changes) {
        throw new ApiError(404, 'Messung nicht gefunden.');
      }
    },

    countMeasurements: () => db.prepare('SELECT COUNT(*) AS n FROM measurements').get().n,
    countDemo: () => db.prepare("SELECT COUNT(*) AS n FROM measurements WHERE source = 'demo'").get().n,

    deleteDemo() {
      return db.transaction(() => {
        const removed = db.prepare("DELETE FROM measurements WHERE source = 'demo'").run().changes;
        const demoPeriods = db.prepare("SELECT value FROM settings WHERE key = 'demo_period_ids'").get();
        if (demoPeriods) {
          const del = db.prepare('DELETE FROM periods WHERE id = ?');
          for (const pid of JSON.parse(demoPeriods.value)) del.run(pid);
          db.prepare("DELETE FROM settings WHERE key = 'demo_period_ids'").run();
        }
        if (db.prepare("SELECT value FROM settings WHERE key = 'demo_goal'").get()) {
          db.prepare("DELETE FROM settings WHERE key IN ('demo_goal', 'goal')").run();
        }
        db.prepare(`DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM measurement_tags)
          AND id NOT IN (SELECT tag_id FROM periods)`).run();
        return removed;
      })();
    },

    getSetting: (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null,
    setSetting: (key, value) => db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(key, String(value)),
    deleteSetting: (key) => db.prepare('DELETE FROM settings WHERE key = ?').run(key),

    listTags: () => db.prepare(`SELECT t.id, t.name,
      (SELECT COUNT(*) FROM measurement_tags mt WHERE mt.tag_id = t.id) AS measurements
      FROM tags t ORDER BY t.name COLLATE NOCASE`).all(),

    deleteTag(id) {
      if (!db.prepare('DELETE FROM tags WHERE id = ?').run(id).changes) throw new ApiError(404, 'Tag nicht gefunden.');
    },

    listPeriods: () => db.prepare(`SELECT p.id, t.name AS tag, p.start_date AS startDate, p.end_date AS endDate
      FROM periods p JOIN tags t ON t.id = p.tag_id ORDER BY p.start_date`).all(),

    createPeriod({ tag, startDate, endDate }) {
      const [name] = parseTags([tag]);
      const start = parseDate(startDate);
      const end = parseDate(endDate || startDate);
      if (!name) throw new ApiError(400, 'Tag fehlt.');
      if (!start || !end) throw new ApiError(400, 'Zeitraum ist ungültig.');
      if (end < start) throw new ApiError(400, 'Das Ende liegt vor dem Start.');
      return db.transaction(() => {
        const res = db.prepare('INSERT INTO periods (tag_id, start_date, end_date) VALUES (?, ?, ?)').run(tagId(name), start, end);
        return { id: Number(res.lastInsertRowid), tag: name, startDate: start, endDate: end };
      })();
    },

    /** Legt Bereiche an. Überlappende Bereiche mit gleichem Tag werden zu einem zusammengeführt. */
    importPeriods(list) {
      // Ein importierter Bereich gehört dir und darf beim Löschen der Demo-Daten nicht verschwinden.
      const keepFromDemo = (ids) => {
        const raw = db.prepare("SELECT value FROM settings WHERE key = 'demo_period_ids'").get();
        if (!raw) return;
        const rest = JSON.parse(raw.value).filter((id) => !ids.includes(id));
        db.prepare("UPDATE settings SET value = ? WHERE key = 'demo_period_ids'").run(JSON.stringify(rest));
      };

      return db.transaction(() => {
        const result = { created: 0, extended: 0, duplicates: 0 };
        for (const p of list) {
          const tag = tagId(p.tag);
          const hits = db.prepare(`SELECT id, start_date AS startDate, end_date AS endDate FROM periods
            WHERE tag_id = ? AND start_date <= ? AND end_date >= ? ORDER BY start_date`)
            .all(tag, addDays(p.endDate, 1), addDays(p.startDate, -1));

          if (!hits.length) {
            db.prepare('INSERT INTO periods (tag_id, start_date, end_date) VALUES (?, ?, ?)').run(tag, p.startDate, p.endDate);
            result.created++;
            continue;
          }
          keepFromDemo(hits.map((h) => h.id));
          if (hits.some((h) => h.startDate <= p.startDate && h.endDate >= p.endDate)) {
            result.duplicates++;
            continue;
          }
          const start = [p.startDate, ...hits.map((h) => h.startDate)].sort()[0];
          const end = [p.endDate, ...hits.map((h) => h.endDate)].sort().at(-1);
          db.prepare('UPDATE periods SET start_date = ?, end_date = ? WHERE id = ?').run(start, end, hits[0].id);
          const remove = db.prepare('DELETE FROM periods WHERE id = ?');
          for (const h of hits.slice(1)) remove.run(h.id);
          result.extended++;
        }
        return result;
      })();
    },

    deletePeriod(id) {
      if (!db.prepare('DELETE FROM periods WHERE id = ?').run(id).changes) throw new ApiError(404, 'Zeitraum nicht gefunden.');
    },

    createSession(ttlMs) {
      const token = crypto.randomBytes(32).toString('base64url');
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
      db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(hashToken(token), Date.now() + ttlMs);
      return token;
    },
    hasSession: (token) => !!db.prepare('SELECT 1 FROM sessions WHERE token_hash = ? AND expires_at > ?').get(hashToken(token), Date.now()),
    deleteSession: (token) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token)),

    listTokens: () => db.prepare('SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens ORDER BY id').all(),
    createToken(name) {
      const clean = String(name ?? '').trim().slice(0, 60);
      if (!clean) throw new ApiError(400, 'Name fehlt.');
      const token = `gw_${crypto.randomBytes(32).toString('base64url')}`;
      const res = db.prepare('INSERT INTO api_tokens (name, token_hash) VALUES (?, ?)').run(clean, hashToken(token));
      return { id: Number(res.lastInsertRowid), name: clean, token };
    },
    useToken(token) {
      return db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_hash = ?").run(hashToken(token)).changes > 0;
    },
    deleteToken(id) {
      if (!db.prepare('DELETE FROM api_tokens WHERE id = ?').run(id).changes) throw new ApiError(404, 'Token nicht gefunden.');
    },
  };
}
