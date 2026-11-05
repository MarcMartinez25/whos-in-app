// Helpers used by both the home page and the team pages.

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Something broke');
    err.status = res.status;
    throw err;
  }
  return data;
}

// localStorage can throw in private windows, and nothing here depends on it.
function readStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStored(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

function isoDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function nextWeek(iso) {
  const date = parseDate(iso);
  date.setDate(date.getDate() + 7);
  return isoDate(date);
}

// Used to create a team and to edit one, so both stay in step.
function createScheduleEditor(container, schedule) {
  const rows = el('div', 'editor-rows');
  const add = el('button', 'btn', '+ ADD A WEEK');
  add.type = 'button';
  container.replaceChildren(rows, add);

  function addRow({ date = '', type = 'game', time = '', doubleheader = false } = {}) {
    const row = el('div', 'editor-row');

    const dateInput = el('input', 'field editor-date');
    dateInput.type = 'date';
    dateInput.value = date;
    dateInput.setAttribute('aria-label', 'Date');

    const kind = el('select', 'field editor-kind');
    kind.setAttribute('aria-label', 'Type');
    for (const [value, label] of [['game', 'Game'], ['doubleheader', 'Double header'], ['bye', 'Bye week']]) {
      const option = el('option', '', label);
      option.value = value;
      kind.append(option);
    }
    kind.value = type === 'bye' ? 'bye' : doubleheader ? 'doubleheader' : 'game';

    const timeInput = el('input', 'field editor-time');
    timeInput.type = 'text';
    timeInput.maxLength = 30;
    timeInput.placeholder = 'Time (optional)';
    timeInput.value = time ?? '';
    timeInput.setAttribute('aria-label', 'Time');

    const syncTime = () => { timeInput.disabled = kind.value === 'bye'; };
    kind.addEventListener('change', syncTime);
    syncTime();

    const remove = el('button', 'btn editor-remove', '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', 'Remove this week');
    remove.addEventListener('click', () => row.remove());

    row.append(dateInput, kind, timeInput, remove);
    rows.append(row);
  }

  add.addEventListener('click', () => {
    const dates = [...rows.querySelectorAll('.editor-date')].map((input) => input.value).filter(Boolean);
    addRow({ date: dates.length ? nextWeek(dates.sort().at(-1)) : '' });
  });

  if (schedule.length) schedule.forEach(addRow);
  else addRow();

  return {
    getSchedule() {
      return [...rows.querySelectorAll('.editor-row')]
        .map((row) => {
          const kind = row.querySelector('.editor-kind').value;
          return {
            date: row.querySelector('.editor-date').value,
            type: kind === 'bye' ? 'bye' : 'game',
            doubleheader: kind === 'doubleheader',
            time: row.querySelector('.editor-time').value,
          };
        })
        .filter((game) => game.date);
    },
  };
}
