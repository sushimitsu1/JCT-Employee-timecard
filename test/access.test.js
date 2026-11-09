import assert from 'node:assert/strict';
import test from 'node:test';
import { pacificLocalToUtc } from '../src/time.js';
import { csvObjects, makeApp } from './helpers.js';

function at(year, month, day, hour, minute) {
  return pacificLocalToUtc(year, month, day, hour, minute).ms;
}

async function signIn(app, pin, ip) {
  return app.call('POST', '/api/auth/pin', { body: { pin }, ip });
}

test('session cookie is HttpOnly, Secure, and SameSite=Strict', async () => {
  const app = await makeApp();
  await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  const response = await signIn(app, '1111', '203.0.113.10');
  assert.equal(response.status, 200);
  const session = response.setCookie.find((cookie) => cookie.startsWith('tc_session='));
  const device = response.setCookie.find((cookie) => cookie.startsWith('tc_device='));
  assert.match(session, /HttpOnly/);
  assert.match(session, /Secure/);
  assert.match(session, /SameSite=Strict/);
  assert.match(device, /HttpOnly/);
  assert.match(device, /Secure/);
  assert.match(device, /SameSite=Strict/);
  const token = session.split(';')[0].slice('tc_session='.length);
  const stored = await app.db.first('SELECT token_hash FROM sessions');
  assert.notEqual(stored.token_hash, token);
  const me = await app.call('GET', '/api/me');
  assert.equal(me.status, 200);
  assert.equal(JSON.stringify(me.json).includes('1111'), false);
  assert.equal(JSON.stringify(me.json).includes('pin_hash'), false);
});

test('five wrong PINs lock the IP for 15 minutes', async () => {
  const app = await makeApp();
  await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  const start = app.now();
  for (let i = 0; i < 4; i += 1) {
    const wrong = await signIn(app, '9999', '203.0.113.40');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.message, 'Wrong PIN.');
  }
  const fifth = await signIn(app, '9999', '203.0.113.40');
  assert.equal(fifth.status, 429);
  const locked = await signIn(app, '1111', '203.0.113.40');
  assert.equal(locked.status, 429);
  assert.match(locked.json.message, /15 minutes/);
  app.setNow(start + 15 * 60 * 1000 - 1);
  assert.equal((await signIn(app, '1111', '203.0.113.40')).status, 429);
  app.setNow(start + 15 * 60 * 1000);
  assert.equal((await signIn(app, '1111', '203.0.113.40')).status, 200);
  const otherIp = await makeApp();
  await otherIp.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  for (let i = 0; i < 5; i += 1) await signIn(otherIp, '9999', '203.0.113.41');
  assert.equal((await signIn(otherIp, '1111', '203.0.113.41')).status, 429);
  assert.equal((await signIn(otherIp, '1111', '203.0.113.42')).status, 200);
});

test('a success clears the failure count', async () => {
  const app = await makeApp();
  await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  for (let i = 0; i < 4; i += 1) assert.equal((await signIn(app, '9999', '203.0.113.50')).status, 401);
  assert.equal((await signIn(app, '1111', '203.0.113.50')).status, 200);
  await app.call('POST', '/api/auth/logout');
  for (let i = 0; i < 4; i += 1) assert.equal((await signIn(app, '9999', '203.0.113.50')).status, 401);
  assert.equal((await signIn(app, '1111', '203.0.113.50')).status, 200);
});

test('five wrong PINs on a known device lock that user on a new IP', async () => {
  const app = await makeApp();
  await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  await app.user({ displayName: 'Sample Owner', role: 'owner', pin: '2222' });
  assert.equal((await signIn(app, '1111', '203.0.113.10')).status, 200);
  await app.call('POST', '/api/auth/logout', { ip: '203.0.113.10' });
  for (let i = 0; i < 5; i += 1) await signIn(app, '9999', '203.0.113.10');
  const stillLocked = await signIn(app, '1111', '203.0.113.20');
  assert.equal(stillLocked.status, 429);
  app.clearJar();
  const owner = await signIn(app, '2222', '203.0.113.30');
  assert.equal(owner.status, 200);
  assert.equal(owner.json.user.role, 'owner');
});

test('requests without the app header or a session are rejected', async () => {
  const app = await makeApp();
  await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  assert.equal((await app.call('POST', '/api/auth/pin', { body: { pin: '1111' }, header: false })).status, 400);
  assert.equal((await app.call('GET', '/api/me')).status, 401);
});

test('an employee is blocked from every owner endpoint', async () => {
  const app = await makeApp();
  const employeeId = await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  await app.user({ displayName: 'Sample Owner', role: 'owner', pin: '2222' });
  await signIn(app, '1111', '203.0.113.60');
  const paths = [
    ['GET', `/api/owner/employees`],
    ['GET', `/api/owner/week?userId=${employeeId}&weekStart=2026-11-09`],
    ['PUT', '/api/owner/rate'],
    ['PUT', '/api/owner/day'],
    ['GET', `/api/owner/export?userId=${employeeId}&weekStart=2026-11-09`],
  ];
  for (const [method, path] of paths) {
    const response = await app.call(method, path, { body: method === 'GET' ? undefined : { userId: employeeId } });
    assert.equal(response.status, 403, path);
    assert.equal(response.json.error, 'forbidden');
  }
  const before = await app.db.first('SELECT COUNT(*) AS n FROM punches');
  assert.equal(Number(before.n), 0);
});

test('employee punches only themselves, at the server time', async () => {
  const app = await makeApp();
  await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  await signIn(app, '1111', '203.0.113.70');
  app.setNow(at(2026, 11, 9, 8, 0));
  const tooSoon = await app.call('POST', '/api/punch', { body: { action: 'clock_out' } });
  assert.equal(tooSoon.status, 400);
  assert.match(tooSoon.json.message, /Can't clock out/);
  const lunch = await app.call('POST', '/api/punch', { body: { action: 'lunch_out' } });
  assert.equal(lunch.status, 400);
  const clockIn = await app.call('POST', '/api/punch', {
    body: { action: 'clock_in', punchedAt: '2020-01-01T00:00:00.000Z', userId: 2 },
  });
  assert.equal(clockIn.status, 200);
  assert.equal(clockIn.json.status.label, 'Clocked in');
  const stored = await app.db.first('SELECT punched_at, user_id FROM punches');
  assert.equal(stored.punched_at, '2026-11-09T16:00:00.000Z');
  assert.equal(stored.user_id, clockIn.json.user.id);
  app.setNow(at(2026, 11, 9, 8, 1));
  const again = await app.call('POST', '/api/punch', { body: { action: 'clock_in' } });
  assert.equal(again.status, 400);
  assert.match(again.json.message, /Already clocked in/);
  app.setNow(at(2026, 11, 9, 12, 0));
  assert.equal((await app.call('POST', '/api/punch', { body: { action: 'lunch_out' } })).status, 200);
  app.setNow(at(2026, 11, 9, 12, 30));
  const back = await app.call('POST', '/api/punch', { body: { action: 'lunch_in' } });
  assert.equal(back.status, 200);
  assert.equal(back.json.status.label, 'Clocked in');
  assert.equal(back.json.todayPunches.length, 3);
  app.setNow(at(2026, 11, 9, 17, 0));
  const done = await app.call('POST', '/api/punch', { body: { action: 'clock_out' } });
  assert.equal(done.status, 200);
  assert.equal(done.json.status.label, 'Clocked out');
  assert.equal(done.json.week.hoursLabel, '8.5 hrs');
});

test('owner edits write an audit row and employees cannot', async () => {
  const app = await makeApp();
  const employeeId = await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  const ownerId = await app.user({ displayName: 'Sample Owner', role: 'owner', pin: '2222' });
  await signIn(app, '1111', '203.0.113.80');
  app.setNow(at(2026, 11, 9, 8, 0));
  await app.call('POST', '/api/punch', { body: { action: 'clock_in' } });
  app.setNow(at(2026, 11, 9, 16, 0));
  await app.call('POST', '/api/punch', { body: { action: 'clock_out' } });
  await app.call('POST', '/api/auth/logout');
  await signIn(app, '2222', '203.0.113.81');
  assert.equal((await app.call('GET', '/api/owner/employees')).json.employees.length, 1);
  assert.equal((await app.call('PUT', '/api/owner/rate', {
    body: { userId: ownerId, dollars: '30.00', effectiveOn: '2026-11-09' },
  })).status, 404);
  const punches = await app.db.all('SELECT id, kind FROM punches ORDER BY punched_at');
  const edited = await app.call('PUT', '/api/owner/day', {
    body: {
      userId: employeeId,
      date: '2026-11-09',
      punches: [
        { id: punches[0].id, kind: 'clock_in', time: '08:00' },
        { id: punches[1].id, kind: 'clock_out', time: '15:30' },
      ],
    },
  });
  assert.equal(edited.status, 200);
  const audits = await app.db.all('SELECT * FROM audit_log');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'punch.update');
  assert.equal(audits[0].actor_user_id, ownerId);
  assert.notEqual(JSON.parse(audits[0].before_json).punchedAt, JSON.parse(audits[0].after_json).punchedAt);
  const rate = await app.call('PUT', '/api/owner/rate', {
    body: { userId: employeeId, dollars: '22.50', effectiveOn: '2026-11-09' },
  });
  assert.equal(rate.status, 200);
  const rateAudit = await app.db.first(`SELECT * FROM audit_log WHERE action = 'rate.upsert'`);
  assert.equal(JSON.parse(rateAudit.before_json), null);
  assert.equal(JSON.parse(rateAudit.after_json).hourlyCents, 2250);
  const exported = await app.call('GET', `/api/owner/export?userId=${employeeId}&weekStart=2026-11-09`);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  const summary = csvObjects(exported.text).find((row) => row.row_type === 'summary');
  assert.equal(summary.pay_date, '2026-11-20');
  assert.equal(summary.regular_hours, '7.50');
  assert.equal(summary.hourly_rate, '22.50');
  assert.equal(summary.gross_pay, '168.75');
});

test('a Sunday night shift is paid in both weeks through the export', async () => {
  const app = await makeApp();
  const employeeId = await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  await app.user({ displayName: 'Sample Owner', role: 'owner', pin: '2222' });
  await app.db.run(
    `INSERT INTO rate_history (user_id, hourly_cents, effective_on, created_at, created_by)
     VALUES (?, 2000, '2020-01-01', '2020-01-01T00:00:00.000Z', ?)`,
    [employeeId, employeeId],
  );
  await signIn(app, '1111', '203.0.113.90');
  app.setNow(at(2026, 11, 8, 22, 0));
  assert.equal((await app.call('POST', '/api/punch', { body: { action: 'clock_in' } })).status, 200);
  app.setNow(at(2026, 11, 9, 6, 0));
  assert.equal((await app.call('POST', '/api/punch', { body: { action: 'clock_out' } })).status, 200);
  await app.call('POST', '/api/auth/logout');
  await signIn(app, '2222', '203.0.113.91');
  const first = csvObjects((await app.call('GET', `/api/owner/export?userId=${employeeId}&weekStart=2026-11-02`)).text);
  const second = csvObjects((await app.call('GET', `/api/owner/export?userId=${employeeId}&weekStart=2026-11-09`)).text);
  assert.equal(first.find((row) => row.row_type === 'summary').regular_hours, '2.00');
  assert.equal(first.find((row) => row.row_type === 'summary').gross_pay, '40.00');
  assert.equal(first.find((row) => row.row_type === 'summary').pay_date, '2026-11-13');
  assert.equal(second.find((row) => row.row_type === 'summary').regular_hours, '6.00');
  assert.equal(second.find((row) => row.row_type === 'summary').gross_pay, '120.00');
  assert.equal(second.find((row) => row.row_type === 'summary').pay_date, '2026-11-20');
});

test('a session dies after 12 hours', async () => {
  const app = await makeApp();
  await app.user({ displayName: 'Sample Employee', role: 'employee', pin: '1111' });
  const start = app.now();
  assert.equal((await signIn(app, '1111', '203.0.113.15')).status, 200);
  app.setNow(start + 12 * 60 * 60 * 1000);
  assert.equal((await app.call('GET', '/api/me')).status, 401);
});
