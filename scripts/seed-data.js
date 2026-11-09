// LOCAL DEV FAKE DATA ONLY.
// Pins here are obvious test pins. Do not run this against production,
// and do not reuse these pins for a real person.

import { createUser } from '../src/users.js';
import {
  addDaysYmd,
  pacificLocalToUtc,
  pacificYmd,
  parseYmd,
  payWeekContaining,
  weekdayMon0,
} from '../src/time.js';

export const FAKE_EMPLOYEE_NAME = 'Sample Employee';
export const FAKE_OWNER_NAME = 'Sample Owner';
export const FAKE_EMPLOYEE_PIN = '1111';
export const FAKE_OWNER_PIN = '2222';

const WEEKDAY_PATTERNS = [
  { in: [7, 55], lunchOut: [12, 2], lunchIn: [12, 35], out: [16, 58] },
  { in: [8, 1], lunchOut: [12, 0], lunchIn: [12, 30], out: [17, 10] },
  { in: [7, 50], lunchOut: [11, 58], lunchIn: [12, 28], out: [18, 5] },
  { in: [7, 59], lunchOut: [12, 5], lunchIn: [12, 40], out: [17, 0] },
  { in: [8, 0], lunchOut: [12, 0], lunchIn: [12, 30], out: [17, 2] },
];

function isoAt(dateYmd, hour, minute) {
  const parsed = parseYmd(dateYmd);
  return new Date(pacificLocalToUtc(parsed.year, parsed.month, parsed.day, hour, minute).ms).toISOString();
}

async function insertPunch(db, userId, dateYmd, hour, minute, kind, nowIso) {
  await db.run(
    `INSERT INTO punches (user_id, kind, punched_at, source, created_at, updated_at)
     VALUES (?, ?, ?, 'self', ?, ?)`,
    [userId, kind, isoAt(dateYmd, hour, minute), nowIso, nowIso],
  );
}

async function insertShift(db, userId, dateYmd, pattern, nowIso) {
  await insertPunch(db, userId, dateYmd, pattern.in[0], pattern.in[1], 'clock_in', nowIso);
  await insertPunch(db, userId, dateYmd, pattern.lunchOut[0], pattern.lunchOut[1], 'lunch_out', nowIso);
  await insertPunch(db, userId, dateYmd, pattern.lunchIn[0], pattern.lunchIn[1], 'lunch_in', nowIso);
  await insertPunch(db, userId, dateYmd, pattern.out[0], pattern.out[1], 'clock_out', nowIso);
}

export async function seedIfEmpty(db, { pepper, iterations, now = new Date() }) {
  if (process.env.JCT_ENV === 'production') {
    throw new Error('Refusing to seed when JCT_ENV=production.');
  }
  const count = await db.first('SELECT COUNT(*) AS n FROM users');
  if (Number(count.n) > 0) return { seeded: false };

  const ownerId = await createUser(db, {
    displayName: FAKE_OWNER_NAME,
    role: 'owner',
    pin: FAKE_OWNER_PIN,
    pepper,
    iterations,
    now,
  });
  const employeeId = await createUser(db, {
    displayName: FAKE_EMPLOYEE_NAME,
    role: 'employee',
    pin: FAKE_EMPLOYEE_PIN,
    pepper,
    iterations,
    now,
  });
  const nowIso = now.toISOString();
  await db.run(
    `INSERT INTO rate_history (user_id, hourly_cents, effective_on, created_at, created_by)
     VALUES (?, 2000, '2025-01-01', ?, ?)`,
    [employeeId, nowIso, ownerId],
  );
  await db.run(
    `INSERT INTO rate_history (user_id, hourly_cents, effective_on, created_at, created_by)
     VALUES (?, 2250, '2026-01-01', ?, ?)`,
    [employeeId, nowIso, ownerId],
  );

  const today = pacificYmd(now.getTime());
  const week = payWeekContaining(now.getTime());
  const prevMonday = addDaysYmd(week.start, -7);
  const dates = [];
  for (let i = 0; i < 5; i += 1) dates.push(addDaysYmd(prevMonday, i));
  for (let cursor = week.start; cursor < today; cursor = addDaysYmd(cursor, 1)) {
    if (weekdayMon0(cursor) <= 4) dates.push(cursor);
  }
  let patternIndex = 0;
  for (const date of dates) {
    const pattern = WEEKDAY_PATTERNS[patternIndex % WEEKDAY_PATTERNS.length];
    patternIndex += 1;
    await insertShift(db, employeeId, date, pattern, nowIso);
  }

  const yesterday = addDaysYmd(today, -1);
  const punches = await db.all(`SELECT punched_at FROM punches WHERE user_id = ?`, [employeeId]);
  const yesterdayHasOut = punches.some((row) => pacificYmd(Date.parse(row.punched_at)) === yesterday);
  if (!yesterdayHasOut) {
    await insertShift(db, employeeId, yesterday, {
      in: [9, 0],
      lunchOut: [12, 0],
      lunchIn: [12, 30],
      out: [17, 2],
    }, nowIso);
  }
  return { seeded: true, ownerId, employeeId };
}
