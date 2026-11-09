import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.env.BASE_URL || 'http://127.0.0.1:8787';
const outDir = process.env.SHOT_DIR || '/opt/cursor/artifacts';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

const checks = [];
function check(name, ok) {
  checks.push({ name, ok });
  console.log(ok ? 'ok' : 'FAIL', name);
}

async function shot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file, fullPage: name.startsWith('owner-') });
  console.log('saved', file);
}

async function openPage(width, height) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.setDefaultTimeout(20000);
  await page.goto(base, { waitUntil: 'networkidle0' });
  return page;
}

async function enterPin(page, pin) {
  await page.waitForSelector('#pin-clear');
  await page.click('#pin-clear');
  for (const digit of pin) await page.click(`.pin-key[data-digit="${digit}"]`);
}

async function signIn(page, pin) {
  await enterPin(page, pin);
  await page.evaluate(() => document.querySelector('#sign-in').click());
}

async function press(page, selector) {
  await page.waitForSelector(selector);
  await page.evaluate((sel) => document.querySelector(sel).click(), selector);
}

const phone = await openPage(390, 900);
await enterPin(phone, '1234');
await shot(phone, 'pin-signin-phone');

const desktop = await openPage(1280, 900);
await enterPin(desktop, '1234');
await shot(desktop, 'pin-signin-desktop');

await signIn(phone, '1111');
await phone.waitForSelector('#employee-view:not([hidden]) #status-val');
check('phone starts clocked out', await phone.$eval('#status-val', (el) => el.textContent) === 'Clocked out');
check('phone has no edit buttons', (await phone.$$('.btn-edit')).length === 0);
await shot(phone, 'employee-out-phone');

await signIn(desktop, '1111');
await desktop.waitForSelector('#employee-view:not([hidden]) #status-val');
await desktop.waitForFunction(() => document.querySelector('#status-val')?.textContent === 'Clocked out');
await shot(desktop, 'employee-out-desktop');

await press(phone, '#primary-action');
await phone.waitForFunction(() => document.querySelector('#status-val')?.textContent === 'Clocked in');
await press(phone, '#lunch-action');
await phone.waitForFunction(() => document.querySelector('#lunch-action')?.textContent === 'Lunch In');
await press(phone, '#lunch-action');
await phone.waitForFunction(() => document.querySelector('#lunch-action')?.textContent === 'Lunch Out');
check('three punches after lunch', (await phone.$$('#today-punches .punch-row')).length === 3);
check('giant button is clock out', await phone.$eval('#primary-action', (el) => el.textContent) === 'Clock Out');
await shot(phone, 'employee-in-phone');

await desktop.reload({ waitUntil: 'networkidle0' });
await desktop.waitForFunction(() => document.querySelector('#status-val')?.textContent === 'Clocked in');
await shot(desktop, 'employee-in-desktop');

await press(phone, '#sign-out');
await phone.waitForFunction(() => document.querySelector('#signin-view') && !document.querySelector('#signin-view').hidden);
await signIn(phone, '2222');
await phone.waitForFunction(() => document.querySelector('#owner-view') && !document.querySelector('#owner-view').hidden);
await press(phone, '#week-prev');
await phone.waitForFunction(() => /Nov 2/.test(document.querySelector('#week-label')?.textContent || ''));
check('previous week regular hours are 40.00', await phone.$eval('#regular-hours', (el) => el.textContent) === '40.00');
await shot(phone, 'owner-week-phone');

await press(desktop, '#sign-out');
await desktop.waitForFunction(() => document.querySelector('#signin-view') && !document.querySelector('#signin-view').hidden);
await signIn(desktop, '2222');
await desktop.waitForFunction(() => document.querySelector('#owner-view') && !document.querySelector('#owner-view').hidden);
await press(desktop, '#week-prev');
await desktop.waitForFunction(() => /Nov 2/.test(document.querySelector('#week-label')?.textContent || ''));
await shot(desktop, 'owner-week-desktop');

const beforeHours = await desktop.$eval('#day-rows tr:first-child td:nth-child(6)', (el) => el.textContent.trim());
await press(desktop, '#day-rows .btn-edit');
await desktop.waitForSelector('#edit-modal.open');
await desktop.evaluate(() => {
  const input = document.querySelectorAll('#edit-rows input[type="time"]')[3];
  input.value = '16:30';
});
await press(desktop, '#edit-save');
await desktop.waitForFunction(
  (before) => {
    const modal = document.querySelector('#edit-modal');
    const cell = document.querySelector('#day-rows tr:first-child td:nth-child(6)');
    return modal && !modal.classList.contains('open') && cell && cell.textContent.trim() !== before;
  },
  {},
  beforeHours,
);
check('owner edit changes Monday hours', true);

const [exportResponse] = await Promise.all([
  desktop.waitForResponse((response) => response.url().includes('/api/owner/export') && response.status() === 200),
  press(desktop, '#export-week'),
]);
const csv = await exportResponse.text();
check('csv contains pay date and gross', csv.includes('pay_date') && csv.includes('gross_pay') && csv.includes('2026-11-13'));

await browser.close();
const failed = checks.filter((item) => !item.ok);
if (failed.length) {
  console.error(failed);
  process.exit(1);
}
console.log('screenshots and checks passed');
