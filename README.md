# JCT My Timecard

Phone timecard for one sample employee and an owner. The employee signs in with a PIN, clocks in and out, and can take an unpaid lunch. The employee cannot edit anything. The owner signs in with a different PIN, can edit punches and the hourly rate, and can export a week as CSV.

This build is **not deployed**. It does not change DNS. `main` is untouched. The database id in `wrangler.jsonc` is a placeholder.

All names, hours, and PINs in this repo are fake. Do not load the seed into a production database.

## Run the tests

```bash
npm test
```

That runs `test/pay.test.js` and `test/access.test.js` with Node's built-in test runner. No install step is required. Node 22 or newer is required (`node:sqlite` is used for the API tests).

Pay and time math lives in `src/pay.js` and `src/time.js`, with no database and no Worker APIs, so the numbers can be reviewed on their own. A table of the cases and the expected pay is in the pull request.

## Run it locally

```bash
npm run dev
```

Open http://127.0.0.1:8787

The server creates `local.sqlite` (gitignored), applies `migrations/0001_init.sql`, and seeds fake users if the database is empty. It also writes a gitignored `.dev.vars` with random `PIN_PEPPER` and `SESSION_SECRET` values when those are missing. Those values are not printed.

Local fake PINs, for this machine only:

| Who | PIN | Can do |
| --- | --- | --- |
| Sample Employee | 1111 | Clock in, clock out, lunch out, lunch in. See their own current week. No edits. |
| Sample Owner | 2222 | View and edit the employee's punches, change the hourly rate, export the week. |

Delete `local.sqlite` and run `npm run dev` again to reseed. `npm run seed` reuses the same file and does not reset an existing database.

`scripts/create-user.js` can add another local user. It reads the PIN from the terminal and does not print it. It only writes `local.sqlite`. It refuses to run when `JCT_ENV=production`.

## Pay rules in this build

These are the rules the tests lock in. They are also listed for Jay in the pull request, because a couple of them were still open in the original handoff.

- Time zone is `America/Los_Angeles`. Daylight saving is handled by storing real instants, not by adding clock hours.
- A pay week is Monday 00:00 through Sunday 24:00 Pacific.
- **Pay Friday is the Friday after that Sunday** (Monday + 11 days). It is not the Friday inside the week. For the week of Mon Nov 9–Sun Nov 15, 2026, pay Friday is **Nov 20, 2026**.
- Punches are not rounded to 5 or 15 minutes. The exact instant is stored. The screen shows the Pacific hour and minute.
- Paid time is whole minutes. Leftover seconds are dropped (`floor`), not rounded up.
- Lunch is unpaid. Clocking out while still at lunch ends the shift and does not pay the lunch.
- A shift that crosses midnight is split at Pacific midnight. Sunday night into Monday is split at Monday 00:00: the minutes before midnight stay in the old week, and the minutes after midnight go to the new week. The pieces add up to the same whole-minute total.
- An open shift (no clock out yet) counts up to the current time. It keeps counting until someone clocks out or the owner edits it, including across later weeks.
- Overtime is weekly only. Minutes after 40 hours (2,400 minutes) in the pay week are overtime at 1.5×. There is no daily overtime.
- Money is integer cents.
  - Regular pay = half-up(`regularMinutes × hourlyCents / 60`)
  - Overtime pay = half-up(`otMinutes × hourlyCents × 3 / 120`)
  - A remainder of exactly half a cent rounds up.
  - Each hourly rate in the week is rounded once for regular minutes and once for overtime minutes. Days are not rounded separately and then added.
- The rate for a day is the latest saved rate whose effective date is on or before that Pacific date. Saving the rate on the week screen sets it from **that week's Monday** until the next saved rate. A past week therefore uses the rate that applied then.
- Every owner edit (punch create, change, delete, and rate change) is written to `audit_log` with before, after, who, and when.

## Sign-in

- PINs are 4–6 digits. Only a salted PBKDF2-SHA-256 hash is stored. The password material is `pepper + ":" + pin`. Default work factor is 210,000 iterations (`PIN_PBKDF2_ITERATIONS`). Each user keeps the iteration count they were hashed with.
- Five wrong tries lock that sign-in for 15 minutes. The counter is kept for the IP, and also for the user when this browser already signed in successfully on this device (an HttpOnly device cookie). A correct PIN still fails while that user is locked. A new IP does not clear a user lock. Extra tries during the lock do not extend it. A success, or 15 quiet minutes before the fifth failure, clears the count.
- The session cookie is `tc_session`, HttpOnly, Secure, SameSite=Strict, and lasts 12 hours. The database stores an HMAC of the token, not the token.
- The server checks the role on every request. An employee who calls an `/api/owner/` route gets 403. Punch time comes from the server clock. An employee cannot send their own timestamp.

PIN-only sign-in cannot tell which person a wrong PIN was aimed at. That is why a user lock is tied to a device that already signed in as that person, while every IP is counted on its own. On a shared shop Wi-Fi, five wrong PINs from one phone lock that IP for 15 minutes, which also blocks the owner's phone if it is on the same network.

## Cloudflare, when Jay is ready

Do not deploy this branch, and do not point `timecard.jctlogisticsinc.com` at it, until Jay says so.

1. `npx wrangler d1 create jct-timecard`
2. Replace the placeholder `database_id` in `wrangler.jsonc` with the id that command prints.
3. `npx wrangler d1 migrations apply jct-timecard --remote`
4. Set the secrets. Wrangler prompts; do not put the values in the command or in git:

   ```bash
   npx wrangler secret put PIN_PEPPER
   npx wrangler secret put SESSION_SECRET
   ```

   Use long random strings (32 bytes is plenty). They are not the PINs. Local development reads the same names from `.dev.vars`, which `npm run dev` creates and git ignores. `wrangler secret put` publishes a Worker version, so leave it until a deploy is actually wanted.
5. Do **not** run `scripts/seed.js` against the remote database. Create real users separately, with real PINs that are never committed. `scripts/create-user.js --sql-out user.sql` can write an INSERT of the salt and hash only; review that file and apply it yourself. Delete it afterward. It still uses the local pepper, so a production hash has to be made with the production pepper.

`npx wrangler dev` is the Worker-shaped local run (local D1, `.dev.vars`). `npm run dev` is the path this repo's screenshots and seed use. Neither one deploys.

## Layout

| Path | What it is |
| --- | --- |
| `src/pay.js`, `src/time.js`, `src/csv.js` | Pure pay, Pacific time, and CSV |
| `src/auth.js` | PIN hash and lockout rules |
| `src/app.js` | JSON API |
| `src/worker.js` | Cloudflare Worker entry |
| `public/` | The screens |
| `migrations/0001_init.sql` | D1 schema |
| `scripts/dev-server.js` | Local server used for screenshots |
| `test/` | `npm test` |
