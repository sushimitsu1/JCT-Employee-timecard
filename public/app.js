const signinView = document.querySelector('#signin-view');
const employeeView = document.querySelector('#employee-view');
const ownerView = document.querySelector('#owner-view');
const signOutButton = document.querySelector('#sign-out');
const rolePill = document.querySelector('#role-pill');
const pinDots = document.querySelector('#pin-dots');
const signInButton = document.querySelector('#sign-in');
const signinMsg = document.querySelector('#signin-msg');

let pin = '';
let owner = { userId: null, weekStart: null, days: [] };
let editing = null;
let pollTimer = null;
let viewGeneration = 0;

function show(name) {
  signinView.hidden = name !== 'signin';
  employeeView.hidden = name !== 'employee';
  ownerView.hidden = name !== 'owner';
  signOutButton.hidden = name === 'signin';
  rolePill.hidden = name !== 'owner';
  if (name !== 'employee' && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: {
      'x-jct-request': '1',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const type = response.headers.get('content-type') || '';
  const payload = type.includes('json') ? await response.json() : await response.text();
  return { ok: response.ok, status: response.status, payload, response };
}

function renderDots() {
  pinDots.replaceChildren();
  pinDots.setAttribute('aria-label', `PIN entry, ${pin.length} of 6 digits entered`);
  for (let i = 0; i < 6; i += 1) {
    const dot = document.createElement('div');
    dot.className = `pin-dot ${i < pin.length ? 'filled' : 'empty'}`;
    pinDots.append(dot);
  }
  signInButton.disabled = pin.length < 4;
}

function pushDigit(digit) {
  if (pin.length >= 6) return;
  pin += digit;
  signinMsg.textContent = '';
  renderDots();
}

function badge(status) {
  if (status === 'In progress') return 'badge badge-ok';
  if (status === 'OK') return 'badge badge-ok';
  return 'badge badge-miss';
}

function renderEmployee(data) {
  show('employee');
  document.querySelector('#greet').textContent = `Hi, ${data.user.displayName}`;
  document.querySelector('#today-label').textContent = data.todayLabel;
  const card = document.querySelector('#status-card');
  card.className = `status-card is-${data.status.state === 'lunch' ? 'lunch' : data.status.state === 'in' ? 'in' : 'out'}`;
  document.querySelector('#status-val').textContent = data.status.label;
  document.querySelector('#status-since').textContent = data.status.sinceLabel;
  document.querySelector('#emp-week-range').textContent = data.week.label;
  document.querySelector('#emp-week-hours').textContent = data.week.hoursLabel;
  const list = document.querySelector('#today-punches');
  list.replaceChildren();
  if (!data.todayPunches.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No punches yet today';
    list.append(empty);
  } else {
    for (const punch of data.todayPunches) {
      const row = document.createElement('div');
      row.className = 'punch-row';
      const type = document.createElement('div');
      type.className = 'punch-type';
      const pill = document.createElement('span');
      pill.className = `badge badge-${punch.badgeClass}`;
      pill.textContent = punch.badge;
      type.append(pill, document.createTextNode(punch.label));
      const time = document.createElement('div');
      time.className = 'punch-time';
      time.textContent = punch.timeLabel;
      row.append(type, time);
      list.append(row);
    }
  }
  const primary = document.querySelector('#primary-action');
  primary.textContent = data.status.primary.label;
  primary.dataset.action = data.status.primary.action;
  primary.className = `btn-primary-giant is-${data.status.primary.tone}`;
  primary.disabled = !!data.status.primary.disabled;
  const lunch = document.querySelector('#lunch-action');
  lunch.textContent = data.status.secondary.label;
  lunch.dataset.action = data.status.secondary.action;
  lunch.disabled = !!data.status.secondary.disabled;
  document.querySelector('#action-error').textContent = '';
}

function addDays(ymd, count) {
  const [year, month, day] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + count));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function renderOwner(data) {
  show('owner');
  owner.userId = data.employee.id;
  owner.weekStart = data.start;
  owner.days = data.days;
  document.querySelector('#owner-title').textContent = `${data.employee.displayName} — weekly hours`;
  document.querySelector('#week-label').textContent = data.label;
  document.querySelector('#pay-label').textContent = data.payLabel;
  document.querySelector('#regular-hours').textContent = data.totals.regularHours;
  document.querySelector('#ot-hours').textContent = data.totals.otHours;
  document.querySelector('#total-hours').textContent = data.totals.totalHours;
  document.querySelector('#rate-input').value = data.totals.rateDollars;
  const note = data.totals.rateNote
    ? data.totals.rateNote
    : 'Saving applies this rate from Monday of this week until the next saved rate.';
  document.querySelector('#rate-note').textContent = note;
  document.querySelector('#pay-footer').textContent =
    `Gross pay ${data.totals.grossPay} · regular ${data.totals.regularPay} · overtime ${data.totals.otPay}. ${data.payLabel}. Lunch is unpaid. Partial minutes are not paid.`;
  document.querySelector('#owner-error').textContent = '';

  const rows = document.querySelector('#day-rows');
  rows.replaceChildren();
  for (const day of data.days) {
    const tr = document.createElement('tr');
    const cells = [day.label, day.in, day.lunchOut, day.lunchIn, day.out, day.hours];
    cells.forEach((value, index) => {
      const td = document.createElement('td');
      if (index === 0) {
        const strong = document.createElement('strong');
        strong.textContent = value;
        td.append(strong);
        if (day.overnight) {
          const extra = document.createElement('span');
          extra.className = 'overnight';
          extra.textContent = 'Includes overnight time';
          td.append(extra);
        }
      } else td.textContent = value;
      tr.append(td);
    });
    const status = document.createElement('td');
    const pill = document.createElement('span');
    pill.className = badge(day.status);
    pill.textContent = day.status;
    status.append(pill);
    tr.append(status);
    const action = document.createElement('td');
    const button = document.createElement('button');
    button.className = 'btn-edit';
    button.type = 'button';
    button.textContent = 'Edit';
    button.addEventListener('click', () => openEdit(day));
    action.append(button);
    tr.append(action);
    rows.append(tr);
  }

  const cards = document.querySelector('#day-cards');
  cards.replaceChildren();
  for (const day of data.days) {
    const card = document.createElement('div');
    card.className = 'day-card';
    const top = document.createElement('div');
    top.className = 'day-top';
    const name = document.createElement('div');
    name.className = 'day-name';
    name.textContent = day.label;
    const hours = document.createElement('div');
    hours.className = 'day-hours';
    hours.textContent = day.hoursWithUnit;
    top.append(name, hours);
    const grid = document.createElement('div');
    grid.className = 'day-grid';
    for (const [label, value] of [['In', day.in], ['Out', day.out], ['Lunch out', day.lunchOut], ['Lunch in', day.lunchIn]]) {
      const cell = document.createElement('div');
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = label;
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = value;
      cell.append(lbl, val);
      grid.append(cell);
    }
    const actions = document.createElement('div');
    actions.className = 'day-actions';
    const pill = document.createElement('span');
    pill.className = badge(day.status);
    pill.textContent = day.status;
    const button = document.createElement('button');
    button.className = 'btn-edit-lg';
    button.type = 'button';
    button.textContent = 'Edit';
    button.addEventListener('click', () => openEdit(day));
    actions.append(pill, button);
    card.append(top, grid, actions);
    cards.append(card);
  }
}

async function loadOwner(weekStart) {
  const query = new URLSearchParams({ userId: String(owner.userId || '') });
  if (weekStart) query.set('weekStart', weekStart);
  const result = await api(`/api/owner/week?${query}`);
  if (result.status === 401) return show('signin');
  if (!result.ok) {
    document.querySelector('#owner-error').textContent = result.payload.message || 'Could not load the week.';
    return;
  }
  renderOwner(result.payload);
}

async function enterApp(user) {
  if (user.role === 'owner') {
    const list = await api('/api/owner/employees');
    if (!list.ok || !list.payload.employees.length) {
      show('owner');
      document.querySelector('#owner-error').textContent = 'No sample employee is on this timecard.';
      return;
    }
    owner.userId = list.payload.employees[0].id;
    owner.weekStart = null;
    await loadOwner();
    return;
  }
  const me = await api('/api/me');
  if (!me.ok) return show('signin');
  renderEmployee(me.payload);
  if (!pollTimer) pollTimer = setInterval(() => refreshEmployee(), 30000);
}

async function refreshEmployee() {
  if (employeeView.hidden) return;
  const me = await api('/api/me');
  if (me.status === 401) show('signin');
  else if (me.ok) renderEmployee(me.payload);
}

async function submitPin() {
  if (pin.length < 4) return;
  const generation = ++viewGeneration;
  signInButton.disabled = true;
  const entered = pin;
  const result = await api('/api/auth/pin', { method: 'POST', body: { pin: entered } });
  if (generation !== viewGeneration) return;
  pin = '';
  renderDots();
  if (!result.ok) {
    signinMsg.textContent = result.payload.message || 'Wrong PIN.';
    signinMsg.className = 'form-msg error';
    return;
  }
  signinMsg.textContent = '';
  await enterApp(result.payload.user);
}

function punchRow(punch) {
  const row = document.createElement('div');
  row.className = 'punch-edit';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Punch type');
  for (const [value, label] of [
    ['clock_in', 'Clock in'],
    ['lunch_out', 'Lunch out'],
    ['lunch_in', 'Lunch in'],
    ['clock_out', 'Clock out'],
  ]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    if (punch.kind === value) option.selected = true;
    select.append(option);
  }
  const time = document.createElement('input');
  time.type = 'time';
  time.step = '60';
  time.value = punch.time || '08:00';
  time.setAttribute('aria-label', 'Punch time');
  const remove = document.createElement('button');
  remove.className = 'btn-delete';
  remove.type = 'button';
  remove.textContent = 'Delete';
  remove.addEventListener('click', () => row.remove());
  row.dataset.id = punch.id == null ? '' : String(punch.id);
  row.append(select, time, remove);
  return row;
}

function openEdit(day) {
  editing = day;
  document.querySelector('#edit-title').textContent = `Edit ${day.label}`;
  document.querySelector('#edit-error').textContent = '';
  const rows = document.querySelector('#edit-rows');
  rows.replaceChildren();
  const punches = day.punches.length ? day.punches : [];
  for (const punch of punches) rows.append(punchRow(punch));
  document.querySelector('#edit-modal').classList.add('open');
}

document.querySelector('#keypad').addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || !button.dataset.digit) return;
  pushDigit(button.dataset.digit);
});
document.querySelector('#pin-clear').addEventListener('click', () => {
  pin = '';
  renderDots();
});
document.querySelector('#pin-back').addEventListener('click', () => {
  pin = pin.slice(0, -1);
  renderDots();
});
signInButton.addEventListener('click', submitPin);
document.addEventListener('keydown', (event) => {
  if (signinView.hidden) return;
  if (/^\d$/.test(event.key)) pushDigit(event.key);
  else if (event.key === 'Backspace') {
    pin = pin.slice(0, -1);
    renderDots();
  } else if (event.key === 'Enter') submitPin();
});

signOutButton.addEventListener('click', async () => {
  const generation = ++viewGeneration;
  await api('/api/auth/logout', { method: 'POST', body: {} });
  if (generation !== viewGeneration) return;
  pin = '';
  renderDots();
  signinMsg.textContent = '';
  show('signin');
});

document.querySelector('#primary-action').addEventListener('click', () => sendPunch('primary-action'));
document.querySelector('#lunch-action').addEventListener('click', () => sendPunch('lunch-action'));

async function sendPunch(id) {
  const button = document.querySelector(`#${id}`);
  if (button.disabled) return;
  button.disabled = true;
  const result = await api('/api/punch', { method: 'POST', body: { action: button.dataset.action } });
  if (result.status === 401) return show('signin');
  if (!result.ok) {
    document.querySelector('#action-error').textContent = result.payload.message || 'Punch was not saved.';
    button.disabled = false;
    return;
  }
  renderEmployee(result.payload);
}

document.querySelector('#week-prev').addEventListener('click', () => {
  if (owner.weekStart) loadOwner(addDays(owner.weekStart, -7));
});
document.querySelector('#week-next').addEventListener('click', () => {
  if (owner.weekStart) loadOwner(addDays(owner.weekStart, 7));
});
document.querySelector('#save-rate').addEventListener('click', async () => {
  const result = await api('/api/owner/rate', {
    method: 'PUT',
    body: { userId: owner.userId, dollars: document.querySelector('#rate-input').value, effectiveOn: owner.weekStart },
  });
  if (!result.ok) {
    document.querySelector('#owner-error').textContent = result.payload.message || 'Rate was not saved.';
    return;
  }
  await loadOwner(owner.weekStart);
  document.querySelector('#owner-error').textContent = 'Rate saved.';
  document.querySelector('#owner-error').className = 'form-msg';
});
document.querySelector('#export-week').addEventListener('click', async () => {
  const result = await api(`/api/owner/export?userId=${owner.userId}&weekStart=${owner.weekStart}`);
  if (!result.ok) {
    document.querySelector('#owner-error').textContent = 'Export failed.';
    return;
  }
  const blob = new Blob([result.payload], { type: 'text/csv' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `timecard-${owner.weekStart}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
});
document.querySelector('#add-punch').addEventListener('click', () => {
  document.querySelector('#edit-rows').append(punchRow({ kind: 'clock_in', time: '08:00' }));
});
document.querySelector('#edit-cancel').addEventListener('click', () => {
  document.querySelector('#edit-modal').classList.remove('open');
});
document.querySelector('#edit-save').addEventListener('click', async () => {
  const punches = [...document.querySelectorAll('#edit-rows .punch-edit')].map((row) => ({
    id: row.dataset.id ? Number(row.dataset.id) : null,
    kind: row.querySelector('select').value,
    time: row.querySelector('input').value,
  }));
  const result = await api('/api/owner/day', {
    method: 'PUT',
    body: { userId: owner.userId, date: editing.date, punches },
  });
  if (!result.ok) {
    document.querySelector('#edit-error').textContent = result.payload.message || 'Could not save punches.';
    return;
  }
  await loadOwner(owner.weekStart);
  document.querySelector('#edit-modal').classList.remove('open');
  if (result.payload.warnings?.length) {
    document.querySelector('#owner-error').textContent = result.payload.warnings.join(' ');
  }
});

renderDots();
api('/api/me').then((result) => {
  if (result.ok) enterApp(result.payload.user);
  else show('signin');
});
