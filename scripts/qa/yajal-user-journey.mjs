#!/usr/bin/env node
// Collector only. Exit 0 means collection finished, never product QA PASS.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readConfig, BOT_ID, repliesTo, fingerprint } from './lib/yajal-journey-contract.mjs';

const evidence = { schema: 'yajal-journey/v1', startedAt: new Date().toISOString(), doctor: {}, actions: [], observations: {}, errors: [], cleanup: {} };
let browser, client, page, out, config;
let ownsOutput = false;
let stage = 'configuration';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function shot(name) {
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  evidence.observations[name] = `${name}.png`;
}
async function query(request) {
  const { data, error } = await request;
  if (error) throw new Error('authenticated database observation failed');
  return data;
}
async function sampleMessages(conversationId) {
  // query-guard: bounded -- Latest 30 rows of this fresh test account's single-question conversation only; a sample, never a complete history/count. Missing question/reply stays unobserved, not PASS.
  return query(client.from('dm_messages').select('id,conversation_id,sender_id,content,payload,created_at').eq('conversation_id', conversationId).order('id', { ascending: false }).limit(30));
}
async function main() {
  // Exclusive output directory: never overwrite evidence from another run.
  if (!process.env.QA_OUT) throw new Error('missing QA_OUT');
  out = path.resolve(process.env.QA_OUT);
  await fs.mkdir(out, { recursive: false, mode: 0o700 });
  ownsOutput = true;
  const receipt = JSON.parse(await fs.readFile(process.env.QA_BUILD_RECEIPT, 'utf8'));
  config = readConfig(process.env, receipt);
  evidence.target = { origin: config.origin, expectedAppSha: config.appSha, userId: config.userId, replyTimeoutMs: config.timeoutMs };
  evidence.collectorSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  evidence.doctor.build = { source: 'external-reviewer-receipt', receipt, independentlyVerifiedByCollector: false };
  await fs.copyFile(process.env.QA_BUILD_RECEIPT, path.join(out, 'build-receipt.json'));
  const { createClient } = await import('@supabase/supabase-js');
  const { chromium } = await import('playwright');
  client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  stage = 'doctor-auth';
  const { data, error } = await client.auth.signInWithPassword({ email: process.env.QA_EMAIL, password: process.env.QA_PASSWORD });
  if (error || !data.session) throw new Error('dedicated account sign-in failed');
  const { data: verified, error: verifyError } = await client.auth.getUser();
  if (verifyError || verified.user?.id !== config.userId || verified.user?.email?.toLowerCase() !== process.env.QA_EMAIL.toLowerCase()) throw new Error('authenticated identity differs from dedicated account');
  evidence.doctor.authenticatedUserId = verified.user.id;
  const profile = await query(client.from('profiles').select('id,nickname').eq('id', config.userId).single());
  if (!profile?.nickname) throw new Error('test profile is not ready');
  // query-guard: bounded -- Existence probe only: any one prior message rejects this account; no history or total is inferred.
  const prior = await query(client.from('dm_messages').select('id').eq('sender_id', config.userId).limit(1));
  if (prior.length) throw new Error('fresh dedicated account required');
  evidence.doctor.priorUserMessageCount = 0;
  // Login is a declared setup shortcut, not proof of the login UI.
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0];
  const key = `sb-${ref}-auth-token`;
  const sessionValue = JSON.stringify(data.session);
  await context.addCookies([{ name: key, value: `base64-${Buffer.from(sessionValue).toString('base64')}`, url: config.origin, httpOnly: false, secure: config.origin.startsWith('https:'), sameSite: 'Lax' }]);
  await context.addInitScript(([k, v, origin]) => { if (location.origin === origin) localStorage.setItem(k, v); }, [key, sessionValue, config.origin]);
  page = await context.newPage();
  // No headers, cookies, request bodies, raw console messages or session state in artifacts.
  evidence.observations.network = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === config.origin && response.status() >= 400) evidence.observations.network.push({ path: url.pathname, status: response.status() });
  });
  page.on('pageerror', () => evidence.errors.push({ stage, kind: 'browser-pageerror' }));
  stage = 'doctor-ui';
  const response = await page.goto(config.origin, { waitUntil: 'domcontentloaded', timeout: 60000 });
  evidence.doctor.httpStatus = response?.status();
  if (!response?.ok() || new URL(page.url()).origin !== config.origin) throw new Error('target origin is not usable');
  const entry = page.getByTestId('genius-entry-button');
  await entry.waitFor({ state: 'visible', timeout: 20000 });
  if (!await entry.isEnabled()) throw new Error('genius entry disabled');
  await shot('00-home');
  stage = 'entry';
  await entry.click();
  evidence.actions.push({ kind: 'entry-click', at: new Date().toISOString() });
  await page.waitForURL(url => url.origin === config.origin && url.pathname.startsWith('/messages/'), { timeout: 20000 });
  if (new URL(page.url()).pathname !== `/messages/new-${BOT_ID}`) throw new Error('fresh bot draft required');
  const composer = page.getByPlaceholder('쪽지를 입력하세요...', { exact: true });
  await composer.waitFor({ state: 'visible' });
  const existingIds = await page.locator('[data-message-id]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-message-id')));
  evidence.observations.before = { path: new URL(page.url()).pathname, messageIds: existingIds };
  await shot('01-composer');
  stage = 'send';
  await composer.fill(config.question);
  await page.getByRole('button', { name: '쪽지 보내기', exact: true }).click();
  evidence.actions.push({ kind: 'send-click', at: new Date().toISOString(), question: config.question });
  // Never retry an uncertain send: a second click could duplicate a real message.
  const deadline = Date.now() + config.timeoutMs;
  let question, rows = [], replies = [], conversationId;
  stage = 'observe';
  while (Date.now() < deadline) {
    const route = new URL(page.url());
    const candidate = route.pathname.match(/^\/messages\/([0-9a-f-]{36})$/i)?.[1];
    if (candidate && route.origin === config.origin) {
      conversationId = candidate;
      rows = await sampleMessages(conversationId);
      question = rows.find(row => row.sender_id === config.userId && row.content === config.question && !existingIds.includes(String(row.id)) && Date.parse(row.created_at) >= Date.parse(evidence.actions.at(-1).at) - 2000);
      if (question) {
        replies = repliesTo(rows, question.id);
        if (replies.length) break;
      }
    }
    await wait(1000);
  }
  evidence.observations.conversationId = conversationId ?? null;
  evidence.observations.question = question ?? null;
  evidence.observations.replies = replies;
  evidence.observations.replyDeadlineReached = replies.length === 0;
  evidence.observations.sampledAt = new Date().toISOString();
  if (replies.length) {
    try {
      await page.waitForFunction(ids => ids.every(id => Array.from(document.querySelectorAll('[data-message-id]')).some(node => node.getAttribute('data-message-id') === id && node.getBoundingClientRect().height > 0)), replies.map(row => String(row.id)), { timeout: 10000 });
      evidence.observations.replyRendered = true;
    } catch { evidence.observations.replyRendered = false; }
  }
  evidence.observations.visibleMessages = await page.locator('[data-message-id]').evaluateAll(nodes => nodes.map(n => ({ id: n.getAttribute('data-message-id'), questionId: n.getAttribute('data-genius-question-id'), text: n.innerText, visible: n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0 })));
  await shot('02-result');
  // Account session is revoked below. Test messages remain for independent inspection.
  evidence.cleanup.retainedConversationId = conversationId ?? null;
  evidence.collectionFinished = true;
}
try { await main(); }
catch (error) {
  // Do not serialize arbitrary SDK/browser errors (may include secrets/URLs).
  evidence.errors.push({ stage, kind: error?.name ?? 'Error' });
  evidence.collectionFinished = false;
  process.exitCode = 2;
} finally {
  try { if (browser) await browser.close(); evidence.cleanup.browserClosed = true; }
  catch { evidence.errors.push({ stage: 'cleanup', kind: 'browser-close-failed' }); process.exitCode = 2; }
  try { if (client) { const { error } = await client.auth.signOut({ scope: 'local' }); if (error) throw error; } evidence.cleanup.runSessionRevoked = !!client; }
  catch { evidence.errors.push({ stage: 'cleanup', kind: 'signout-failed' }); process.exitCode = 2; }
  evidence.finishedAt = new Date().toISOString();
  evidence.counts = { sendClicks: evidence.actions.filter(a => a.kind === 'send-click').length, observedQuestions: evidence.observations.question ? 1 : 0, observedReplies: evidence.observations.replies?.length ?? 0, errors: evidence.errors.length };
  if (ownsOutput) {
    // Never write to a pre-existing directory, even after a startup failure.
    const contents = JSON.stringify(evidence, null, 2);
    await fs.writeFile(path.join(out, 'evidence.json'), contents, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(path.join(out, 'evidence.sha256'), fingerprint(contents) + '\n', { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ collectionFinished: evidence.collectionFinished ?? false, ...evidence.counts, verdict: 'NOT_EVALUATED' }));
}
