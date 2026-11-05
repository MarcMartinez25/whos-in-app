const REFRESH_MS = 30_000;

const teamId = location.pathname.split('/').pop();
const teamApiPath = `/api/teams/${teamId}`;
const nameKey = `whos-in-name:${teamId}`;

// Falls back to remembering the name only until the tab closes.
let me = readStored(nameKey);

function rememberName(name) {
  me = name;
  writeStored(nameKey, name);
}

let state = null;
let editor = null;
const pending = new Set(); // game dates with a save in flight
let refreshId = 0;
let statusTimer;

function say(message, { sticky = false } = {}) {
  clearTimeout(statusTimer);
  $('status').textContent = message;
  if (!sticky) statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2500);
}

// ---- Rendering ----

function dateCell(iso) {
  const date = parseDate(iso);
  const cell = el('div', 'game-date');
  cell.append(
    el('small', '', date.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase()),
    el('b', '', date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()),
  );
  return cell;
}

function renderGames() {
  const today = isoDate(new Date());
  const nextGame = state.schedule.find((s) => s.type === 'game' && s.date >= today)?.date;
  const myEntry = state.players.find((p) => p.name === me);

  const rows = state.schedule.map(({ date, type, doubleheader, time }) => {
    const row = el('li', 'game');

    if (type === 'bye') {
      row.classList.add('is-bye');
      row.append(dateCell(date), el('div', 'bye-label', 'BYE WEEK. NO GAME.'));
      return row;
    }

    const cell = dateCell(date);
    cell.append(el('span', 'game-time', time || 'TIME TBD'));
    if (doubleheader) cell.append(el('span', 'dh-tag', 'DOUBLE HEADER'));
    if (date === nextGame) cell.append(el('span', 'next-tag', 'NEXT UP'));
    row.append(cell);

    const out = state.players.filter((p) => p.out.includes(date)).map((p) => p.name);
    const inCount = state.players.length - out.length;

    if (date < today) {
      row.classList.add('is-past');
      row.append(el('div', 'past-label', 'ALREADY PLAYED'));
    } else {
      const isOut = myEntry?.out.includes(date) ?? false;
      const toggle = el('button', `toggle ${isOut ? 'is-out' : 'is-in'}`, isOut ? "✘ CAN'T MAKE IT" : "✔ I'M IN");
      toggle.type = 'button';
      toggle.dataset.date = date;
      toggle.setAttribute('aria-pressed', String(isOut));
      row.append(toggle);
    }

    const who = el('p', 'game-who');
    who.append(el('span', 'count-in', `${inCount} in`), ' / ', el('span', 'count-out', `${out.length} out`));
    if (out.length) who.append(`: ${out.join(', ')}`);
    row.append(who);
    return row;
  });

  // Keep keyboard focus on the same game after the list is rebuilt.
  const focusedDate = document.activeElement?.dataset?.date;
  $('games').replaceChildren(...rows);
  if (focusedDate) $('games').querySelector(`[data-date="${focusedDate}"]`)?.focus();
}

function renderSquad() {
  const today = isoDate(new Date());
  const gameDates = state.schedule.filter((s) => s.type === 'game' && s.date >= today).map((s) => s.date);
  const items = state.players.map((player) => {
    const missing = player.out.filter((d) => gameDates.includes(d)).length;
    const item = el('li', '', `${player.name} `);
    item.append(missing
      ? el('span', 'missing', `(missing ${missing})`)
      : el('span', 'perfect', '(all in)'));
    return item;
  });
  $('squad').replaceChildren(...items);
}

function renderSignin() {
  const names = state?.players.map((p) => p.name) ?? [];
  $('existing').hidden = names.length === 0;
  $('existing-names').replaceChildren(...names.map((name) => {
    const button = el('button', 'btn', name);
    button.type = 'button';
    button.addEventListener('click', () => join(name));
    return button;
  }));
}

function render() {
  if (state) {
    $('team-name').textContent = state.team;
    $('hits').textContent = String(state.hits).padStart(6, '0');
    document.title = `${state.team} - WHO'S IN?`;
  }

  const signedIn = Boolean(me && state?.players.some((p) => p.name === me));
  $('signin').hidden = signedIn || !state;
  $('app').hidden = !signedIn;

  if (signedIn) {
    $('me').textContent = me;
    renderGames();
    renderSquad();
  } else {
    renderSignin();
  }
}

// ---- Actions ----

async function refresh({ countHit = false } = {}) {
  const id = ++refreshId;
  try {
    const next = await api('GET', `${teamApiPath}/state${countHit ? '?hit=1' : ''}`);
    // A save in flight (or a newer refresh) has fresher data than this response.
    if (id !== refreshId || pending.size) return;
    state = next;
    if (me && !state.players.some((p) => p.name === me)) rememberName(null);
    render();
    if ($('status').textContent.startsWith("Can't reach")) say('Back online!');
  } catch {
    if (id === refreshId) say("Can't reach the server. Trying again soon...", { sticky: true });
  }
}

async function join(rawName) {
  try {
    const { name, state: next } = await api('POST', `${teamApiPath}/join`, { name: rawName });
    refreshId++;
    state = next;
    rememberName(name);
    $('name-input').value = '';
    render();
    window.scrollTo(0, 0);
  } catch (err) {
    say(err.status ? err.message : "Can't reach the server. Try again in a sec.");
  }
}

async function toggle(date) {
  if (pending.has(date)) return;
  const player = state.players.find((p) => p.name === me);
  const wasOut = player.out.includes(date);

  // Flip it right away so taps feel instant, then undo it if the save fails.
  player.out = wasOut ? player.out.filter((d) => d !== date) : [...player.out, date];
  pending.add(date);
  render();

  try {
    const next = await api('PUT', `${teamApiPath}/absence`, { name: me, date, out: !wasOut });
    pending.delete(date);
    if (!pending.size) {
      refreshId++;
      state = next;
      render();
    }
    say('Saved!');
  } catch (err) {
    pending.delete(date);
    if (err.status === 404) {
      rememberName(null);
      say('That name got removed. Sign in again.');
      refresh();
      return;
    }
    const current = state.players.find((p) => p.name === me);
    if (current) {
      current.out = wasOut ? [...current.out, date] : current.out.filter((d) => d !== date);
    }
    refresh();
    render();
    say(err.status === 400 ? 'That game changed. Check the schedule.' : "Didn't save. Check ur connection and try again.");
  }
}

// An on-page prompt, because confirm() silently returns false in some in-app
// browsers, which would make this button look dead.
function showRemoveConfirm(show) {
  $('remove-name').textContent = me;
  $('remove-confirm').hidden = !show;
  $('remove-me').hidden = show;
}

async function removeMe() {
  try {
    const next = await api('DELETE', `${teamApiPath}/player`, { name: me });
    refreshId++;
    state = next;
    rememberName(null);
    showRemoveConfirm(false);
    render();
  } catch {
    say("Didn't work. Try again in a sec.");
  }
}

function showEditor(show) {
  $('edit-window').hidden = !show;
  $('edit-open').hidden = show;
  if (!show) return;
  $('team-input').value = state.team;
  editor = createScheduleEditor($('schedule-editor'), state.schedule);
  $('edit-window').scrollIntoView();
}

async function saveDetails(event) {
  event.preventDefault();
  try {
    const next = await api('PUT', `${teamApiPath}/details`, {
      team: $('team-input').value,
      schedule: editor.getSchedule(),
    });
    refreshId++;
    state = next;
    showEditor(false);
    render();
    say('Saved!');
  } catch (err) {
    say(err.status ? err.message : "Didn't save. Check ur connection and try again.");
  }
}

// execCommand goes first because the clipboard API is blocked in some in-app
// browsers, and it has to run right away while it still counts as a tap.
async function copyInvite() {
  const input = $('invite-url');
  input.select();
  let copied = document.execCommand('copy');
  if (!copied) {
    copied = await navigator.clipboard?.writeText(input.value).then(() => true, () => false);
  }
  say(copied ? 'Link copied! Go send it.' : 'Hold down on the link 2 copy it.');
}

// ---- Wiring ----

$('invite-url').value = location.origin + location.pathname;
$('copy-link').addEventListener('click', copyInvite);

$('signin-form').addEventListener('submit', (event) => {
  event.preventDefault();
  join($('name-input').value);
});

$('games').addEventListener('click', (event) => {
  const button = event.target.closest('.toggle');
  if (button) toggle(button.dataset.date);
});

$('switch-user').addEventListener('click', () => {
  showRemoveConfirm(false);
  showEditor(false);
  rememberName(null);
  render();
});

$('remove-me').addEventListener('click', () => showRemoveConfirm(true));
$('remove-no').addEventListener('click', () => showRemoveConfirm(false));
$('remove-yes').addEventListener('click', removeMe);

$('edit-open').addEventListener('click', () => showEditor(true));
$('edit-cancel').addEventListener('click', () => showEditor(false));
$('edit-form').addEventListener('submit', saveDetails);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});

setInterval(() => {
  if (!document.hidden) refresh();
}, REFRESH_MS);

refresh({ countHit: true });
