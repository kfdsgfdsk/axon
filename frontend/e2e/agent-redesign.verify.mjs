#!/usr/bin/env node
/**
 * Agent cockpit redesign verification (standalone Playwright script).
 *
 *   1. Registers a fresh user via the API and seeds localStorage tokens.
 *   2. Opens /agent in demo mode and asserts the new plain-language UX:
 *      - "How should the desk work?" selector with 5 titled modes
 *      - per-mode placeholder + helper text
 *      - dry-run consequence text, teaching empty state, quick prompts
 *   3. Runs one FAST deliberation and asserts debate activity followed by
 *      a proposal panel with Approve / Veto / Re-attack controls.
 *   4. Smoke-tests narrow-viewport single-column collapse.
 *
 * Run (playwright package must resolve, e.g. NODE_PATH=/tmp/pw-e2e/node_modules):
 *   node frontend/e2e/agent-redesign.verify.mjs [baseURL=http://localhost:8080]
 */
import { chromium } from 'playwright';

const BASE = (process.argv[2] || 'http://localhost:8080').replace(/\/$/, '');
const SHOTS = process.env.PW_SHOTS || '/tmp/pw-shots';

const EXPECTED_TITLES = ['Quick take', 'Morning brief', 'Goal → plan', 'Test a thesis', 'Red-team'];
const EXPECTED_PLACEHOLDERS = [
  'Ask for a fast read — “What’s the bias on SOL right now?”',
  'Optional focus — or just hit run for the morning brief…',
  'State a goal — “grow stables by 2% this month without leverage”…',
  'State a thesis to stress-test — “should I rotate 15% of ETH into SOL?”',
  'Name the plan to attack — or run right after a proposal to red-team it…',
];

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

async function main() {
  const email = `e2e-${Date.now().toString(36)}@axon.local`;
  const password = `E2eVerify${Date.now().toString(36)}1aA!`;
  const reg = await fetch(`${BASE}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!reg.ok) throw new Error(`register → ${reg.status}: ${(await reg.text()).slice(0, 200)}`);
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!login.ok) throw new Error(`login → ${login.status}`);
  const lj = await login.json();
  const access = lj?.data?.accessToken;
  const refresh = lj?.data?.refreshToken;
  if (!access) throw new Error('login did not return accessToken');

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(
    ({ a, r }) => {
      localStorage.setItem('axon.access', a);
      if (r) localStorage.setItem('axon.refresh', r);
      localStorage.setItem('axon.mode', 'demo');
    },
    { a: access, r: refresh }
  );
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));

  await page.goto(`${BASE}/agent`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForSelector('.cap-grid', { timeout: 30000 });

  // 1. Capability selector: plain-language titles + descriptions.
  const titles = await page.locator('.cap-grid .cap-title').allTextContents();
  check('5 mode titles', JSON.stringify(titles) === JSON.stringify(EXPECTED_TITLES), titles.join(' | '));
  const descs = await page.locator('.cap-grid .cap-desc').allTextContents();
  check('5 mode descriptions', descs.length === 5 && descs.every((d) => d.trim().length > 10));
  const examples = await page.locator('.cap-grid .cap-ex').allTextContents();
  check('5 mode examples', examples.length === 5 && examples.every((d) => d.includes('e.g.')));
  const bareOld = await page.locator('.cap-grid').innerText();
  check(
    'no bare React/Brief/Plan/Strategy/Attack chips',
    !/(^|\n)(React|Brief|Plan|Strategy|Attack)(\n|$)/.test(bareOld) && !/rapid read|morning desk|goal → steps|red-team it/.test(bareOld)
  );
  await page.screenshot({ path: `${SHOTS}/01-composer.png` });

  // 2. Per-mode placeholder + helper updates.
  const cards = page.locator('.cap-grid .cap-card');
  const box = page.locator('textarea[aria-label="Brief the desk"]');
  for (let i = 0; i < 5; i++) {
    await cards.nth(i).click();
    const ph = await box.getAttribute('placeholder');
    check(`mode ${i} (${EXPECTED_TITLES[i]}) placeholder`, ph === EXPECTED_PLACEHOLDERS[i], ph || '(none)');
    const helper = (await page.locator('.mode-helper').innerText()).trim();
    check(`mode ${i} helper text`, helper.length > 10, helper.slice(0, 60));
    const checked = await cards.nth(i).getAttribute('aria-checked');
    check(`mode ${i} aria-checked`, checked === 'true');
  }

  // 3. Dry-run consequence text + empty state teaching columns.
  const cons = await page.locator('.consequence').first().innerText();
  check('dry-run consequence visible', /nothing will execute/i.test(cons), cons);
  await page.locator('.cap-grid .cap-card').nth(2).click(); // back to Goal → plan
  const emptyCols = await page.locator('.cockpit-empty .empty-col p').allTextContents();
  check('empty state teaches 3 columns', emptyCols.length === 3, emptyCols.map((t) => t.slice(0, 40)).join(' // '));
  check('empty state CTA', (await page.locator('.cockpit-empty').getByRole('button', { name: /60-second run/ }).count()) === 1);
  check('no Approve before proposal', (await page.getByRole('button', { name: /Approve simulation/ }).count()) === 0);

  // 4. Quick prompt sets text + recommended mode.
  const qp = page.locator('.quick-prompts button', { hasText: 'quick read on BTC' });
  await qp.click();
  check('quick prompt fills text', ((await box.inputValue()) || '').includes('quick read on BTC'));
  const quickMode = await page.locator('.cap-grid .cap-card').nth(0).getAttribute('aria-checked');
  check('quick prompt selects Quick take', quickMode === 'true');

  // 5. Run a FAST deliberation; debate activity then proposal.
  await page.locator('.dry-pill').nth(1).click(); // FAST CREW
  const fastLabel = await page.locator('.consequence.dim').innerText();
  check('fast consequence text', /5 roles/i.test(fastLabel), fastLabel);
  await page.getByRole('button', { name: /Run deliberation/ }).click();
  try {
    await page.waitForSelector('.cockpit-grid.stage-live .round-card.live, .cockpit-grid.stage-live .debate-turn', { timeout: 90000 });
    check('debate stream goes live', true);
  } catch {
    check('debate stream goes live', false, 'no live round/turn within 90s');
  }
  await page.screenshot({ path: `${SHOTS}/02-live-debate.png` });
  try {
    await page.waitForSelector('.prop-flash, .cockpit-error', { timeout: 300000 });
    const failed = await page.locator('.cockpit-error').count();
    check('proposal (or explicit failure) arrives', failed === 0, failed ? await page.locator('.cockpit-error').innerText() : '');
  } catch {
    check('proposal (or explicit failure) arrives', false, 'timeout after 300s');
  }
  const hasProposal = (await page.locator('.prop-flash').count()) > 0;
  if (hasProposal) {
    check('proposal helper text', (await page.locator('.prop-flash .help-line').count()) === 1);
    check('Approve visible', (await page.getByRole('button', { name: /Approve simulation/ }).count()) === 1);
    check('Veto visible', (await page.getByRole('button', { name: 'Veto', exact: true }).count()) === 1);
    check('Re-attack visible', (await page.getByRole('button', { name: 'Re-attack', exact: true }).count()) === 1);
    const vetoTitle = await page.getByRole('button', { name: 'Veto', exact: true }).getAttribute('title');
    check('Veto tooltip', !!vetoTitle && vetoTitle.length > 10, (vetoTitle || '').slice(0, 60));
    const stage = await page.locator('.cockpit-grid.stage-proposal').count();
    check('grid reaches proposal stage', stage === 1);
  }
  await page.screenshot({ path: `${SHOTS}/03-proposal.png` });

  // 6. Narrow viewport: single-column progressive flow.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  if (hasProposal) {
    const order = await page.evaluate(() => {
      const y = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? -1;
      return { debate: y('.col-debate'), proposal: y('.col-proposal'), oversight: y('.col-oversight') };
    });
    check(
      'narrow order debate → proposal → oversight',
      order.debate >= 0 && order.debate < order.proposal && order.proposal < order.oversight,
      JSON.stringify(order)
    );
  } else {
    check('narrow order debate → proposal → oversight', false, 'skipped (no proposal)');
  }
  await page.screenshot({ path: `${SHOTS}/04-narrow.png` });

  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' // '));
  await browser.close();

  console.log(failures === 0 ? '\nE2E ALL GREEN' : `\nE2E ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`E2E FATAL ${e?.message || e}`);
  process.exit(2);
});
