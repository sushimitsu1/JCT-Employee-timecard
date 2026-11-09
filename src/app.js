import { buildWeekCsv } from './csv.js';
import {
  clearedLock,
  dummyVerify,
  hmacHex,
  isLocked,
  noteFailure,
  randomToken,
  SESSION_MS,
  verifyPin,
} from './auth.js';
import {
  buildEmployeeView,
  buildWeekView,
  centsToDollars,
  dollarsToCents,
  formatDollars,
  formatHours,
  localTimeOnDate,
  validatePunches,
} from './pay.js';
import {
  addAudit,
  bindDevice,
  deleteSession,
  getDeviceUserId,
  getEmployee,
  getLock,
  getSessionUser,
  insertSession,
  listPunches,
  listRates,
  punchSnapshot,
  saveLock,
} from './store.js';
import { listEmployees } from './users.js';
import { pacificYmd, parseYmd, payWeekContaining, weekdayMon0 } from './time.js';

const PUNCH_KINDS = new Set(['clock_in', 'clock_out', 'lunch_out', 'lunch_in']);

function json(data, status = 200, cookies = []) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(data), { status, headers });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAge) {
  return `tc_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

function deviceCookie(token) {
  return `tc_device=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=34560000`;
}

async function readJson(request) {
  const length = Number(request.headers.get('content-length') || 0);
  if (length > 100000) return { error: json({ error: 'too_large', message: 'Request is too large.' }, 413) };
  const text = await request.text();
  if (text.length > 100000) return { error: json({ error: 'too_large', message: 'Request is too large.' }, 413) };
  if (!text) return { body: {} };
  try {
    return { body: JSON.parse(text) };
  } catch {
    return { error: json({ error: 'bad_json', message: 'Expected JSON.' }, 400) };
  }
}

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}

async function deviceContext(request, deps) {
  const cookies = parseCookies(request.headers.get('cookie'));
  let token = cookies.tc_device;
  const cookiesToSet = [];
  if (!token || token.length < 20) {
    token = randomToken();
    cookiesToSet.push(deviceCookie(token));
  }
  const deviceHash = await hmacHex(deps.sessionSecret, `device:${token}`);
  return { cookies, deviceHash, cookiesToSet };
}

async function currentUser(request, deps) {
  const cookies = parseCookies(request.headers.get('cookie'));
  if (!cookies.tc_session) return null;
  const tokenHash = await hmacHex(deps.sessionSecret, cookies.tc_session);
  const row = await getSessionUser(deps.db, tokenHash);
  if (!row || row.active !== 1) return null;
  if (Date.parse(row.expires_at) <= deps.now().getTime()) return null;
  return { id: row.id, displayName: row.display_name, role: row.role, tokenHash };
}

function requireUser(user) {
  if (!user) return json({ error: 'unauthorized', message: 'Sign in.' }, 401);
  return null;
}

function requireOwner(user) {
  const missing = requireUser(user);
  if (missing) return missing;
  if (user.role !== 'owner') return json({ error: 'forbidden', message: 'Owner only.' }, 403);
  return null;
}

function presentWeek(view) {
  return {
    start: view.week.start,
    end: view.week.end,
    payDate: view.week.payDate,
    label: view.week.label,
    payLabel: view.week.payLabel,
    totals: {
      regularHours: formatHours(view.totals.regularMinutes, 2),
      otHours: formatHours(view.totals.otMinutes, 2),
      totalHours: formatHours(view.totals.totalMinutes, 2),
      regularPay: formatDollars(view.totals.regularPayCents),
      otPay: formatDollars(view.totals.otPayCents),
      grossPay: formatDollars(view.totals.grossPayCents),
      regularPayCents: view.totals.regularPayCents,
      otPayCents: view.totals.otPayCents,
      grossPayCents: view.totals.grossPayCents,
      rateDollars: view.totals.mondayRateCents == null ? '' : centsToDollars(view.totals.mondayRateCents),
      rateNote: view.totals.rateNote,
    },
    days: view.days.map((day) => ({
      date: day.date,
      label: day.label,
      minutes: day.minutes,
      hours: day.hoursLabel,
      hoursWithUnit: `${day.hoursLabel} hrs`,
      status: day.status,
      overnight: day.overnight,
      in: day.in.join(', ') || '—',
      lunchOut: day.lunchOut.join(', ') || '—',
      lunchIn: day.lunchIn.join(', ') || '—',
      out: day.out.join(', ') || '—',
      punches: day.punches,
    })),
  };
}

async function loadWeek(db, userId, weekStart, asOfMs) {
  const punches = await listPunches(db, userId);
  const rates = await listRates(db, userId);
  const view = buildWeekView({ punches, rates, weekStartYmd: weekStart, asOfMs });
  return { punches, rates, view };
}

function lockMessage(row, nowMs) {
  const ms = row?.lockedUntilMs ? row.lockedUntilMs - nowMs : 15 * 60 * 1000;
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `Too many tries. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

async function signIn(request, deps) {
  const device = await deviceContext(request, deps);
  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const nowMs = deps.now().getTime();
  const ip = clientIp(request);
  const ipLock = await getLock(deps.db, 'ip', ip);
  if (isLocked(ipLock, nowMs)) {
    return json({ error: 'locked', message: lockMessage(ipLock, nowMs) }, 429, device.cookiesToSet);
  }
  const pin = parsed.body?.pin;
  const pinOk = typeof pin === 'string' && /^\d{4,6}$/.test(pin);
  const users = await deps.db.all(
    `SELECT id, display_name, role, pin_salt, pin_hash, pin_iterations, active
     FROM users WHERE active = 1 ORDER BY id`,
  );
  let matched = null;
  if (pinOk && users.length) {
    for (const user of users) {
      if (await verifyPin(pin, deps.pepper, user)) {
        if (!matched) matched = user;
      }
    }
  } else {
    await dummyVerify(deps.pepper, deps.iterations);
  }
  if (matched) {
    const userLock = await getLock(deps.db, 'user', String(matched.id));
    if (isLocked(userLock, nowMs)) {
      return json({ error: 'locked', message: lockMessage(userLock, nowMs) }, 429, device.cookiesToSet);
    }
    const token = randomToken();
    const tokenHash = await hmacHex(deps.sessionSecret, token);
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + SESSION_MS).toISOString();
    await deps.db.transaction(async () => {
      await insertSession(deps.db, { tokenHash, userId: matched.id, expiresAt, createdAt });
      await saveLock(deps.db, 'ip', ip, clearedLock());
      await saveLock(deps.db, 'user', String(matched.id), clearedLock());
      await bindDevice(deps.db, device.deviceHash, matched.id, createdAt);
    });
    return json(
      { user: { id: matched.id, displayName: matched.display_name, role: matched.role } },
      200,
      [...device.cookiesToSet, sessionCookie(token, Math.floor(SESSION_MS / 1000))],
    );
  }
  const nextIp = noteFailure(ipLock, nowMs);
  await saveLock(deps.db, 'ip', ip, nextIp);
  let nextUser = null;
  const boundUserId = await getDeviceUserId(deps.db, device.deviceHash);
  if (boundUserId != null) {
    const userLock = await getLock(deps.db, 'user', String(boundUserId));
    nextUser = noteFailure(userLock, nowMs);
    await saveLock(deps.db, 'user', String(boundUserId), nextUser);
  }
  if (isLocked(nextIp, nowMs) || isLocked(nextUser, nowMs)) {
    const row = isLocked(nextIp, nowMs) ? nextIp : nextUser;
    return json({ error: 'locked', message: lockMessage(row, nowMs) }, 429, device.cookiesToSet);
  }
  return json({ error: 'wrong_pin', message: 'Wrong PIN.' }, 401, device.cookiesToSet);
}

async function signOut(request, deps) {
  const cookies = parseCookies(request.headers.get('cookie'));
  if (cookies.tc_session) {
    const tokenHash = await hmacHex(deps.sessionSecret, cookies.tc_session);
    await deleteSession(deps.db, tokenHash);
  }
  return json({ ok: true }, 200, [sessionCookie('', 0)]);
}

async function me(user, deps) {
  if (user.role === 'owner') {
    return json({ user: { id: user.id, displayName: user.displayName, role: user.role } });
  }
  const punches = await listPunches(deps.db, user.id);
  const rates = await listRates(deps.db, user.id);
  const view = buildEmployeeView({ punches, rates, nowMs: deps.now().getTime() });
  return json({
    user: { id: user.id, displayName: user.displayName, role: user.role },
    ...view,
  });
}

async function punch(user, request, deps) {
  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const action = parsed.body?.action;
  if (!PUNCH_KINDS.has(action)) return json({ error: 'bad_action', message: 'Unknown punch.' }, 400);
  const now = deps.now();
  const nowIso = now.toISOString();
  try {
    await deps.db.transaction(async () => {
      const punches = await listPunches(deps.db, user.id);
      const merged = [
        ...punches.map((row) => ({ id: row.id, kind: row.kind, atMs: row.atMs })),
        { id: 0, kind: action, atMs: now.getTime() },
      ];
      const errors = validatePunches(merged);
      if (errors.length) {
        const error = new Error(errors[0]);
        error.code = 'invalid_transition';
        throw error;
      }
      await deps.db.run(
        `INSERT INTO punches (user_id, kind, punched_at, source, created_at, updated_at)
         VALUES (?, ?, ?, 'self', ?, ?)`,
        [user.id, action, nowIso, nowIso, nowIso],
      );
    });
  } catch (error) {
    if (error.code === 'invalid_transition') {
      return json({ error: 'invalid_transition', message: error.message }, 400);
    }
    throw error;
  }
  return me(user, deps);
}

async function requireEmployeeTarget(db, userId) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return { error: json({ error: 'not_found', message: 'Employee not found.' }, 404) };
  const employee = await getEmployee(db, id);
  if (!employee || employee.role !== 'employee') {
    return { error: json({ error: 'not_found', message: 'Employee not found.' }, 404) };
  }
  return { employee };
}

function weekStartOrCurrent(value, nowMs) {
  if (!value) return payWeekContaining(nowMs).start;
  if (!parseYmd(value) || weekdayMon0(value) !== 0) return null;
  return value;
}

async function ownerWeek(request, deps) {
  const url = new URL(request.url);
  const target = await requireEmployeeTarget(deps.db, url.searchParams.get('userId'));
  if (target.error) return target.error;
  const weekStart = weekStartOrCurrent(url.searchParams.get('weekStart'), deps.now().getTime());
  if (!weekStart) return json({ error: 'bad_week', message: 'Week must start on a Monday.' }, 400);
  try {
    const { view } = await loadWeek(deps.db, target.employee.id, weekStart, deps.now().getTime());
    return json({
      employee: { id: target.employee.id, displayName: target.employee.display_name },
      ...presentWeek(view),
    });
  } catch (error) {
    if (error.code === 'invalid_timeline') return json({ error: 'invalid_timeline', message: error.message }, 409);
    throw error;
  }
}

async function ownerEmployees(deps) {
  const employees = await listEmployees(deps.db);
  return json({
    employees: employees.map((employee) => ({ id: employee.id, displayName: employee.display_name })),
  });
}

async function ownerRate(user, request, deps) {
  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const target = await requireEmployeeTarget(deps.db, parsed.body?.userId);
  if (target.error) return target.error;
  const cents = dollarsToCents(parsed.body?.dollars);
  if (cents == null) return json({ error: 'bad_rate', message: 'Enter a rate like 22.50.' }, 400);
  const effectiveOn = parsed.body?.effectiveOn;
  if (!parseYmd(effectiveOn)) return json({ error: 'bad_date', message: 'Effective date is not a real date.' }, 400);
  const nowIso = deps.now().toISOString();
  await deps.db.transaction(async () => {
    const existing = await deps.db.first(
      `SELECT id, hourly_cents, effective_on FROM rate_history WHERE user_id = ? AND effective_on = ?`,
      [target.employee.id, effectiveOn],
    );
    if (existing && existing.hourly_cents === cents) return;
    await deps.db.run(
      `INSERT INTO rate_history (user_id, hourly_cents, effective_on, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, effective_on) DO UPDATE SET
         hourly_cents = excluded.hourly_cents,
         created_at = excluded.created_at,
         created_by = excluded.created_by`,
      [target.employee.id, cents, effectiveOn, nowIso, user.id],
    );
    const saved = await deps.db.first(
      `SELECT id, hourly_cents, effective_on FROM rate_history WHERE user_id = ? AND effective_on = ?`,
      [target.employee.id, effectiveOn],
    );
    await addAudit(deps.db, {
      actorId: user.id,
      action: 'rate.upsert',
      entityType: 'rate',
      entityId: saved.id,
      targetUserId: target.employee.id,
      before: existing ? { hourlyCents: existing.hourly_cents, effectiveOn: existing.effective_on } : null,
      after: { hourlyCents: cents, effectiveOn },
      at: nowIso,
    });
  });
  return json({ ok: true, hourlyCents: cents, dollars: centsToDollars(cents), effectiveOn });
}

async function ownerDay(user, request, deps) {
  const parsed = await readJson(request);
  if (parsed.error) return parsed.error;
  const target = await requireEmployeeTarget(deps.db, parsed.body?.userId);
  if (target.error) return target.error;
  const date = parsed.body?.date;
  if (!parseYmd(date)) return json({ error: 'bad_date', message: 'That date is not valid.' }, 400);
  if (!Array.isArray(parsed.body?.punches)) return json({ error: 'bad_punches', message: 'Send the punches for that day.' }, 400);
  const warnings = [];
  const incoming = [];
  const seenIds = new Set();
  for (const punch of parsed.body.punches) {
    if (!PUNCH_KINDS.has(punch?.kind)) return json({ error: 'bad_punch', message: 'Unknown punch type.' }, 400);
    const resolved = localTimeOnDate(date, punch.time);
    if (!resolved) return json({ error: 'bad_time', message: 'Use a time like 07:55.' }, 400);
    if (resolved.warning) warnings.push(resolved.warning);
    if (resolved.ms > deps.now().getTime() + 60000) {
      return json({ error: 'future_punch', message: 'Punches cannot be in the future.' }, 400);
    }
    const id = punch.id == null || punch.id === '' ? null : Number(punch.id);
    if (id != null && (!Number.isInteger(id) || seenIds.has(id))) {
      return json({ error: 'bad_punch', message: 'Punch id is not valid.' }, 400);
    }
    if (id != null) seenIds.add(id);
    incoming.push({ id, kind: punch.kind, atMs: resolved.ms });
  }
  const nowIso = deps.now().toISOString();
  try {
    await deps.db.transaction(async () => {
      const all = await listPunches(deps.db, target.employee.id);
      const onDay = all.filter((row) => pacificYmd(row.atMs) === date);
      const onDayIds = new Set(onDay.map((row) => row.id));
      for (const punch of incoming) {
        if (punch.id != null && !onDayIds.has(punch.id)) {
          const error = new Error('That punch is not on this day.');
          error.code = 'bad_punch';
          throw error;
        }
      }
      const kept = all.filter((row) => pacificYmd(row.atMs) !== date);
      const merged = [
        ...kept.map((row) => ({ id: row.id, kind: row.kind, atMs: row.atMs })),
        ...incoming.map((punch) => ({ id: punch.id ?? 0, kind: punch.kind, atMs: punch.atMs })),
      ];
      const errors = validatePunches(merged);
      if (errors.length) {
        const error = new Error(errors[0]);
        error.code = 'invalid_timeline';
        throw error;
      }
      const incomingIds = new Set(incoming.filter((punch) => punch.id != null).map((punch) => punch.id));
      for (const row of onDay) {
        if (!incomingIds.has(row.id)) {
          await deps.db.run(`DELETE FROM punches WHERE id = ? AND user_id = ?`, [row.id, target.employee.id]);
          await addAudit(deps.db, {
            actorId: user.id,
            action: 'punch.delete',
            entityType: 'punch',
            entityId: row.id,
            targetUserId: target.employee.id,
            before: punchSnapshot(row),
            after: null,
            at: nowIso,
          });
        }
      }
      for (const punch of incoming) {
        const punchedAt = new Date(punch.atMs).toISOString();
        if (punch.id == null) {
          const inserted = await deps.db.run(
            `INSERT INTO punches (user_id, kind, punched_at, source, created_at, updated_at)
             VALUES (?, ?, ?, 'owner', ?, ?)`,
            [target.employee.id, punch.kind, punchedAt, nowIso, nowIso],
          );
          await addAudit(deps.db, {
            actorId: user.id,
            action: 'punch.create',
            entityType: 'punch',
            entityId: inserted.lastRowId,
            targetUserId: target.employee.id,
            before: null,
            after: { id: inserted.lastRowId, userId: target.employee.id, kind: punch.kind, punchedAt, source: 'owner' },
            at: nowIso,
          });
        } else {
          const prev = onDay.find((row) => row.id === punch.id);
          if (prev.kind === punch.kind && prev.atMs === punch.atMs) continue;
          await deps.db.run(
            `UPDATE punches SET kind = ?, punched_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
            [punch.kind, punchedAt, nowIso, punch.id, target.employee.id],
          );
          await addAudit(deps.db, {
            actorId: user.id,
            action: 'punch.update',
            entityType: 'punch',
            entityId: punch.id,
            targetUserId: target.employee.id,
            before: punchSnapshot(prev),
            after: { id: punch.id, userId: target.employee.id, kind: punch.kind, punchedAt, source: prev.source },
            at: nowIso,
          });
        }
      }
    });
  } catch (error) {
    if (error.code === 'invalid_timeline' || error.code === 'bad_punch') {
      return json({ error: error.code, message: error.message }, 400);
    }
    throw error;
  }
  return json({ ok: true, warnings });
}

async function ownerExport(request, deps) {
  const url = new URL(request.url);
  const target = await requireEmployeeTarget(deps.db, url.searchParams.get('userId'));
  if (target.error) return target.error;
  const weekStart = weekStartOrCurrent(url.searchParams.get('weekStart'), deps.now().getTime());
  if (!weekStart) return json({ error: 'bad_week', message: 'Week must start on a Monday.' }, 400);
  let csv;
  try {
    const { view } = await loadWeek(deps.db, target.employee.id, weekStart, deps.now().getTime());
    csv = buildWeekCsv(view, target.employee.display_name);
  } catch (error) {
    if (error.code === 'invalid_timeline') return json({ error: 'invalid_timeline', message: error.message }, 409);
    throw error;
  }
  const slug = target.employee.display_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'employee';
  return new Response(csv, {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="timecard-${slug}-${weekStart}.csv"`,
      'cache-control': 'no-store',
    },
  });
}

async function route(request, deps) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (!path.startsWith('/api/')) {
    if (!deps.assets) return new Response('Not found', { status: 404 });
    const asset = await deps.assets.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set('x-content-type-options', 'nosniff');
    headers.set('referrer-policy', 'no-referrer');
    headers.set('cache-control', 'no-store');
    return new Response(asset.body, { status: asset.status, headers });
  }
  if (request.headers.get('x-jct-request') !== '1') {
    return json({ error: 'bad_request', message: 'Missing app header.' }, 400);
  }
  if (path === '/api/health' && request.method === 'GET') return json({ ok: true });
  if (path === '/api/auth/pin' && request.method === 'POST') return signIn(request, deps);
  if (path === '/api/auth/logout' && request.method === 'POST') return signOut(request, deps);

  const user = await currentUser(request, deps);
  const missing = requireUser(user);
  if (missing) return missing;

  if (path === '/api/me' && request.method === 'GET') return me(user, deps);
  if (path === '/api/punch' && request.method === 'POST') return punch(user, request, deps);

  if (path.startsWith('/api/owner/')) {
    const forbidden = requireOwner(user);
    if (forbidden) return forbidden;
    if (path === '/api/owner/employees' && request.method === 'GET') return ownerEmployees(deps);
    if (path === '/api/owner/week' && request.method === 'GET') return ownerWeek(request, deps);
    if (path === '/api/owner/rate' && request.method === 'PUT') return ownerRate(user, request, deps);
    if (path === '/api/owner/day' && request.method === 'PUT') return ownerDay(user, request, deps);
    if (path === '/api/owner/export' && request.method === 'GET') return ownerExport(request, deps);
  }
  return json({ error: 'not_found', message: 'Not found.' }, 404);
}

export async function handleRequest(request, deps) {
  try {
    return await route(request, deps);
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      msg: 'unhandled',
      error: error instanceof Error ? error.message : 'error',
    }));
    return json({ error: 'server_error', message: 'Something went wrong.' }, 500);
  }
}
