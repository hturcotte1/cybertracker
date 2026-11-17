#!/usr/bin/env node
// CyberTracker checker.
// Visits every service in services.json, reads official status pages and the news,
// and writes site/data/status.json (current status + history) for the website.
//
//   node scripts/check.mjs              # check everything, update site/data/status.json
//   node scripts/check.mjs --dry-run    # check everything, print results, save nothing
//   node scripts/check.mjs --only=github,charles-schwab
//
// Runs on Node 20+ with no dependencies. GitHub Actions runs it every ~5 minutes
// (.github/workflows/monitor.yml).

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NOISE_RE,
  OUTAGE_RE,
  advance,
  classifyError,
  classifyProbe,
  combine,
  mapLimit,
  newsQueries,
  normalizeConfig,
  parseRss,
  parseStatuspage,
  processNews,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'services.json');
const OUT_PATH = path.join(ROOT, 'site', 'data', 'status.json');
const NEWS_CACHE_PATH = path.join(ROOT, 'site', 'data', 'news-items.json');

const TIMEOUT_MS = 12_000; // no reply within this = "not responding"
const SLOW_MS = 8_000; // slower than this = "having issues"
const RETRY_DELAY_MS = 4_000; // a failed check is retried once before we believe it
const CONCURRENCY = 16;
const INTERVAL_MINUTES = 5; // shown on the site; keep in sync with the cron in monitor.yml
const NEWS_REFRESH_MINUTES = 10; // don't hammer Google News: reuse headlines for this long
const NEWS_KEEP_HOURS = 24;

// A regular browser identity: many sites hang up on obvious bots, which would
// look like an outage. Bot walls that still answer (403/429) count as "up".
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

// If none of these answer, the problem is the machine running the checks, not the internet.
const CANARIES = [
  'https://www.google.com/generate_204',
  'https://www.cloudflare.com/cdn-cgi/trace',
  'https://www.microsoft.com/',
];

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  }),
);
const DRY_RUN = args.has('dry-run');
const ONLY = typeof args.get('only') === 'string' ? new Set(args.get('only').split(',')) : null;
const FRESH_NEWS = args.has('fresh-news');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Site checks

async function probeOnce(check) {
  const started = performance.now();
  try {
    const res = await fetch(check.url, {
      redirect: 'follow',
      headers: HEADERS,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Math.round(performance.now() - started);
    res.body?.cancel().catch(() => {}); // headers are enough; don't download the page
    const mitigated = res.headers.has('cf-mitigated'); // Cloudflare bot challenge, not an outage
    return { ...check, code: res.status, ms, ...classifyProbe({ code: res.status, ms, mitigated }, { slowMs: SLOW_MS }) };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    const kind = classifyError(err);
    const raw = String(err.cause?.code || err.cause?.message || err.message || err).slice(0, 120);
    return { ...check, code: null, ms, error: raw, ...classifyProbe({ kind, ms }, { slowMs: SLOW_MS }) };
  }
}

async function probe(check) {
  const first = await probeOnce(check);
  if (first.state !== 'fail') return first;
  await sleep(RETRY_DELAY_MS);
  return { ...(await probeOnce(check)), retried: true };
}

async function readOfficialStatus(statusPage) {
  const api = new URL('/api/v2/summary.json', statusPage).href;
  try {
    const res = await fetch(api, {
      headers: { ...HEADERS, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.includes('json')) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    return parseStatuspage(await res.json());
  } catch {
    return null;
  }
}

async function inspect(service) {
  const [probes, official] = await Promise.all([
    Promise.all(service.checks.map(probe)),
    service.statusPage ? readOfficialStatus(service.statusPage) : Promise.resolve(null),
  ]);
  return { service, probes, official, checkedAt: new Date().toISOString() };
}

async function networkLooksHealthy() {
  const results = await Promise.all(CANARIES.map((url) => probeOnce({ label: 'canary', url })));
  return results.some((r) => r.state !== 'fail');
}

// ---------------------------------------------------------------------------
// News

async function searchGoogleNews(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.5' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new Error(`HTTP ${res.status}`);
  }
  return parseRss(await res.text());
}

/** Headlines from the last day, refreshed at most every NEWS_REFRESH_MINUTES. */
async function loadNewsItems(services, nowMs) {
  const cache = await readJson(NEWS_CACHE_PATH);
  const cacheAge = cache?.fetchedAt ? nowMs - Date.parse(cache.fetchedAt) : Infinity;
  if (!FRESH_NEWS && cacheAge < NEWS_REFRESH_MINUTES * 60e3 && Array.isArray(cache.items)) {
    return { items: cache.items, fetchedAt: cache.fetchedAt, refreshed: false };
  }

  const queries = newsQueries(services);
  const results = await mapLimit(queries, 3, (q) =>
    searchGoogleNews(q).then(
      (items) => ({ ok: true, items }),
      (err) => ({ ok: false, err }),
    ),
  );
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.warn(`  ! news: ${failed.length}/${queries.length} searches failed (${failed[0].err.message})`);
  if (failed.length === queries.length) {
    // Keep the last good headlines (the site shows how old they are) rather than claiming there's no news.
    return { items: cache?.items || [], fetchedAt: cache?.fetchedAt || null, refreshed: false };
  }

  // Merge with what we had, so a story doesn't vanish just because a search ranked it lower.
  const floor = nowMs - NEWS_KEEP_HOURS * 3600e3;
  const byUrl = new Map();
  for (const item of [...results.flatMap((r) => r.items || []), ...(cache?.items || [])]) {
    if (byUrl.has(item.url)) continue;
    if (!(Date.parse(item.publishedAt) >= floor)) continue;
    if (!OUTAGE_RE.test(item.title) || NOISE_RE.test(item.title)) continue;
    byUrl.set(item.url, { title: item.title, source: item.source, url: item.url, publishedAt: item.publishedAt });
  }
  const items = [...byUrl.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 400);
  const fetchedAt = new Date(nowMs).toISOString();
  if (!DRY_RUN && !ONLY) await writeJsonAtomic(NEWS_CACHE_PATH, { fetchedAt, items });
  return { items, fetchedAt, refreshed: true };
}

// ---------------------------------------------------------------------------

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function writeJsonAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(data) + '\n');
  await rename(tmp, file);
}

function printTable(services) {
  const icon = { down: '🔴', issues: '🟠', news: '🟡', up: '🟢', unknown: '⚪' };
  for (const s of services) {
    const checks = s.checks.map((c) => `${c.label} ${c.code ?? c.state} ${c.ms}ms`).join(' | ');
    const official = s.official ? ` | official: ${s.official.indicator}` : '';
    const news = s.news.length ? ` | news: ${s.news.length}` : '';
    console.log(`${icon[s.status]} ${s.name.padEnd(24)} ${s.status.padEnd(7)} ${s.detail.slice(0, 90)}  [${checks}${official}${news}]`);
  }
}

async function main() {
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.error(`::error title=services.json is broken::${err.message}`);
    process.exit(1);
  }

  const { services: allServices, errors } = normalizeConfig(config);
  if (errors.length) {
    for (const e of errors) console.error(`::error title=services.json::${e}`);
    process.exit(1);
  }
  const services = ONLY ? allServices.filter((s) => ONLY.has(s.id)) : allServices;

  if (!(await networkLooksHealthy())) {
    console.log('::warning title=Skipped this run::This machine cannot reach the internet right now, so results would be wrong. Keeping the last status.');
    return;
  }

  const started = Date.now();
  const [inspected, newsItems] = await Promise.all([
    mapLimit(services, CONCURRENCY, inspect),
    loadNewsItems(allServices, started),
  ]);
  const { stories, byService } = processNews(newsItems.items, allServices, Date.now());

  const results = inspected.map(({ service, probes, official, checkedAt }) => {
    const news = byService.get(service.id) || null;
    const verdict = combine({ probes, official, news, manual: service.manual });
    const primary = probes[0];
    return {
      id: service.id,
      name: service.name,
      category: service.category,
      url: service.url,
      statusPage: service.statusPage,
      note: service.note,
      ...verdict,
      latencyMs: primary && primary.state !== 'fail' ? primary.ms : null,
      checks: probes.map((p) => ({ label: p.label, url: p.url, state: p.state, code: p.code, ms: p.ms, reason: p.reason })),
      official,
      news: news?.headlines || [],
      reported: news?.reported || null,
      checkedAt,
    };
  });
  const durationMs = Date.now() - started;
  printTable(results);
  console.log(`\nNews: ${newsItems.items.length} outage headlines (${newsItems.refreshed ? 'refreshed' : 'cached'}), ${stories.length} stories`);

  if (DRY_RUN || ONLY) {
    for (const s of stories.slice(0, 12)) console.log(`  📰 ${s.publishedAt.slice(11, 16)} ${s.title} — ${s.source} (${s.sources} outlets)${s.services.length ? ` → ${s.services.join(', ')}` : ''}`);
    console.log(`\nChecked ${results.length} services in ${(durationMs / 1000).toFixed(1)}s (not saved).`);
    return;
  }

  const prev = await readJson(OUT_PATH);
  const next = advance(prev, results, Date.now());
  const repo = process.env.GITHUB_REPOSITORY || config.site?.repo || null;

  const doc = {
    version: 1,
    generatedAt: new Date().toISOString(),
    durationMs,
    intervalMinutes: INTERVAL_MINUTES,
    vantage: process.env.GITHUB_ACTIONS ? 'GitHub Actions servers' : 'a local test run',
    site: { ...(config.site || {}), repo },
    categories: Array.isArray(config.categories) ? config.categories : [...new Set(results.map((s) => s.category))],
    ...next,
    news: { fetchedAt: newsItems.fetchedAt, stories },
  };
  await writeJsonAtomic(OUT_PATH, doc);

  const { down, issues, news, up, total } = doc.summary;
  const line = `${down} down, ${issues} with issues, ${news} in the news, ${up} up (of ${total})`;
  console.log(`\n${line} — checked in ${(durationMs / 1000).toFixed(1)}s`);
  if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `summary=${line}\n`, { flag: 'a' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
