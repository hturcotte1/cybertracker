// Pure logic for the CyberTracker checker: no network, no files.
// Everything here is covered by scripts/lib.test.mjs (run: npm test).

// Most → least serious. "news" means our own checks pass, but news outlets are
// reporting problems (e.g. a bank's site loads but customers can't log in).
export const STATUS_RANK = { unknown: 0, up: 1, news: 2, issues: 3, down: 4 };
export const STATUSES = Object.keys(STATUS_RANK);

/** The more serious of the given statuses. */
export function worst(...statuses) {
  return statuses.reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), 'unknown');
}

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Validate services.json and fill in defaults.
 * Returns { services, errors } — errors are human-readable strings.
 */
export function normalizeConfig(config) {
  const errors = [];
  const list = Array.isArray(config?.services) ? config.services : null;
  if (!list) return { services: [], errors: ['services.json needs a "services": [ ... ] list'] };

  const seen = new Set();
  const services = [];
  list.forEach((raw, i) => {
    const where = `services[${i}]${raw?.name ? ` (${raw.name})` : ''}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${where}: each service must be an object like {"name": ..., "url": ...}`);
      return;
    }
    if (!raw.name) errors.push(`${where}: missing "name"`);
    if (!raw.url) errors.push(`${where}: missing "url"`);
    else if (!isHttpUrl(raw.url)) errors.push(`${where}: "url" must start with https:// (got "${raw.url}")`);

    const id = raw.id ? slugify(raw.id) : slugify(raw.name || `service-${i}`);
    if (seen.has(id)) errors.push(`${where}: another service already uses the id "${id}" — add a unique "id"`);
    seen.add(id);

    // "checks": false → don't visit the site at all (news + official status only).
    let checks = [{ label: 'Website', url: raw.url }];
    if (raw.checks === false) {
      checks = [];
    } else if (raw.checks !== undefined) {
      if (!raw.checks || typeof raw.checks !== 'object' || Array.isArray(raw.checks)) {
        errors.push(`${where}: "checks" must look like {"Website": "https://…", "Sign-in": "https://…"} (or false)`);
      } else {
        checks = Object.entries(raw.checks).map(([label, url]) => ({ label, url }));
        for (const c of checks) {
          if (!isHttpUrl(c.url)) errors.push(`${where}: check "${c.label}" needs an https:// URL`);
        }
        if (!checks.length) errors.push(`${where}: "checks" is empty (use false to skip site checks)`);
      }
    }

    if (raw.statusPage && !isHttpUrl(raw.statusPage)) {
      errors.push(`${where}: "statusPage" must be an https:// URL`);
    }

    // News search terms. Default: the service name. false = ignore the news for this one.
    let news = [String(raw.name || '')].filter(Boolean);
    if (raw.news === false) news = [];
    else if (raw.news !== undefined) {
      if (!Array.isArray(raw.news) || raw.news.some((n) => typeof n !== 'string' || !n.trim())) {
        errors.push(`${where}: "news" must be a list of names to look for in headlines, like ["Schwab"]`);
      } else news = raw.news.map((n) => n.trim());
    }

    let manual = null;
    if (raw.manual) {
      if (!['down', 'issues', 'up'].includes(raw.manual.status)) {
        errors.push(`${where}: "manual.status" must be "down", "issues" or "up"`);
      } else {
        manual = { status: raw.manual.status, note: raw.manual.note ? String(raw.manual.note) : null };
      }
    }

    services.push({
      id,
      name: String(raw.name || id),
      category: String(raw.category || 'Other'),
      url: raw.url,
      statusPage: raw.statusPage || null,
      note: raw.note ? String(raw.note) : null,
      checks,
      news,
      manual,
    });
  });

  return { services, errors };
}

// ---------------------------------------------------------------------------
// Probe classification

/** Map a fetch() exception to a short failure kind. */
export function classifyError(err) {
  if (!err) return 'error';
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
  const cause = err.cause || {};
  const code = String(cause.code || err.code || '');
  const message = `${cause.message || ''} ${err.message || ''}`;
  if (/^(ENOTFOUND|EAI_AGAIN|EAI_NONAME|EAI_FAIL|EAI_NODATA)$/.test(code)) return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (/^(ECONNRESET|EPIPE|UND_ERR_SOCKET|UND_ERR_CLOSED|ECONNABORTED)$/.test(code)) return 'reset';
  if (/^(ENETUNREACH|EHOSTUNREACH|EHOSTDOWN|ENETDOWN)$/.test(code)) return 'unreachable';
  if (/^(UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|ETIMEDOUT)$/.test(code)) return 'timeout';
  if (/CERT|SSL|TLS/.test(code) || /certificate|self.signed|ssl routines/i.test(message)) return 'tls';
  // A redirect loop is almost always a cookie/bot check, not an outage: the server is answering.
  if (/redirect/i.test(message)) return 'redirects';
  return 'error';
}

const HTTP_TEXT = {
  500: 'Server error',
  502: 'Bad gateway',
  503: 'Service unavailable',
  504: 'Gateway timeout',
};

function seconds(ms) {
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
}

/** Plain-English sentence for a failed probe. */
export function describeFailure(probe) {
  switch (probe.kind) {
    case 'timeout':
      return `Not responding (no reply in ${seconds(probe.ms)})`;
    case 'dns':
      return 'Address not found (DNS failure)';
    case 'refused':
      return 'Refusing connections';
    case 'reset':
      return 'Connection dropped by the server';
    case 'unreachable':
      return 'Network unreachable';
    case 'tls':
      return 'Security certificate error';
    case 'http':
      return `${HTTP_TEXT[probe.code] || 'Server error'} (HTTP ${probe.code})`;
    default:
      return 'Connection failed';
  }
}

/**
 * Turn a raw probe outcome into { state, kind, reason }.
 *  - state "fail": a visitor would get an error page or nothing at all
 *  - state "slow": answered, but slower than slowMs
 *  - state "up":   answered. 4xx counts as up: the server is alive and just
 *                  refusing our robot (bot walls, rate limits, LinkedIn's 999…)
 */
export function classifyProbe({ code = null, ms = 0, kind = null, mitigated = false }, { slowMs = 8000 } = {}) {
  if (kind === 'redirects') {
    return { state: 'up', kind, reason: 'Responding (redirect loop for automated checks)' };
  }
  if (kind) {
    return { state: 'fail', kind, reason: describeFailure({ kind, ms, code }) };
  }
  if (code >= 500 && code <= 599 && !mitigated) {
    return { state: 'fail', kind: 'http', reason: describeFailure({ kind: 'http', code, ms }) };
  }
  if (ms > slowMs) {
    return { state: 'slow', kind: null, reason: `Very slow (${seconds(ms)} to respond)` };
  }
  if (code >= 400 || mitigated) {
    return { state: 'up', kind: null, reason: `Responding (HTTP ${code} to automated checks)` };
  }
  return { state: 'up', kind: null, reason: 'Responding normally' };
}

// ---------------------------------------------------------------------------
// Official status pages (Atlassian Statuspage format: /api/v2/summary.json)

/**
 * Minor incidents and maintenance are shown as notes but don't change the
 * status — big providers have small incidents almost every day.
 */
export function parseStatuspage(summary) {
  const indicator = summary?.status?.indicator;
  if (typeof indicator !== 'string') return null; // not a Statuspage-style API
  const incidents = (Array.isArray(summary.incidents) ? summary.incidents : [])
    .filter((i) => i && !['resolved', 'postmortem', 'completed'].includes(i.status))
    .slice(0, 3)
    .map((i) => ({
      name: String(i.name || 'Incident'),
      status: String(i.status || ''),
      impact: String(i.impact || ''),
      url: i.shortlink || null,
      updatedAt: i.updated_at || null,
    }));
  const maintenance = (Array.isArray(summary.scheduled_maintenances) ? summary.scheduled_maintenances : [])
    .some((m) => m?.status === 'in_progress');

  let status = 'up';
  if (indicator === 'critical') status = 'down';
  else if (indicator === 'major') status = 'issues';

  return {
    status,
    indicator,
    description: String(summary.status.description || ''),
    incidents,
    maintenance,
  };
}

// ---------------------------------------------------------------------------
// News headlines (Google News RSS)

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[e.toLowerCase()] ?? match;
  });
}

function xmlField(block, name) {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  let value = m[1].trim();
  const cdata = value.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) value = cdata[1];
  return decodeEntities(value).replace(/\s+/g, ' ').trim();
}

/** Minimal RSS reader: [{ title, source, url, publishedAt }]. */
export function parseRss(xml) {
  const items = [];
  for (const match of String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const block = match[0];
    let title = xmlField(block, 'title');
    const source = xmlField(block, 'source');
    const url = xmlField(block, 'link');
    const published = Date.parse(xmlField(block, 'pubDate'));
    // Google News titles end in " - Source Name"
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    if (!title || !/^https?:\/\//.test(url) || !Number.isFinite(published)) continue;
    items.push({ title, source: source || new URL(url).hostname, url, publishedAt: new Date(published).toISOString() });
  }
  return items;
}

// A headline is about an outage if it says so in plain words.
export const OUTAGE_RE =
  /\b(outages?|is down|are down|was down|were down|goes down|go down|going down|went down|gone down|down for (users|customers|thousands|millions|many|some|hours)|service (disruptions?|issues|problems)|disrupt(s|ed|ing|ions?)|not working|stopped working|offline|(can'?t|cannot|unable to) (log ?in|sign ?in|access|connect)|(log-?in|sign-?in|login) (issues|problems|errors|troubles?)|glitch(es|y)?|technical (issues?|problems?|difficulties|glitch)|system (issues|failures?|problems|outage)|internal server error)\b/i;

// Headlines that don't name a tracked service also need to be about tech, not
// "Vaccination is down" or "travel disruptions".
export const TECH_RE =
  /\b(networks?|websites?|sites?|apps?|online|internet|systems?|servers?|platforms?|cloud|e-?mail|banking|banks?|payments?|log ?in|sign ?in|users|customers|services?|computers?|software|data ?cent(er|re)s?|dns|wi-?fi|phones?|911|cell(ular)?|wireless|broadband|cyber|hack(ers?|ed)?)\b/i;

// Electricity/weather stories are a different kind of outage.
export const NOISE_RE =
  /\b(power (outages?|cuts?|failures?|restored|lines?|grid)|without power|blackouts?|electric(al|ity)?|utilit(y|ies)|planned outage|outage map|water (main|outage)|gas (leak|outage)|wildfire|hurricane|tornado|snowstorm|ice storm)\b/i;

// Follow-ups (the outage is over, or the story looks back at it) and evergreen
// explainers ("how to check if X is down") don't mean something is broken now.
export const RECOVERY_RE =
  /\b(restor(ed|es|ing)|resolv(ed|es|ing)|back (up|online|to normal)|recover(ed|s|ing|y)?|resum(ed|es|ing)|returns? to normal|normal operations|is over|(has |have )?ended|ends|fixed|caused|causes|cause (of|behind)|reveal(s|ed)?|explain(s|ed)?|taught|lessons?|underscores?|aftermath|post-?mortem|root cause|traced?|traces|blames?|after (an? |the |its |their )?([\w-]+ )?(outage|disruption|glitch)|how to (check|tell|know|fix|find out|see))\b/i;

// Outlets we'd rather quote when many are covering the same story.
const PREFERRED_SOURCES = [
  'reuters', 'associated press', 'ap news', 'bloomberg', 'the wall street journal', 'wsj', 'the new york times',
  'the washington post', 'cnn', 'cnbc', 'nbc news', 'cbs news', 'abc news', 'npr', 'bbc', 'axios', 'politico',
  'the verge', 'techcrunch', 'ars technica', 'wired', 'bleepingcomputer', 'the record', 'forbes', 'business insider',
  'usa today', 'fox business', 'fox news', 'engadget', 'cnet', 'zdnet', 'the guardian', 'financial times',
];

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Compile each service's news terms into one regex (whole words, any case). */
export function newsMatchers(services) {
  return services
    .filter((s) => s.news && s.news.length)
    .map((s) => ({
      id: s.id,
      re: new RegExp(`(?<![A-Za-z0-9])(${s.news.map(escapeRegExp).join('|')})(?![A-Za-z0-9])`, 'i'),
    }));
}

/** Roundup headlines ("Governor signs bill; Airline outage delays flights; …"): keep the outage part. */
export function focusTitle(title) {
  const parts = title.split(/\s*;\s+|\s+\|\s+|\s+•\s+/).filter(Boolean);
  if (parts.length < 2) return title;
  return parts.find((p) => OUTAGE_RE.test(p) && !NOISE_RE.test(p)) || title;
}

// Words that every outage headline shares; ignore them when comparing headlines.
const FILLER = new Set(
  ('outage outages down report reports reported says said sources source after amid over with from the and for its has have had was were ' +
    'are new latest users according what know here how why this that today now week day hours hour goes went gone going issues issue problems ' +
    'problem hit hits faces facing major massive widespread nationwide global worldwide again amid causing caused some many more').split(' '),
);

function words(title) {
  return new Set(
    title
      .toLowerCase()
      .replace(/[’'.]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !FILLER.has(w)),
  );
}

function similar(a, b) {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared || 1);
}

function isPreferred(source) {
  const s = String(source).toLowerCase();
  return PREFERRED_SOURCES.some((p) => s === p || s.startsWith(`${p} `));
}

/** The headline to quote: a well-known outlet if one is in the list, else the first given. */
function pickHeadline(items) {
  return items.find((i) => isPreferred(i.source)) || items[0];
}

export const NEWS_DEFAULTS = {
  windowHours: 24, // headlines older than this are dropped
  reportedHours: 3, // problem headlines this recent can mark a service "reported"...
  minSources: 2, // ...when at least this many different outlets carry them
  minSourcesAfterFix: 3, // ...or this many, if a story in the last day already said it was fixed
  maxStories: 30,
  perService: 3,
};

/**
 * Sort raw RSS items into:
 *  - stories: de-duplicated outage stories for the "In the news" panel
 *  - byService: service id → { headlines, reported }, where `reported` is set
 *    when several outlets are describing a live problem with that service
 */
/** Services a story is about: the most-mentioned first, at most four. */
function rankServices(list) {
  const counts = new Map();
  for (const item of list) {
    item.services.forEach((id, n) => counts.set(id, (counts.get(id) || 0) + (n === 0 ? 2 : 1)));
  }
  const top = Math.max(0, ...counts.values());
  return [...counts.entries()]
    .filter(([, c]) => c >= top / 4)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([id]) => id);
}

export function processNews(items, services, nowMs, opts = {}) {
  const o = { ...NEWS_DEFAULTS, ...opts };
  const matchers = newsMatchers(services);
  const floor = nowMs - o.windowHours * 3600e3;

  // Keep outage headlines from the window, newest first, one per link.
  const seen = new Set();
  const relevant = [];
  for (const item of items) {
    const t = Date.parse(item.publishedAt);
    const key = item.url || item.title;
    if (seen.has(key) || !(t >= floor) || t > nowMs + 3600e3) continue;
    seen.add(key);
    const title = focusTitle(item.title);
    if (!OUTAGE_RE.test(title) || NOISE_RE.test(title)) continue;
    // Every tracked service named in the headline, in the order they appear.
    const hits = matchers
      .map((m) => ({ id: m.id, at: title.search(m.re) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at);
    if (!hits.length && !TECH_RE.test(title)) continue;
    const tone = RECOVERY_RE.test(title) ? 'update' : 'problem';
    relevant.push({
      title, source: item.source, url: item.url, publishedAt: item.publishedAt, t, tone,
      services: hits.map((h) => h.id), primary: hits[0]?.id || null, words: words(title),
    });
  }
  relevant.sort((a, b) => b.t - a.t);

  // 1) Group syndicated / near-identical headlines.
  const clusters = [];
  for (const item of relevant) {
    let home = null;
    let best = 0;
    for (const c of clusters) {
      if (c.tone !== item.tone) continue;
      for (const other of c.items) {
        const score = similar(other.words, item.words);
        if (score > best) [best, home] = [score, c];
      }
    }
    if (home && best >= 0.45) home.items.push(item);
    else clusters.push({ tone: item.tone, items: [item] });
  }
  // 2) Coverage that's mainly about the same service (and same tone) is one story,
  //    however it's worded.
  const groups = new Map();
  clusters.forEach((c, i) => {
    const counts = new Map();
    for (const item of c.items) if (item.primary) counts.set(item.primary, (counts.get(item.primary) || 0) + 1);
    const primary = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const key = primary ? `${c.tone}:${primary}` : `cluster:${i}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...c.items);
  });

  const stories = [...groups.values()]
    .map((list) => {
      list.sort((a, b) => b.t - a.t);
      const quote = pickHeadline(list);
      return {
        title: quote.title,
        source: quote.source,
        url: quote.url,
        publishedAt: new Date(Math.min(...list.map((i) => i.t))).toISOString(),
        latestAt: list[0].publishedAt,
        sources: new Set(list.map((i) => i.source)).size,
        tone: list[0].tone,
        services: rankServices(list),
      };
    })
    .sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt))
    .slice(0, o.maxStories);

  const byService = new Map();
  for (const s of services) {
    const mine = relevant.filter((i) => i.services.includes(s.id)); // newest first
    if (!mine.length) continue;
    // Only problem reports newer than the latest "it's fixed" story count.
    const lastUpdate = mine.find((i) => i.tone === 'update');
    const start = Math.max(nowMs - o.reportedHours * 3600e3, lastUpdate ? lastUpdate.t + 1 : -Infinity);
    const live = mine.filter((i) => i.tone === 'problem' && i.t >= start);
    const outlets = new Set(live.map((i) => i.source));
    // Once an outage has been reported fixed, follow-up commentary keeps mentioning it, so ask
    // for more independent coverage before calling it broken again.
    const needed = lastUpdate ? o.minSourcesAfterFix : o.minSources;
    let reported = null;
    if (outlets.size >= needed) {
      const quote = pickHeadline(live);
      reported = {
        title: quote.title,
        source: quote.source,
        url: quote.url,
        publishedAt: quote.publishedAt,
        firstAt: new Date(Math.min(...live.map((i) => i.t))).toISOString(),
        sources: outlets.size,
      };
    }
    byService.set(s.id, {
      reported,
      headlines: mine.slice(0, o.perService).map(({ title, source, url, publishedAt, tone }) => ({ title, source, url, publishedAt, tone })),
    });
  }

  return { stories, byService };
}

/** Google News search queries: one broad sweep + one per category of tracked names. */
export function newsQueries(services, { maxTermsPerQuery = 14 } = {}) {
  const terms = '(outage OR "is down" OR "goes down" OR "went down" OR "not working" OR disruption OR glitch OR "technical issue")';
  const queries = [`(outage OR "is down" OR "goes down" OR "went down" OR "service disruption" OR "not working") when:6h`];
  const byCategory = new Map();
  for (const s of services) {
    if (!s.news?.length) continue;
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category).push(...s.news);
  }
  for (const names of byCategory.values()) {
    const unique = [...new Set(names)];
    for (let i = 0; i < unique.length; i += maxTermsPerQuery) {
      const chunk = unique.slice(i, i + maxTermsPerQuery).map((n) => `"${n.replace(/"/g, '')}"`);
      queries.push(`(${chunk.join(' OR ')}) ${terms} when:1d`);
    }
  }
  return queries;
}

// ---------------------------------------------------------------------------
// Verdict for one service

function lowerFirst(text) {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

/**
 * Combine site checks, the official status page, news coverage and a manual
 * override into one status.
 * Returns { status, detail, source } where source is
 * "checks" | "official" | "news" | "manual" | "none".
 */
export function combine({ probes = [], official = null, news = null, manual = null } = {}) {
  const fails = probes.filter((p) => p.state === 'fail');
  const slow = probes.filter((p) => p.state === 'slow');

  let status;
  let detail;
  let source = 'checks';

  if (!probes.length) {
    status = 'up';
    detail = 'No problems reported';
    source = 'none';
  } else if (fails.length === probes.length) {
    status = 'down';
    detail = fails[0].reason;
  } else if (fails.length) {
    status = 'issues';
    detail = `${fails[0].label}: ${lowerFirst(fails[0].reason)}`;
  } else if (slow.length) {
    status = 'issues';
    const label = slow.length === probes.length ? 'Very slow' : `${slow[0].label} is very slow`;
    detail = `${label} (${seconds(Math.max(...slow.map((p) => p.ms)))} to respond)`;
  } else {
    status = 'up';
    detail = 'Working normally';
  }

  if (official && STATUS_RANK[official.status] > STATUS_RANK[status]) {
    status = official.status;
    detail = official.incidents[0]?.name || official.description || 'Official status page reports a problem';
    source = 'official';
  }

  if (news?.reported && STATUS_RANK.news > STATUS_RANK[status]) {
    status = 'news';
    detail = news.reported.title;
    source = 'news';
  }

  if (manual?.status) {
    status = manual.status;
    if (manual.note) detail = manual.note;
    source = 'manual';
  }

  return { status, detail, source };
}

// ---------------------------------------------------------------------------
// History: carry state forward from the previous run

export const DEFAULTS = {
  historyHours: 48, // hourly buckets kept per service
  timelineHours: 48, // one point per run, for the "over time" chart
  eventDays: 7,
  maxEvents: 250,
};

const BUCKET_INDEX = { up: 0, news: 1, issues: 2, down: 3 };

/**
 * Merge this run's results into the previous status document.
 * `results` are service records that already have { id, name, status, detail, ... }.
 */
export function advance(prev, results, nowMs, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const nowIso = new Date(nowMs).toISOString();
  const nowSec = Math.floor(nowMs / 1000);
  const hour = Math.floor(nowSec / 3600) * 3600;
  const oldestHour = hour - (o.historyHours - 1) * 3600;

  const prevById = new Map((prev?.services || []).map((s) => [s.id, s]));
  const events = Array.isArray(prev?.events) ? [...prev.events] : [];

  const services = results.map((r) => {
    const p = prevById.get(r.id);
    const firstSeen = p?.firstSeen || nowIso;
    let since = nowIso;

    if (p && p.status === r.status && p.since) {
      since = p.since;
    } else if (p && p.status !== r.status && p.status !== 'unknown' && r.status !== 'unknown') {
      events.push({
        t: nowIso,
        id: r.id,
        name: r.name,
        category: r.category,
        from: p.status,
        to: r.status,
        detail: r.detail,
        lasted: p.since ? Math.max(0, Math.round((nowMs - Date.parse(p.since)) / 1000)) : null,
        sinceKnown: Boolean(p.since && p.since !== p.firstSeen),
      });
    }

    const buckets = new Map();
    for (const row of p?.history || []) {
      if (Array.isArray(row) && row.length === 5 && row[0] >= oldestHour) buckets.set(row[0], row.slice(1));
    }
    if (r.status in BUCKET_INDEX) {
      const b = buckets.get(hour) || [0, 0, 0, 0];
      b[BUCKET_INDEX[r.status]] += 1;
      buckets.set(hour, b);
    }
    const history = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([h, c]) => [h, ...c]);

    return { ...r, since, firstSeen, history };
  });

  const summary = { down: 0, issues: 0, news: 0, up: 0, unknown: 0, total: services.length };
  for (const s of services) summary[s.status] += 1;

  const timelineFloor = nowSec - o.timelineHours * 3600;
  const timeline = (Array.isArray(prev?.timeline) ? prev.timeline : [])
    .filter((row) => Array.isArray(row) && row.length === 5 && row[0] >= timelineFloor && row[0] < nowSec)
    .concat([[nowSec, summary.down, summary.issues, summary.news, summary.up]]);

  const eventFloor = nowMs - o.eventDays * 86400e3;
  const keptEvents = events.filter((e) => Date.parse(e.t) >= eventFloor).slice(-o.maxEvents);

  return {
    trackingSince: prev?.trackingSince || nowIso,
    summary,
    services,
    timeline,
    events: keptEvents,
  };
}

/** Run `fn` over `items` with at most `limit` in flight; keeps input order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
