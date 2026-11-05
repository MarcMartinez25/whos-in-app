import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const PORT = Number(process.env.PORT) || 3000;
const MAX_NAME_LENGTH = 30;
const MAX_TEAM_NAME_LENGTH = 40;
const MAX_TIME_LENGTH = 30;
const MAX_GAMES = 60;
const MAX_BODY_BYTES = 16_384;
const MAX_EMAIL_LENGTH = 254;
const RECOVERY_COOLDOWN_MS = 10 * 60 * 1000;

const { RESEND_API_KEY, RAILWAY_PUBLIC_DOMAIN } = process.env;
const EMAIL_FROM = process.env.EMAIL_FROM || "Who's In? <onboarding@resend.dev>";

// Links in emails come from here, never from the request's Host header, which
// anyone can fake.
const SITE_URL =
  process.env.SITE_URL ||
  (RAILWAY_PUBLIC_DOMAIN ? `https://${RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);

// Railway sets RAILWAY_VOLUME_MOUNT_PATH once a volume is attached.
const DB_PATH =
  process.env.DB_PATH ||
  join(process.env.RAILWAY_VOLUME_MOUNT_PATH || join(import.meta.dirname, 'data'), 'whos-in.db');

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS games (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    type TEXT NOT NULL,
    time TEXT,
    doubleheader INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (team_id, date)
  );
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY,
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    UNIQUE (team_id, name_key)
  );
  CREATE TABLE IF NOT EXISTS absences (
    player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_date TEXT NOT NULL,
    PRIMARY KEY (player_id, game_date)
  );
`);

const sql = {
  team: db.prepare('SELECT id, name, hits FROM teams WHERE id = ?'),
  teamsByEmail: db.prepare('SELECT id, name FROM teams WHERE email = ? ORDER BY created_at'),
  addTeam: db.prepare('INSERT INTO teams (id, name, email) VALUES (?, ?, ?)'),
  renameTeam: db.prepare('UPDATE teams SET name = ? WHERE id = ?'),
  addHit: db.prepare('UPDATE teams SET hits = hits + 1 WHERE id = ?'),
  games: db.prepare('SELECT date, type, time, doubleheader FROM games WHERE team_id = ? ORDER BY date'),
  game: db.prepare(`SELECT 1 FROM games WHERE team_id = ? AND date = ? AND type = 'game'`),
  addGame: db.prepare('INSERT INTO games (team_id, date, type, time, doubleheader) VALUES (?, ?, ?, ?, ?)'),
  clearGames: db.prepare('DELETE FROM games WHERE team_id = ?'),
  players: db.prepare('SELECT id, name FROM players WHERE team_id = ? ORDER BY name COLLATE NOCASE'),
  absences: db.prepare(`
    SELECT a.player_id, a.game_date FROM absences a
    JOIN players p ON p.id = a.player_id
    WHERE p.team_id = ?
  `),
  findPlayer: db.prepare('SELECT id, name FROM players WHERE team_id = ? AND name_key = ?'),
  addPlayer: db.prepare(`
    INSERT INTO players (team_id, name, name_key) VALUES (?, ?, ?)
    ON CONFLICT (team_id, name_key) DO NOTHING
  `),
  removePlayer: db.prepare('DELETE FROM players WHERE team_id = ? AND name_key = ?'),
  markOut: db.prepare('INSERT OR IGNORE INTO absences (player_id, game_date) VALUES (?, ?)'),
  markIn: db.prepare('DELETE FROM absences WHERE player_id = ? AND game_date = ?'),
};

function transaction(work) {
  db.exec('BEGIN');
  try {
    work();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// "  marco   MARTINEZ " and "Marco Martinez" should land on the same player.
const cleanText = (raw) => (typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '');
const nameKey = (name) => name.toLowerCase();

function requireName(body) {
  const name = cleanText(body.name);
  if (!name) throw new HttpError(400, 'Name is required');
  if (name.length > MAX_NAME_LENGTH) throw new HttpError(400, `Keep ur name under ${MAX_NAME_LENGTH} characters`);
  return name;
}

function requireTeamName(body) {
  const name = cleanText(body.team);
  if (!name) throw new HttpError(400, 'Team name is required');
  if (name.length > MAX_TEAM_NAME_LENGTH) throw new HttpError(400, `Keep the team name under ${MAX_TEAM_NAME_LENGTH} characters`);
  return name;
}

// Returns null when left blank, since email is optional.
function cleanEmail(raw) {
  const email = cleanText(raw).toLowerCase();
  if (!email) return null;
  if (email.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "That email doesn't look right");
  }
  return email;
}

function isRealDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function requireSchedule(body) {
  const { schedule } = body;
  if (!Array.isArray(schedule) || schedule.length === 0) throw new HttpError(400, 'Add at least 1 game');
  if (schedule.length > MAX_GAMES) throw new HttpError(400, `Max ${MAX_GAMES} games`);

  const seen = new Set();
  return schedule
    .map((item) => {
      const date = item?.date;
      if (!isRealDate(date)) throw new HttpError(400, 'One of the dates looks wrong');
      if (seen.has(date)) throw new HttpError(400, `${date} is on the schedule twice`);
      seen.add(date);

      const type = item.type === 'bye' ? 'bye' : 'game';
      const time = cleanText(item.time);
      if (time.length > MAX_TIME_LENGTH) throw new HttpError(400, `Keep times under ${MAX_TIME_LENGTH} characters`);
      return {
        date,
        type,
        time: type === 'game' && time ? time : null,
        doubleheader: type === 'game' && item.doubleheader === true,
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function saveSchedule(teamId, schedule) {
  sql.clearGames.run(teamId);
  for (const { date, type, time, doubleheader } of schedule) {
    sql.addGame.run(teamId, date, type, time, doubleheader ? 1 : 0);
  }
}

function getState(team) {
  const outByPlayer = new Map();
  for (const { player_id, game_date } of sql.absences.all(team.id)) {
    if (!outByPlayer.has(player_id)) outByPlayer.set(player_id, []);
    outByPlayer.get(player_id).push(game_date);
  }
  return {
    team: team.name,
    schedule: sql.games.all(team.id).map((game) => ({ ...game, doubleheader: Boolean(game.doubleheader) })),
    players: sql.players.all(team.id).map(({ id, name }) => ({ name, out: outByPlayer.get(id) ?? [] })),
    hits: team.hits,
  };
}

async function readJson(req) {
  req.setEncoding('utf8');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY_BYTES) throw new HttpError(413, 'Too much data');
  }
  try {
    return JSON.parse(body) ?? {};
  } catch {
    throw new HttpError(400, 'Bad JSON');
  }
}

// Everything here runs against one team, picked by the GUID in the URL.
const teamApi = {
  'GET /state'(team, req, url) {
    if (url.searchParams.has('hit')) {
      sql.addHit.run(team.id);
      team.hits += 1;
    }
    return getState(team);
  },

  // Joining with a name that already exists just signs you in as that player,
  // which is how the same person gets onto a second device.
  async 'POST /join'(team, req) {
    const name = requireName(await readJson(req));
    sql.addPlayer.run(team.id, name, nameKey(name));
    return { name: sql.findPlayer.get(team.id, nameKey(name)).name, state: getState(team) };
  },

  async 'PUT /absence'(team, req) {
    const body = await readJson(req);
    const player = sql.findPlayer.get(team.id, nameKey(requireName(body)));
    if (!player) throw new HttpError(404, 'Player not found');
    if (!sql.game.get(team.id, body.date)) throw new HttpError(400, 'No game on that date');
    (body.out ? sql.markOut : sql.markIn).run(player.id, body.date);
    return getState(team);
  },

  async 'DELETE /player'(team, req) {
    sql.removePlayer.run(team.id, nameKey(requireName(await readJson(req))));
    return getState(team);
  },

  async 'PUT /details'(team, req) {
    const body = await readJson(req);
    const name = requireTeamName(body);
    const schedule = requireSchedule(body);
    transaction(() => {
      sql.renameTeam.run(name, team.id);
      saveSchedule(team.id, schedule);
    });
    return getState({ ...team, name });
  },
};

async function createTeam(req) {
  const body = await readJson(req);
  const name = requireTeamName(body);
  const schedule = requireSchedule(body);
  const email = cleanEmail(body.email);
  const id = randomUUID();
  transaction(() => {
    sql.addTeam.run(id, name, email);
    saveSchedule(id, schedule);
  });
  return { id };
}

async function sendEmail({ to, subject, text }) {
  if (!RESEND_API_KEY) {
    if (RAILWAY_PUBLIC_DOMAIN) throw new Error('RESEND_API_KEY is not set');
    console.log(`Email not configured. Would send to ${to}:\n${text}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: EMAIL_FROM, to, subject, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Resend returned ${res.status}: ${await res.text()}`);
}

// Stops anyone from flooding an inbox by submitting the same address repeatedly.
const lastRecoveryEmail = new Map();

// The reply is the same whether or not the email matched, so this can't be used
// to check whether someone has a team here.
async function recoverTeams(req) {
  const email = cleanEmail((await readJson(req)).email);
  if (!email) throw new HttpError(400, 'Type in ur email');

  const teams = sql.teamsByEmail.all(email);
  const coolingDown = Date.now() - (lastRecoveryEmail.get(email) ?? 0) < RECOVERY_COOLDOWN_MS;
  if (teams.length && !coolingDown) {
    lastRecoveryEmail.set(email, Date.now());
    const links = teams.map(({ id, name }) => `${name}\n${SITE_URL}/t/${id}`).join('\n\n');
    try {
      await sendEmail({
        to: email,
        subject: "Ur WHO'S IN? team link",
        text: `Here's what u asked for:\n\n${links}\n\nDidn't ask for this? U can ignore it.`,
      });
    } catch (err) {
      lastRecoveryEmail.delete(email);
      console.error(err);
      throw new HttpError(502, "Couldn't send the email. Try again later.");
    }
  }
  return { ok: true };
}

const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/shared.js': ['shared.js', 'text/javascript; charset=utf-8'],
  '/home.js': ['home.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
};

const readPage = (file) => readFile(join(import.meta.dirname, 'public', file));

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer' });
  res.end(body);
}

const sendJson = (res, data) => send(res, 200, JSON.stringify(data));

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;

    if (req.method === 'POST' && pathname === '/api/teams') return sendJson(res, await createTeam(req));
    if (req.method === 'POST' && pathname === '/api/recover') return sendJson(res, await recoverTeams(req));

    const apiMatch = pathname.match(/^\/api\/teams\/([^/]+)(\/[a-z]+)$/);
    if (apiMatch) {
      const handler = teamApi[`${req.method} ${apiMatch[2]}`];
      const team = sql.team.get(apiMatch[1]);
      if (handler && !team) throw new HttpError(404, 'Team not found');
      if (handler) return sendJson(res, await handler(team, req, url));
    }

    if (req.method === 'GET') {
      const pageMatch = pathname.match(/^\/t\/([^/]+)$/);
      if (pageMatch) {
        const found = sql.team.get(pageMatch[1]);
        return send(res, found ? 200 : 404, await readPage(found ? 'team.html' : 'not-found.html'), assets['/'][1]);
      }
      const asset = assets[pathname];
      if (asset) return send(res, 200, await readPage(asset[0]), asset[1]);
    }

    send(res, 404, JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    send(res, err.status ?? 500, JSON.stringify({ error: err.status ? err.message : 'Server error' }));
  }
});

server.listen(PORT, () => console.log(`Who's In? running on port ${PORT}, database at ${DB_PATH}`));
