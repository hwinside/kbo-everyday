#!/usr/bin/env node
/**
 * Multi-iOS matrix runner for browserstack-keyboard-frames.mjs.
 *
 * Runs the gate against multiple BS device+OS combinations and aggregates
 * pass/fail. Sequential to avoid BS parallel-session quota exhaustion.
 *
 * Adds 100% confidence beyond the single-device run by exercising:
 *  - iOS 17 (current prod baseline for most users)
 *  - iOS 18 (emerging users)
 *  - The same gate also runs against iOS 26.4 sim via separate iOS sim path.
 *
 * Usage:
 *   PREVIEW_BASE=https://... node scripts/qa/browserstack-matrix.mjs
 */

import { spawn } from 'node:child_process';
import { readFileSync, copyFileSync } from 'node:fs';
import path from 'node:path';

const MATRIX = [
  { deviceName: 'iPhone 15', osVersion: '17' },
  { deviceName: 'iPhone 15', osVersion: '18' },
  { deviceName: 'iPhone 14', osVersion: '17' },
];

const previewBase = process.env.PREVIEW_BASE
  || 'https://kbo-everyday-6ikhjodoa-hwinsides-projects.vercel.app';
const gameId = process.env.GAME_ID || '20260505OBLG0';
const reportPath = path.resolve(`e2e/screenshots/keyboard-frames-report-${gameId}.json`);

function runOnce(env) {
  return new Promise((resolve) => {
    const proc = spawn('node', ['scripts/qa/browserstack-keyboard-frames.mjs'], {
      env: { ...process.env, ...env, PREVIEW_BASE: previewBase, GAME_ID: gameId },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    proc.stdout.on('data', (d) => { process.stdout.write(d); chunks.push(d); });
    proc.stderr.on('data', (d) => { process.stderr.write(d); chunks.push(d); });
    proc.on('close', (code) => {
      let report = null;
      try { report = JSON.parse(readFileSync(reportPath, 'utf8')); }
      catch { /* ignore */ }
      resolve({ exitCode: code, report });
    });
    proc.on('error', (err) => {
      console.error('spawn error:', err.message);
      resolve({ exitCode: -1, report: null });
    });
  });
}

const results = [];
for (const cfg of MATRIX) {
  console.log(`\n\n========================================`);
  console.log(`MATRIX RUN: ${cfg.deviceName} / iOS ${cfg.osVersion}`);
  console.log(`========================================\n`);
  const env = { BS_DEVICE: cfg.deviceName, BS_OS_VERSION: cfg.osVersion };
  const t0 = Date.now();
  const { exitCode, report } = await runOnce(env);
  const dt = Date.now() - t0;
  // Snapshot per-device report so a later device run does not overwrite this one.
  const slug = `${cfg.deviceName.replace(/\s+/g, '')}-iOS${cfg.osVersion}`;
  const perDevicePath = path.resolve(`e2e/screenshots/keyboard-frames-report-${gameId}-${slug}.json`);
  try { copyFileSync(reportPath, perDevicePath); } catch { /* ignore */ }
  const checks = report?.checks ?? null;
  const pass = report?.pass ?? false;
  results.push({ ...cfg, exitCode, pass, checks, durationMs: dt });
  console.log(`\n  → ${cfg.deviceName} iOS ${cfg.osVersion}: ${pass ? 'PASS' : 'FAIL'} (${dt}ms, exit ${exitCode})`);
  console.log(`    checks: ${JSON.stringify(checks)}`);
}

console.log(`\n\n========================================`);
console.log(`MATRIX SUMMARY`);
console.log(`========================================`);
let allPass = true;
for (const r of results) {
  console.log(`  ${r.pass ? '✓' : '✗'} ${r.deviceName} iOS ${r.osVersion}`);
  if (!r.pass) {
    allPass = false;
    console.log(`     exitCode=${r.exitCode} checks=${JSON.stringify(r.checks)}`);
  }
}
console.log(`\n  TOTAL: ${results.filter(r => r.pass).length}/${results.length} PASS`);
process.exit(allPass ? 0 : 1);
