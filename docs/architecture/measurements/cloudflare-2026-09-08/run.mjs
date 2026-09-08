import fs from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// Historical bounded measurement. See ../../cloudflare-update-check-measurement-2026-09-08.md.
const out = process.argv[2] ?? '/tmp/hot-updater-cloudflare-measurement';
fs.mkdirSync(out, { recursive: true });
const key = process.env.HOT_UPDATER_API_KEY;
if (!key) throw new Error('Load the existing v1 client API key from a private env file.');
const nil = '00000000-0000-0000-0000-000000000000';
const endpoints = {
  v0: { version: '0.35.2', base: process.env.BENCH_V0_BASE_URL, appVersion: '1.4.0', bundle: process.env.BENCH_V0_CURRENT_BUNDLE_ID, headers: {} },
  v1: { version: '1.0.0-rc.3', base: process.env.BENCH_V1_BASE_URL, appVersion: '1.5.0', bundle: process.env.BENCH_V1_CURRENT_BUNDLE_ID, headers: { 'x-api-key': key } },
};
for (const [name, endpoint] of Object.entries(endpoints)) {
  if (!endpoint.base || !endpoint.bundle) throw new Error(`Missing private benchmark configuration for ${name}`);
}
const rows = [];
let failures = 0;
const runId = new Date().toISOString();
async function request(name, index, phase) {
  const e = endpoints[name];
  const url = name === 'v0'
    ? `${e.base}/api/check-update/app-version/ios/${e.appVersion}/production/${nil}/${e.bundle}/${index % 1000 + 1}`
    : `${e.base}/release-catalogs/app-version/ios/cHJvZHVjdGlvbg/${e.appVersion}`;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let result;
  try {
    const res = await fetch(url, { headers: { ...e.headers, 'user-agent': 'HotUpdater-Bounded-Comparison/1.0' }, signal: AbortSignal.timeout(5000) });
    const headersMs = performance.now() - start;
    const body = await res.text();
    const ms = performance.now() - start;
    const json = JSON.parse(body);
    const valid = res.status === 200 && (name === 'v0' ? json === null : json.schemaVersion === 1 && json.releases.length === 1 && json.releases[0].bundleId === e.bundle && json.releases[0].rolloutCohortCount === 1000);
    result = { name, phase, index, startedAt, ms, headersMs, status: res.status, bytes: Buffer.byteLength(body), valid, cache: res.headers.get('cf-cache-status'), age: res.headers.get('age'), ray: res.headers.get('cf-ray'), etag: res.headers.get('etag') };
    if (!valid) failures++;
  } catch (e) {
    failures++;
    result = { name, phase, index, startedAt, ms: performance.now() - start, valid: false, error: e.name };
  }
  rows.push(result);
  return result;
}
for (let i = 0; i < 10; i++) {
  for (const name of ['v0', 'v1']) await request(name, i, 'warmup');
  if (failures) throw new Error('Warmup validation failed');
  await sleep(100);
}
const measuredStart = new Date().toISOString();
const tickStart = performance.now();
const active = { v0: new Set(), v1: new Set() };
let aborted = false;
for (let tick = 0; tick < 1000; tick++) {
  await sleep(Math.max(0, tickStart + tick * 100 - performance.now()));
  if (failures >= 3 || active.v0.size >= 5 || active.v1.size >= 5) { aborted = true; break; }
  const order = tick % 2 ? ['v1', 'v0'] : ['v0', 'v1'];
  for (const name of order) {
    const promise = request(name, tick, 'measured').finally(() => active[name].delete(promise));
    active[name].add(promise);
  }
  if (tick % 100 === 99) console.log(JSON.stringify({ tick: tick + 1, failures, inFlight: { v0: active.v0.size, v1: active.v1.size } }));
}
await Promise.all([...active.v0, ...active.v1]);
const measuredEnd = new Date().toISOString();
const quantile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summary = {};
for (const name of ['v0', 'v1']) {
  const samples = rows.filter(r => r.name === name && r.phase === 'measured');
  const values = samples.filter(r => r.valid).map(r => r.ms);
  const frequencies = field => samples.reduce((a, r) => { const k = r[field] ?? 'absent'; a[k] = (a[k] ?? 0) + 1; return a; }, {});
  summary[name] = { requests: samples.length, failures: samples.filter(r => !r.valid).length, meanMs: values.reduce((a, b) => a + b, 0) / values.length, p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95), p99Ms: quantile(values, 0.99), minMs: Math.min(...values), maxMs: Math.max(...values), cache: frequencies('cache'), bytes: frequencies('bytes'), colos: frequencies('ray') };
  summary[name].colos = samples.reduce((a, r) => { const k = r.ray?.split('-').at(-1) ?? 'unknown'; a[k] = (a[k] ?? 0) + 1; return a; }, {});
}
const metadata = { runId, measuredStart, measuredEnd, aborted, requestsPerSecondPerWorker: 10, maxConcurrencyPerWorker: 5, node: process.version, endpoints: Object.fromEntries(Object.entries(endpoints).map(([k, { version, appVersion }]) => [k, { version, appVersion }])), summary };
fs.writeFileSync(`${out}/requests.json`, JSON.stringify({ ...metadata, rows }, null, 2));
fs.writeFileSync(`${out}/summary.json`, JSON.stringify(metadata, null, 2));
console.log(JSON.stringify(metadata, null, 2));
