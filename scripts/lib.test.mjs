// Run with: npm test   (or: node --test scripts/lib.test.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  advance,
  classifyError,
  classifyProbe,
  combine,
  focusTitle,
  mapLimit,
  newsQueries,
  normalizeConfig,
  parseRss,
  parseStatuspage,
  processNews,
  worst,
} from './lib.mjs';

const NOW = Date.parse('2026-11-17T16:00:00Z');
const ago = (minutes) => new Date(NOW - minutes * 60e3).toISOString();

test('worst() picks the most serious status', () => {
  assert.equal(worst('up', 'down', 'issues'), 'down');
  assert.equal(worst('up', 'news'), 'news');
  assert.equal(worst('issues', 'news'), 'issues');
  assert.equal(worst(), 'unknown');
});

test('normalizeConfig fills defaults and reports mistakes in plain words', () => {
  const ok = normalizeConfig({
    services: [
      { name: 'Charles Schwab', category: 'Banking', url: 'https://www.schwab.com', news: ['Schwab'] },
      { name: 'Verizon', url: 'https://www.verizon.com', checks: false },
      { name: 'Bank', url: 'https://bank.example', checks: { Website: 'https://bank.example', 'Sign-in': 'https://login.bank.example' } },
    ],
  });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.services[0].id, 'charles-schwab');
  assert.deepEqual(ok.services[0].checks, [{ label: 'Website', url: 'https://www.schwab.com' }]);
  assert.deepEqual(ok.services[0].news, ['Schwab']);
  assert.equal(ok.services[1].category, 'Other');
  assert.deepEqual(ok.services[1].checks, []);
  assert.deepEqual(ok.services[1].news, ['Verizon']);
  assert.equal(ok.services[2].checks[1].label, 'Sign-in');

  const bad = normalizeConfig({
    services: [
      { name: 'No URL' },
      { name: 'Dup', url: 'https://a.example' },
      { name: 'Dup', url: 'ftp://b.example' },
      { name: 'Weird', url: 'https://c.example', checks: [], news: 'Weird', manual: { status: 'broken' } },
    ],
  });
  assert.equal(bad.errors.length, 6, bad.errors.join('\n'));
  assert.match(bad.errors.join('\n'), /missing "url"/);
  assert.match(bad.errors.join('\n'), /already uses the id "dup"/);
  assert.match(bad.errors.join('\n'), /must start with https/);
  assert.match(normalizeConfig({}).errors[0], /"services"/);
});

test('classifyError maps fetch failures to plain kinds', () => {
  const withCause = (code, message = 'fetch failed') => Object.assign(new TypeError(message), { cause: { code } });
  assert.equal(classifyError(Object.assign(new Error('x'), { name: 'TimeoutError' })), 'timeout');
  assert.equal(classifyError(withCause('ENOTFOUND')), 'dns');
  assert.equal(classifyError(withCause('ECONNREFUSED')), 'refused');
  assert.equal(classifyError(withCause('ECONNRESET')), 'reset');
  assert.equal(classifyError(withCause('UND_ERR_CONNECT_TIMEOUT')), 'timeout');
  assert.equal(classifyError(withCause('CERT_HAS_EXPIRED')), 'tls');
  assert.equal(classifyError(new TypeError('redirect count exceeded')), 'redirects');
  assert.equal(classifyError(new Error('???')), 'error');
});

test('classifyProbe: errors and 5xx fail, bot walls and 4xx still count as up', () => {
  assert.equal(classifyProbe({ code: 200, ms: 300 }).state, 'up');
  assert.equal(classifyProbe({ code: 403, ms: 300 }).state, 'up');
  assert.equal(classifyProbe({ code: 999, ms: 300 }).state, 'up'); // LinkedIn's bot wall
  assert.equal(classifyProbe({ code: 503, ms: 300 }).state, 'fail');
  assert.match(classifyProbe({ code: 503, ms: 300 }).reason, /Service unavailable \(HTTP 503\)/);
  assert.equal(classifyProbe({ code: 503, ms: 300, mitigated: true }).state, 'up'); // Cloudflare challenge
  assert.equal(classifyProbe({ code: 200, ms: 9000 }).state, 'slow');
  assert.equal(classifyProbe({ kind: 'timeout', ms: 12000 }).reason, 'Not responding (no reply in 12s)');
  assert.equal(classifyProbe({ kind: 'redirects', ms: 100 }).state, 'up');
});

test('parseStatuspage: only major/critical change the status', () => {
  const page = (indicator, incidents = []) => ({ status: { indicator, description: 'x' }, incidents });
  assert.equal(parseStatuspage(page('none')).status, 'up');
  assert.equal(parseStatuspage(page('minor')).status, 'up');
  assert.equal(parseStatuspage(page('major')).status, 'issues');
  assert.equal(parseStatuspage(page('critical')).status, 'down');
  assert.equal(parseStatuspage({ hello: 'world' }), null);
  const withIncidents = parseStatuspage(
    page('major', [
      { name: 'Login errors', status: 'investigating', shortlink: 'https://stspg.io/x' },
      { name: 'Old thing', status: 'resolved' },
    ]),
  );
  assert.deepEqual(withIncidents.incidents.map((i) => i.name), ['Login errors']);
});

const up = (label = 'Website') => ({ label, state: 'up', ms: 200, reason: 'Responding normally' });
const fail = (label = 'Website') => ({ label, state: 'fail', ms: 12000, reason: 'Not responding (no reply in 12s)' });

test('combine: site checks', () => {
  assert.deepEqual(combine({ probes: [up(), up('Sign-in')] }), { status: 'up', detail: 'Working normally', source: 'checks' });
  assert.equal(combine({ probes: [fail(), fail('Sign-in')] }).status, 'down');
  const partial = combine({ probes: [up(), fail('Sign-in')] });
  assert.equal(partial.status, 'issues');
  assert.equal(partial.detail, 'Sign-in: not responding (no reply in 12s)');
  assert.equal(combine({ probes: [{ label: 'Website', state: 'slow', ms: 9100, reason: '' }] }).detail, 'Very slow (9.1s to respond)');
  assert.deepEqual(combine({ probes: [] }), { status: 'up', detail: 'No problems reported', source: 'none' });
});

test('combine: official status, news and manual overrides', () => {
  const official = { status: 'issues', description: 'Partial outage', incidents: [{ name: 'Git operations degraded' }] };
  assert.deepEqual(combine({ probes: [up()], official }), { status: 'issues', detail: 'Git operations degraded', source: 'official' });
  assert.equal(combine({ probes: [fail()], official }).status, 'down'); // checks are worse: keep them

  const news = { reported: { title: 'Schwab website goes down', sources: 3 } };
  assert.deepEqual(combine({ probes: [up()], news }), { status: 'news', detail: 'Schwab website goes down', source: 'news' });
  assert.equal(combine({ probes: [fail()], news }).status, 'down'); // news never softens a real failure
  assert.equal(combine({ probes: [up()], news: { reported: null } }).status, 'up');

  const manual = { status: 'down', note: 'Confirmed by the company' };
  assert.deepEqual(combine({ probes: [up()], manual }), { status: 'down', detail: 'Confirmed by the company', source: 'manual' });
});

test('parseRss reads Google News items', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Chase bank hit with nationwide outage - NBC News</title><link>https://news.google.com/a</link>
      <pubDate>Mon, 17 Nov 2026 15:39:00 GMT</pubDate><source url="https://www.nbcnews.com">NBC News</source></item>
    <item><title><![CDATA[AT&amp;T &#8217;s network is down]]></title><link>https://news.google.com/b</link>
      <pubDate>Mon, 17 Nov 2026 15:00:00 GMT</pubDate></item>
    <item><title>No date</title><link>https://news.google.com/c</link></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    title: 'Chase bank hit with nationwide outage',
    source: 'NBC News',
    url: 'https://news.google.com/a',
    publishedAt: '2026-11-17T15:39:00.000Z',
  });
  assert.equal(items[1].title, 'AT&T ’s network is down');
  assert.equal(items[1].source, 'news.google.com');
});

test('focusTitle keeps the outage part of a roundup headline', () => {
  assert.equal(
    focusTitle('Governor signs budget; United Airlines outage delays departing flights; Snow expected'),
    'United Airlines outage delays departing flights',
  );
  assert.equal(focusTitle('Chase bank hit with nationwide outage'), 'Chase bank hit with nationwide outage');
});

const SERVICES = normalizeConfig({
  services: [
    { name: 'Charles Schwab', category: 'Banking', url: 'https://www.schwab.com', news: ['Schwab'] },
    { name: 'Chase', category: 'Banking', url: 'https://www.chase.com', news: ['Chase', 'JPMorgan'] },
    { name: 'NSA', category: 'Government', url: 'https://www.nsa.gov', news: ['NSA', 'N.S.A.'] },
  ],
}).services;
const item = (title, source, minutesAgo, n = Math.random()) => ({ title, source, url: `https://news.example/${n}`, publishedAt: ago(minutesAgo) });

test('processNews: several outlets reporting a live problem → reported', () => {
  const items = [
    item('Charles Schwab website goes down as users report issues', 'Business Insider', 30),
    item('Schwab clients report login problems', 'ThinkAdvisor', 20),
    item('Stewart Cink wins Charles Schwab Cup', 'ESPN', 10), // not about an outage
  ];
  const { byService, stories } = processNews(items, SERVICES, NOW);
  const schwab = byService.get('charles-schwab');
  assert.ok(schwab.reported);
  assert.equal(schwab.reported.sources, 2);
  assert.equal(schwab.reported.source, 'Business Insider'); // well-known outlet preferred
  assert.equal(schwab.headlines.length, 2);
  assert.equal(stories.length, 1);
  assert.deepEqual(stories[0].services, ['charles-schwab']);
  assert.equal(stories[0].sources, 2);
});

test('processNews: one outlet, old news, or a newer "fixed" story → not reported', () => {
  const single = processNews([item('Schwab website goes down', 'Blog', 10)], SERVICES, NOW);
  assert.equal(single.byService.get('charles-schwab').reported, null);

  const old = processNews([item('Schwab website goes down', 'A', 300), item('Schwab outage hits users', 'B', 290)], SERVICES, NOW);
  assert.equal(old.byService.get('charles-schwab').reported, null);

  const fixed = processNews(
    [
      item('Chase bank hit with nationwide outage', 'NBC News', 90),
      item('JPMorgan Chase outage frustrates customers', 'CBS News', 80),
      item('Chase says software bug that caused outage has been resolved', 'Business Insider', 40),
      item('Roundup: Chase outage delays payments', 'Local TV', 20), // only one outlet after the fix
    ],
    SERVICES,
    NOW,
  );
  assert.equal(fixed.byService.get('chase').reported, null);

  // After a "fixed" story, two follow-ups aren't enough; three fresh outlets are.
  const fixedThenTwo = processNews(
    [
      item('Chase says outage has been resolved', 'NBC News', 60),
      item('Chase goes down, but bitcoin stays', 'Newsletter', 20),
      item('JPMorgan faces banking outage: will risks rise?', 'Analyst Blog', 15),
    ],
    SERVICES,
    NOW,
  );
  assert.equal(fixedThenTwo.byService.get('chase').reported, null);
  const fixedThenThree = processNews(
    [
      item('Chase says outage has been resolved', 'NBC News', 60),
      item('Chase is down again for thousands of customers', 'CNN', 20),
      item('Chase outage returns', 'CBS News', 15),
      item('Chase app not working again', 'Reuters', 10),
    ],
    SERVICES,
    NOW,
  );
  assert.equal(fixedThenThree.byService.get('chase').reported.sources, 3);

  // Late coverage of the same (already fixed) outage doesn't count, however many outlets run it.
  const lateCoverage = processNews(
    [
      item('United Airlines system outage resolved', 'KSAT', 90),
      item('United Airlines outage delays departing flights', 'KGNU', 70),
      item('United Airlines grounds flights nationwide after widespread system outage', 'AeroXplorer', 12),
      item('United Airlines had a “widespread system outage,” 3 days after the FAA ground stop', '24/7 Wall St.', 6),
    ],
    normalizeConfig({ services: [{ name: 'United Airlines', url: 'https://www.united.com', news: ['United Airlines'] }] }).services,
    NOW,
  );
  assert.equal(lateCoverage.byService.get('united-airlines').reported, null);
});

test('processNews: drops power cuts and non-tech "is down" headlines, merges syndicated copies', () => {
  const items = [
    item('County power outage closes schools', 'Local', 10),
    item('Vaccination is down. Measles is up.', 'WSJ', 10),
    item("NSA's classified internal network is down, sources say", 'WPDE', 15),
    item("NSA's classified internal network is down, sources say", 'WKEF', 14),
    item('Classified N.S.A. network goes down, causing work disruptions', 'The New York Times', 12),
    item('Hospital confirms cyber incident behind ongoing system outage', 'My Keene Now', 5),
  ];
  const { stories, byService } = processNews(items, SERVICES, NOW);
  assert.deepEqual(stories.map((s) => s.sources), [1, 3]);
  const nsa = stories.find((s) => s.services.includes('nsa'));
  assert.equal(nsa.source, 'The New York Times'); // differently worded, same service → one story, quoting the best-known outlet
  assert.equal(byService.get('nsa').reported.sources, 3);
});

test('processNews: a headline counts for the service it is about, not every name in it', () => {
  const banks = normalizeConfig({
    services: [
      { name: 'Chase', url: 'https://www.chase.com', news: ['Chase', 'JPMorgan'] },
      { name: 'Bank of America', url: 'https://www.bankofamerica.com' },
      { name: 'Wells Fargo', url: 'https://www.wellsfargo.com' },
    ],
  }).services;

  // Stale multi-bank story + a newsletter aside about Chase: Wells Fargo isn't down.
  const aside = processNews(
    [
      item('Customers report outages at Chase, Bank of America and Wells Fargo', 'BBC', 120),
      item('Wells Fargo doubles down on bitcoin ETF, and Chase goes down, but bitcoin stays', 'Yahoo Finance', 30),
    ],
    banks,
    NOW,
  );
  assert.equal(aside.byService.get('wells-fargo').reported, null);
  assert.equal(aside.byService.get('chase').reported.sources, 2);

  // A genuine multi-bank outage: many outlets listing them adds up for each bank.
  const wave = processNews(
    ['CNN', 'CBS News', 'NBC News', 'Reuters'].map((outlet, n) =>
      item(`Chase, Bank of America, Wells Fargo customers report outage ${n}`, outlet, 20 + n),
    ),
    banks,
    NOW,
  );
  assert.equal(wave.byService.get('wells-fargo').reported.sources, 4);
  assert.equal(wave.byService.get('bank-of-america').reported.sources, 4);
});

test('newsQueries builds one broad search plus one per category', () => {
  const queries = newsQueries(SERVICES);
  assert.equal(queries.length, 3);
  assert.match(queries[0], /when:6h$/);
  assert.match(queries[1], /^\("Schwab" OR "Chase" OR "JPMorgan"\)/);
});

test('advance: keeps "since", logs changes, buckets history', () => {
  const t0 = NOW;
  const first = advance(null, [{ id: 'a', name: 'A', status: 'up', detail: 'ok' }], t0);
  assert.equal(first.services[0].since, new Date(t0).toISOString());
  assert.deepEqual(first.events, []);
  assert.deepEqual(first.summary, { down: 0, issues: 0, news: 0, up: 1, unknown: 0, total: 1 });
  assert.equal(first.timeline.length, 1);

  const t1 = t0 + 5 * 60e3;
  const second = advance(first, [{ id: 'a', name: 'A', status: 'up', detail: 'ok' }], t1);
  assert.equal(second.services[0].since, first.services[0].since);
  assert.deepEqual(second.services[0].history, [[Math.floor(t0 / 3600e3) * 3600, 2, 0, 0, 0]]);

  const t2 = t1 + 5 * 60e3;
  const third = advance(second, [{ id: 'a', name: 'A', status: 'down', detail: 'Not responding' }], t2);
  assert.equal(third.services[0].since, new Date(t2).toISOString());
  assert.equal(third.events.length, 1);
  assert.deepEqual(
    { from: third.events[0].from, to: third.events[0].to, lasted: third.events[0].lasted, sinceKnown: third.events[0].sinceKnown },
    { from: 'up', to: 'down', lasted: 600, sinceKnown: false },
  );
  assert.deepEqual(third.timeline.at(-1), [Math.floor(t2 / 1000), 1, 0, 0, 0]);

  // A day later, old buckets and timeline points fall off.
  const later = advance(third, [{ id: 'a', name: 'A', status: 'up', detail: 'ok' }], t2 + 49 * 3600e3);
  assert.equal(later.services[0].history.length, 1);
  assert.equal(later.timeline.length, 1);
  assert.equal(later.trackingSince, first.trackingSince);
});

test('mapLimit keeps order and limits concurrency', async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([30, 10, 20, 5], 2, async (ms, i) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((r) => setTimeout(r, ms));
    running -= 1;
    return i;
  });
  assert.deepEqual(out, [0, 1, 2, 3]);
  assert.equal(peak, 2);
});
