/* CyberTracker front end. No framework, no build step.
 * Reads data/status.json (written by scripts/check.mjs every ~5 minutes) and renders it.
 * Every string that comes from data is inserted with textContent, never as HTML. */
(() => {
  'use strict';

  const DATA_URL = 'data/status.json';
  const POLL_MS = 60_000;
  const STALE_AFTER_MIN = 20;
  const RECOVERED_WINDOW_MS = 3 * 3600e3;
  const FEED_PREVIEW = 6;

  const STATUS = {
    down: { label: 'Down', verb: 'Down', icon: 'x' },
    issues: { label: 'Having issues', verb: 'Having issues', icon: 'bang' },
    news: { label: 'In the news', verb: 'In the news', icon: 'news' },
    up: { label: 'Working', verb: 'Working', icon: 'check' },
    unknown: { label: 'Unknown', verb: 'Unknown', icon: 'q' },
  };
  const PROBLEMS = ['down', 'issues', 'news'];
  const RANK = { unknown: 0, up: 1, news: 2, issues: 3, down: 4 };

  // Static icon markup (constants only, never data).
  const ICONS = {
    x: '<path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>',
    bang: '<path d="M12 5.5v8.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="18.6" r="1.9" fill="currentColor"/>',
    news: '<path d="M4.5 6h11v12.5H7A2.5 2.5 0 0 1 4.5 16V6Z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M15.5 9.5h4v6.5a2.5 2.5 0 0 1-2.5 2.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M8 10h4.5M8 13.5h4.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    check: '<path d="m5.5 12.5 4.2 4.2L18.5 7.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>',
    q: '<path d="M9.3 9.3a2.7 2.7 0 1 1 3.9 2.4c-.7.4-1.2 1-1.2 1.8v.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="18.3" r="1.6" fill="currentColor"/>',
    close: '<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    ext: '<path d="M14 5h5v5M19 5l-8 8M10 6H6a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    sun: '<circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    moon: '<path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z" fill="currentColor"/>',
  };

  const state = {
    doc: null,
    byId: new Map(),
    recovered: new Map(),
    category: 'all',
    query: '',
    you: new Map(),
    expanded: { stories: false, changes: false },
    fetchFailed: false,
    pending: false,
    firstRender: true,
  };

  // ---------------------------------------------------------------------------
  // Small helpers

  const $ = (sel, root = document) => root.querySelector(sel);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  /** replaceChildren() that skips null/false instead of printing them as text. */
  function fill(node, ...kids) {
    node.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false));
    return node;
  }

  function svg(tag, attrs, text) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name) {
    const node = document.createElementNS(SVG_NS, 'svg');
    node.setAttribute('viewBox', '0 0 24 24');
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = ICONS[name];
    return node;
  }

  const statusIcon = (status, extra = '') => el('span', { class: `status-icon s-${status} ${extra}`.trim(), 'aria-hidden': 'true' }, icon(STATUS[status].icon));
  const pill = (status) => el('span', { class: `pill s-${status}` }, statusIcon(status), STATUS[status].label);

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  function safeUrl(url) {
    try {
      const u = new URL(url, location.href);
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch {
      return null;
    }
  }

  function extLink(href, label, cls) {
    const url = safeUrl(href);
    if (!url) return null;
    return el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: cls }, label);
  }

  function ago(ms) {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? '' : 's'} ago`;
  }

  function duration(sec) {
    if (sec < 60) return 'under a minute';
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    const d = Math.floor(h / 24);
    return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
  }

  function clock(ms) {
    const d = new Date(ms);
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  }

  const hourLabel = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric' });
  const plural = (n, one, many) => (n === 1 ? one : many);

  function initials(name) {
    const parts = String(name).replace(/[^A-Za-z0-9 &.]/g, ' ').split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function toast(message) {
    const t = $('#toast');
    t.textContent = message;
    t.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  const storage = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* private mode etc. */
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Data

  async function load() {
    try {
      const res = await fetch(`${DATA_URL}?v=${Math.floor(Date.now() / 30000)}`, { cache: 'no-store' });
      if (res.status === 404) {
        state.fetchFailed = false;
        renderPending();
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const doc = await res.json();
      if (!doc || !Array.isArray(doc.services)) throw new Error('Unexpected data');
      state.fetchFailed = false;
      state.pending = false;
      if (state.doc && state.doc.generatedAt === doc.generatedAt) {
        renderClock();
        return;
      }
      const prev = state.doc;
      state.doc = doc;
      state.byId = new Map(doc.services.map((s) => [s.id, s]));
      render(prev);
    } catch (err) {
      state.fetchFailed = true;
      if (!state.doc) renderError();
      else renderClock();
    }
  }

  const problemCount = (summary) => summary.down + summary.issues + summary.news;

  function bySeverity(a, b) {
    return RANK[b.status] - RANK[a.status] || Date.parse(b.since) - Date.parse(a.since);
  }

  function matches(s) {
    if (state.category !== 'all' && s.category !== state.category) return false;
    if (!state.query) return true;
    const q = state.query;
    return s.name.toLowerCase().includes(q) || s.category.toLowerCase().includes(q) || hostOf(s.url).includes(q);
  }

  function computeRecovered() {
    state.recovered = new Map();
    const now = Date.parse(state.doc.generatedAt);
    for (const e of state.doc.events || []) {
      if (e.to !== 'up' || !['down', 'issues'].includes(e.from)) continue;
      const t = Date.parse(e.t);
      if (now - t > RECOVERED_WINDOW_MS) continue;
      const s = state.byId.get(e.id);
      if (s && s.status === 'up') state.recovered.set(e.id, e);
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function render(prev) {
    computeRecovered();
    renderMeta();
    renderHero();
    renderChart();
    renderChips();
    renderKey();
    renderBoard(prev);
    renderStories();
    renderChanges(prev);
    renderClock();
    if (state.firstRender) {
      state.firstRender = false;
      openFromHash();
    } else if ($('#detail').open && state.detailId) {
      fillDetail(state.detailId);
    }
  }

  function renderPending() {
    state.pending = true;
    $('#hero-badge').className = 'hero-badge';
    $('#hero-badge').textContent = '…';
    $('#hero-text').textContent = 'Getting ready: the first check is running';
    $('#hero-names').textContent = 'Results appear within a few minutes of setup. This page refreshes by itself.';
    $('#updated').textContent = 'Waiting for the first check';
    $('#stats').replaceChildren();
    $('#chart').replaceChildren(el('p', { class: 'chart-empty' }, 'The chart fills in as checks run.'));
  }

  function renderError() {
    $('#hero-badge').className = 'hero-badge';
    $('#hero-badge').textContent = '!';
    $('#hero-text').textContent = "Can't load the tracker data right now";
    $('#hero-names').textContent = 'Retrying every minute.';
    $('#live').classList.add('is-offline');
    $('#updated').textContent = 'Offline';
  }

  function renderMeta() {
    const { doc } = state;
    const n = problemCount(doc.summary);
    const worstStatus = doc.summary.down ? 'down' : doc.summary.issues ? 'issues' : doc.summary.news ? 'news' : 'up';
    document.title = n ? `(${n}) What's down right now · CyberTracker` : "Everything's up · CyberTracker";

    const colors = { down: '#d03b3b', issues: '#ec835a', news: '#fab219', up: '#0ca30c' };
    const mark = document.querySelector('.brand-mark');
    if (mark) mark.style.setProperty('--brand-dot', colors[worstStatus]);
    const fav =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0b0b0b"/>` +
      `<path d="M5 17h5l3-7 5 13 3-6h6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>` +
      `<circle cx="25" cy="7" r="5" fill="${colors[worstStatus]}" stroke="#0b0b0b" stroke-width="2"/></svg>`;
    $('#favicon').href = `data:image/svg+xml,${encodeURIComponent(fav)}`;

    const notice = $('#notice');
    const text = doc.site?.notice;
    notice.hidden = !text;
    notice.textContent = text || '';

    const repo = doc.site?.repo;
    if (repo && /^[\w.-]+\/[\w.-]+$/.test(repo)) {
      const base = `https://github.com/${repo}`;
      $('#repo-link').href = base;
      $('#add-service-link').href = `${base}/issues/new?template=add-service.yml`;
      $('#issue-link').href = `${base}/issues/new`;
    }
  }

  function renderHero() {
    const { summary, services } = state.doc;
    const n = problemCount(summary);
    const worstStatus = summary.down ? 'down' : summary.issues ? 'issues' : summary.news ? 'news' : 'up';

    const badge = $('#hero-badge');
    badge.className = `hero-badge s-${worstStatus}${summary.down ? ' pulse' : ''}`;
    badge.replaceChildren(n ? String(n) : icon('check'));

    const heroText = $('#hero-text');
    fill(
      heroText,
      n ? el('span', { class: 'visually-hidden' }, `${n} `) : null,
      n ? `${plural(n, 'service has', 'services have')} problems right now` : 'Everything we track is working',
    );

    const names = $('#hero-names');
    names.replaceChildren();
    if (n) {
      const parts = PROBLEMS.filter((st) => summary[st]).map((st) => {
        const list = services.filter((s) => s.status === st).sort(bySeverity);
        const shown = list.slice(0, 3).map((s) => el('strong', null, s.name));
        const joined = [];
        shown.forEach((node, i) => joined.push(i ? ', ' : '', node));
        if (list.length > 3) joined.push(` +${list.length - 3} more`);
        return [`${STATUS[st].label}: `, ...joined];
      });
      parts.forEach((p, i) => names.append(...(i ? [' · '] : []), ...p));
    } else {
      names.textContent = `All ${summary.total} services are answering normally, and none are in outage news right now.`;
    }

    const stats = $('#stats');
    stats.replaceChildren(
      ...['down', 'issues', 'news', 'up'].map((st) =>
        el(
          'a',
          { class: `stat${summary[st] ? '' : ' is-zero'}`, href: `#${st}`, role: 'listitem', onclick: (e) => jumpTo(e, st) },
          statusIcon(st),
          el('span', { class: 'stat-value' }, String(summary[st] + (st === 'up' ? summary.unknown || 0 : 0))),
          el('span', { class: 'stat-label' }, st === 'up' ? 'Working' : STATUS[st].label),
        ),
      ),
    );
  }

  function jumpTo(event, status) {
    const target = $(`#${status}`);
    if (!target || target.hidden) {
      event.preventDefault();
      if (status !== 'up') toast(`Nothing is ${STATUS[status].label.toLowerCase()} right now`);
      return;
    }
    if (state.category !== 'all' || state.query) {
      state.category = 'all';
      state.query = '';
      $('#q').value = '';
      renderChips();
      renderBoard();
      renderStories();
      renderChanges();
    }
  }

  function renderChips() {
    const { services } = state.doc;
    const ordered = [...(state.doc.categories || [])];
    for (const s of services) if (!ordered.includes(s.category)) ordered.push(s.category);
    const cats = ordered.filter((c) => services.some((s) => s.category === c));
    const chip = (value, label, list) => {
      const top = list.reduce((w, s) => (RANK[s.status] > RANK[w] ? s.status : w), 'up');
      return el(
        'button',
        {
          type: 'button',
          class: `chip s-${top}`,
          'aria-pressed': String(state.category === value),
          onclick: () => {
            state.category = state.category === value && value !== 'all' ? 'all' : value;
            renderChips();
            renderBoard();
            renderStories();
            renderChanges();
          },
        },
        PROBLEMS.includes(top) ? el('span', { class: 'chip-dot', title: `Something here is ${STATUS[top].label.toLowerCase()}` }) : null,
        label,
        el('span', { class: 'n' }, String(list.length)),
      );
    };
    $('#chips').replaceChildren(chip('all', 'All', services), ...cats.map((c) => chip(c, c, services.filter((s) => s.category === c))));
  }

  function renderKey() {
    const key = $('#status-key');
    if (key.childElementCount) return;
    const items = [
      ['down', 'Down'],
      ['issues', 'Having issues'],
      ['news', 'In the news'],
      ['up', 'Working'],
      ['none', 'No data yet'],
    ];
    key.append(
      el('span', null, 'Bars show the last 24 hours, one per hour:'),
      ...items.map(([st, label]) => el('span', { class: 'key-item' }, el('span', { class: `key-swatch s-${st}` }), label)),
    );
  }

  // ---- Board ----

  function renderBoard(prev) {
    const prevById = prev ? new Map(prev.services.map((s) => [s.id, s])) : null;
    const list = state.doc.services.filter(matches);
    const groups = { down: [], issues: [], news: [], up: [] };
    for (const s of list) (groups[s.status] || groups.up).push(s);

    for (const st of PROBLEMS) {
      const section = $(`#${st}`);
      const items = groups[st].sort((a, b) =>
        st === 'news'
          ? (b.reported?.sources || 0) - (a.reported?.sources || 0) || Date.parse(b.since) - Date.parse(a.since)
          : Date.parse(b.since) - Date.parse(a.since),
      );
      section.hidden = items.length === 0;
      $('.count', section).textContent = String(items.length);
      $('.cards', section).replaceChildren(...items.map((s) => card(s, prevById && prevById.get(s.id)?.status !== s.status)));
    }

    const up = $('#up');
    up.hidden = groups.up.length === 0;
    $('.count', up).textContent = String(groups.up.length);
    const order = [...(state.doc.categories || [])];
    for (const s of groups.up) if (!order.includes(s.category)) order.push(s.category);
    $('.tile-groups', up).replaceChildren(
      ...order
        .map((cat) => {
          const items = groups.up.filter((s) => s.category === cat);
          if (!items.length) return null;
          items.sort((a, b) => (state.recovered.has(b.id) ? 1 : 0) - (state.recovered.has(a.id) ? 1 : 0));
          return el('div', { class: 'tile-group' }, el('h3', null, cat), el('div', { class: 'tiles' }, items.map(tile)));
        })
        .filter(Boolean),
    );

    const none = $('#no-match');
    none.hidden = list.length > 0;
    if (!list.length) {
      const repo = state.doc.site?.repo;
      fill(
        none,
        `Nothing matches “${state.query || state.category}”. `,
        repo ? el('a', { href: `https://github.com/${repo}/issues/new?template=add-service.yml` }, 'Suggest a service to track') : null,
      );
    }
  }

  function logo(s, small) {
    const box = el('span', { class: `logo${small ? ' sm' : ''}`, 'aria-hidden': 'true' });
    const host = hostOf(s.url);
    const mono = () => {
      box.classList.add('mono');
      box.replaceChildren(initials(s.name));
    };
    if (!host) {
      mono();
      return box;
    }
    const img = el('img', {
      src: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
      alt: '',
      width: small ? 16 : 24,
      height: small ? 16 : 24,
      loading: 'lazy',
      decoding: 'async',
      referrerpolicy: 'no-referrer',
    });
    img.addEventListener('error', mono, { once: true });
    box.append(img);
    return box;
  }

  function sinceLine(s) {
    // For news reports, what matters is when the coverage started, not when we noticed it.
    if (s.status === 'news' && s.reported?.firstAt) {
      const first = Date.parse(s.reported.firstAt);
      return el('p', { class: 'card-since' }, 'First reported ', el('strong', { 'data-since': first }, duration((Date.now() - first) / 1000)), ` ago · ${clock(first)}`);
    }
    const since = Date.parse(s.since);
    const secs = Math.max(0, (Date.now() - since) / 1000);
    // If it was already like this when tracking began, we don't know the real start.
    if (s.firstSeen && s.since === s.firstSeen) {
      return secs < 3600
        ? el('p', { class: 'card-since' }, `${STATUS[s.status].verb} since at least ${clock(since)}`)
        : el('p', { class: 'card-since' }, `${STATUS[s.status].verb} for at least `, el('strong', { 'data-since': since }, duration(secs)), ` · since ${clock(since)}`);
    }
    return el('p', { class: 'card-since' }, `${STATUS[s.status].verb} for `, el('strong', { 'data-since': since }, duration(secs)), ` · since ${clock(since)}`);
  }

  function detailNode(s, cls) {
    if (s.source === 'news' && s.reported) {
      const r = s.reported;
      return el(
        'p',
        { class: cls },
        extLink(r.url, `“${r.title}”`, 'quote') || `“${r.title}”`,
        el('span', { class: 'src' }, `${r.source}${r.sources > 1 ? ` · ${r.sources} outlets reporting in the last 3 hours` : ''}`),
      );
    }
    if (s.source === 'official') return el('p', { class: cls }, `Official status page: ${s.detail}`);
    if (s.source === 'manual') return el('p', { class: cls }, s.detail, el('span', { class: 'src' }, 'Confirmed by the tracker maintainer'));
    return el('p', { class: cls }, s.detail);
  }

  function card(s, isNew) {
    const extra = [];
    if (s.note) extra.push(el('p', { class: 'card-note' }, s.note));
    if (s.official?.incidents?.length && s.source !== 'official') {
      extra.push(el('p', { class: 'card-note' }, `Official status page: ${s.official.incidents[0].name}`));
    }
    const problemNews = s.reported || (s.news || []).find((h) => h.tone === 'problem');
    if (s.source !== 'news' && problemNews) {
      extra.push(el('p', { class: 'card-note' }, 'In the news: ', extLink(problemNews.url, `“${problemNews.title}”`) || problemNews.title, ` (${problemNews.source})`));
    }

    return el(
      'article',
      { class: `card s-${s.status}${isNew ? ' is-new' : ''}`, id: `svc-${s.id}` },
      el(
        'div',
        { class: 'card-top' },
        logo(s),
        el(
          'div',
          { class: 'card-title' },
          el('h3', null, el('button', { type: 'button', class: 'name-btn', onclick: () => openDetail(s.id) }, s.name)),
          el('p', { class: 'card-cat' }, s.category),
        ),
        pill(s.status),
      ),
      detailNode(s, 'card-detail'),
      sinceLine(s),
      extra,
      strip(s, 24),
      el('div', { class: 'strip-scale', 'aria-hidden': 'true' }, el('span', null, '24h ago'), el('span', null, 'Now')),
      el(
        'div',
        { class: 'card-actions' },
        extLink(s.url, 'Visit site'),
        s.statusPage ? extLink(s.statusPage, 'Official status') : null,
        el('button', { type: 'button', class: 'text-btn', onclick: () => openDetail(s.id) }, 'Details'),
      ),
      youLine(s.id),
    );
  }

  function tile(s) {
    const rec = state.recovered.get(s.id);
    let meta;
    if (rec) meta = [statusIcon('up', 'sm'), `Back up ${ago(Date.parse(rec.t))}`];
    else if (s.status === 'unknown') meta = ['Not checked yet'];
    else if (!s.checks?.length) meta = [el('span', { class: 'ok' }), 'No outage reports'];
    else if (s.official?.incidents?.length) meta = [el('span', { class: 'ok' }), 'Minor incident noted'];
    else meta = [el('span', { class: 'ok' }), 'Responding'];

    return el(
      'button',
      { type: 'button', class: `tile${rec ? ' is-recovered' : ''}`, id: `svc-${s.id}`, onclick: () => openDetail(s.id), 'aria-label': `${s.name}: ${rec ? 'back up' : 'working'}. Show details` },
      logo(s, true),
      el('span', { class: 'tile-name' }, s.name),
      el('span', { class: 'tile-meta' }, meta),
      strip(s, 24, 'mini'),
      youLine(s.id),
    );
  }

  // ---- History strips ----

  function bucketStatus(row) {
    if (!row) return 'none';
    const [, up, news, issues, down] = row;
    if (down) return 'down';
    if (issues) return 'issues';
    if (news) return 'news';
    if (up) return 'up';
    return 'none';
  }

  function bucketTip(hourSec, row, status) {
    const span = `${hourLabel(hourSec * 1000)}–${hourLabel((hourSec + 3600) * 1000)}`;
    if (!row) return `${span}: no data`;
    const [, up, news, issues, down] = row;
    const total = up + news + issues + down;
    const bits = [];
    if (down) bits.push(`down in ${down} of ${total} checks`);
    if (issues) bits.push(`issues in ${issues} of ${total}`);
    if (news) bits.push(`in the news for ${news} of ${total}`);
    if (!bits.length) bits.push(`working (${total} ${plural(total, 'check', 'checks')})`);
    return `${span}: ${bits.join(', ')}`;
  }

  function strip(s, hours, cls = '') {
    const nowHour = Math.floor(Date.parse(state.doc.generatedAt) / 3600e3) * 3600;
    const rows = new Map((s.history || []).map((r) => [r[0], r]));
    const counts = { down: 0, issues: 0, news: 0, up: 0, none: 0 };
    const wrap = el('div', { class: `strip ${cls}`.trim(), role: 'img' });
    wrap.style.setProperty('--cells', hours);
    for (let k = hours - 1; k >= 0; k--) {
      const h = nowHour - k * 3600;
      const row = rows.get(h);
      const st = bucketStatus(row);
      counts[st] += 1;
      wrap.append(el('span', { class: `cell s-${st}`, 'data-tip': bucketTip(h, row, st) }));
    }
    const parts = [];
    if (counts.down) parts.push(`down during ${counts.down} ${plural(counts.down, 'hour', 'hours')}`);
    if (counts.issues) parts.push(`issues during ${counts.issues} ${plural(counts.issues, 'hour', 'hours')}`);
    if (counts.news) parts.push(`in the news during ${counts.news} ${plural(counts.news, 'hour', 'hours')}`);
    if (counts.up) parts.push(`working ${parts.length ? 'the rest' : 'the whole time'}`);
    if (counts.none) parts.push(`no data for ${counts.none} ${plural(counts.none, 'hour', 'hours')}`);
    wrap.setAttribute('aria-label', `Last ${hours} hours: ${parts.join(', ')}`);
    return wrap;
  }

  // ---- Feeds ----

  function storyMatches(story) {
    if (state.category === 'all' && !state.query) return true;
    const ids = story.services || [];
    if (ids.some((id) => state.byId.has(id) && matches(state.byId.get(id)))) return true;
    return state.category === 'all' && state.query && story.title.toLowerCase().includes(state.query);
  }

  function serviceTags(ids) {
    const tags = ids
      .map((id) => state.byId.get(id))
      .filter(Boolean)
      .map((s) => el('button', { type: 'button', class: 'tag', onclick: () => openDetail(s.id) }, s.name));
    return tags.length ? el('div', { class: 'tags' }, tags) : null;
  }

  function renderStories() {
    const panel = $('#stories');
    const news = state.doc.news;
    const stories = (news?.stories || []).filter(storyMatches);
    const shown = state.expanded.stories ? stories : stories.slice(0, FEED_PREVIEW);
    const searched = news?.fetchedAt ? Date.parse(news.fetchedAt) : null;
    const newsDown = !searched || Date.now() - searched > 60 * 60e3;
    $('#stories-sub').textContent = !searched
      ? "News search hasn't worked yet, so headlines may be missing."
      : newsDown
        ? `News search is behind: last searched ${ago(searched)}.`
        : `Outage headlines from the last 24 hours · searched ${ago(searched)}`;

    const items = shown.map((st) => {
      const published = Date.parse(st.publishedAt);
      const latest = Date.parse(st.latestAt || st.publishedAt);
      const title = extLink(st.url, st.title) || st.title;
      return el(
        'li',
        null,
        el('span', { class: `mark ${st.tone === 'update' ? 's-update' : 's-news'}`, title: st.tone === 'update' ? 'Follow-up or recovery' : 'Problem report' }),
        el(
          'div',
          null,
          el('p', { class: 'what' }, title),
          el(
            'p',
            { class: 'meta' },
            el('span', null, st.source),
            st.sources > 1 ? el('span', null, `${st.sources} outlets`) : null,
            el('time', { datetime: st.latestAt || st.publishedAt, 'data-ago': latest, title: `First reported ${clock(published)}` }, ago(latest)),
          ),
          serviceTags(st.services || []),
        ),
      );
    });
    const emptyText = !searched
      ? "Couldn't reach the news search yet."
      : state.category === 'all' && !state.query
        ? 'No outage headlines in the last 24 hours.'
        : 'No headlines about these services.';
    $('.feed', panel).replaceChildren(...(items.length ? items : [el('p', { class: 'feed-empty' }, emptyText)]));
    moreButton(panel, 'stories', stories.length);
  }

  function changePhrase(e) {
    if (e.to === 'down') return 'went down';
    if (e.to === 'issues') return e.from === 'down' ? 'is partly back' : 'started having issues';
    if (e.to === 'news') return e.from === 'up' ? 'is reported having problems in the news' : 'is back up, but still in outage news';
    if (e.to === 'up') return e.from === 'news' ? 'is no longer reported in outage news' : 'is back up';
    return `is now ${STATUS[e.to]?.label.toLowerCase() || e.to}`;
  }

  function renderChanges(prev) {
    const panel = $('#changes');
    const prevKeys = prev ? new Set((prev.events || []).map((e) => `${e.t}|${e.id}`)) : null;
    const events = (state.doc.events || [])
      .slice()
      .reverse()
      .filter((e) => {
        const s = state.byId.get(e.id);
        return s ? matches(s) : state.category === 'all' && !state.query;
      });
    const shown = state.expanded.changes ? events : events.slice(0, FEED_PREVIEW);
    const items = shown.map((e) => {
      const t = Date.parse(e.t);
      const lasted = e.lasted && e.to === 'up' && e.from !== 'news' ? ` after ${duration(e.lasted)} ${e.from === 'down' ? 'down' : 'with issues'}` : '';
      const name = state.byId.has(e.id) ? el('button', { type: 'button', class: 'name-btn', onclick: () => openDetail(e.id) }, e.name) : e.name;
      return el(
        'li',
        { class: prevKeys && !prevKeys.has(`${e.t}|${e.id}`) ? 'is-new' : null },
        el('span', { class: `mark s-${e.to}` }),
        el(
          'div',
          null,
          el('p', { class: 'what' }, el('strong', null, name), ` ${changePhrase(e)}${lasted}`),
          e.to !== 'up' && e.detail ? el('p', { class: 'meta' }, e.detail) : null,
          el('p', { class: 'meta' }, el('time', { datetime: e.t, 'data-ago': t, title: clock(t) }, ago(t)), el('span', null, clock(t))),
        ),
      );
    });
    $('.feed', panel).replaceChildren(
      ...(items.length ? items : [el('p', { class: 'feed-empty' }, 'No changes yet. This list fills in when something goes down or comes back.')]),
    );
    moreButton(panel, 'changes', events.length);
  }

  function moreButton(panel, key, total) {
    const btn = $('.more', panel);
    btn.hidden = total <= FEED_PREVIEW;
    btn.textContent = state.expanded[key] ? 'Show less' : `Show all ${total}`;
    btn.onclick = () => {
      state.expanded[key] = !state.expanded[key];
      key === 'stories' ? renderStories() : renderChanges();
    };
  }

  // ---- Clock (relative times) ----

  function renderClock() {
    const { doc } = state;
    if (!doc) return;
    const generated = Date.parse(doc.generatedAt);
    const minutes = (Date.now() - generated) / 60e3;
    const stale = minutes > STALE_AFTER_MIN;
    const live = $('#live');
    live.classList.toggle('is-stale', stale && !state.fetchFailed);
    live.classList.toggle('is-offline', state.fetchFailed);
    $('#updated').textContent = state.fetchFailed
      ? `Offline · showing results from ${ago(generated)}`
      : `Live · last checked ${ago(generated)} · checks every ${doc.intervalMinutes || 5} min`;

    const banner = $('#stale');
    banner.hidden = !stale;
    if (stale) {
      banner.textContent = `Checks are running late: the last one finished ${ago(generated)}. GitHub's scheduler sometimes falls behind, so some of this may be out of date.`;
    }
    for (const node of document.querySelectorAll('[data-ago]')) node.textContent = ago(Number(node.dataset.ago));
    for (const node of document.querySelectorAll('[data-since]')) node.textContent = duration(Math.max(0, (Date.now() - Number(node.dataset.since)) / 1000));
  }

  // ---------------------------------------------------------------------------
  // Chart: how many services had each kind of problem, over the last 24 hours

  const SERIES = [
    { key: 'news', label: 'In the news' },
    { key: 'issues', label: 'Having issues' },
    { key: 'down', label: 'Down' },
  ];

  function niceTicks(max) {
    const top = Math.max(4, max);
    const step = top <= 5 ? 1 : top <= 10 ? 2 : top <= 25 ? 5 : top <= 50 ? 10 : 20;
    const ticks = [];
    for (let v = 0; v <= Math.ceil(top / step) * step; v += step) ticks.push(v);
    return ticks;
  }

  function renderChart() {
    const box = $('#chart');
    const doc = state.doc;
    const end = Date.parse(doc.generatedAt);
    const rows = (doc.timeline || [])
      .filter((r) => Array.isArray(r) && r.length >= 4)
      .map((r) => ({ t: r[0] * 1000, down: r[1] || 0, issues: r[2] || 0, news: r[3] || 0 }))
      .filter((r) => r.t >= end - 24 * 3600e3 && r.t <= end + 60e3);

    $('#chart-legend').replaceChildren(
      ...SERIES.slice()
        .reverse()
        .map((s) => el('li', { class: `s-${s.key}` }, el('span', { class: 'line-key' }), s.label)),
    );
    renderChartTable(rows);

    if (rows.length < 2) {
      box.setAttribute('aria-label', 'Not enough data for a chart yet');
      box.replaceChildren(el('p', { class: 'chart-empty' }, 'This chart fills in as checks run, about one point every 5 minutes.'));
      $('#chart-sub').textContent = 'Number of tracked services with each kind of problem';
      return;
    }

    const start = rows[0].t;
    const span = Math.max(end - start, 20 * 60e3);
    const t0 = end - span;
    const hours = span / 3600e3;
    $('#chart-sub').textContent = `Tracked services with each kind of problem, ${hours >= 23.5 ? 'last 24 hours' : `since tracking began ${duration(span / 1000)} ago`}`;

    const W = Math.max(280, Math.round(box.clientWidth || 560));
    const H = 196;
    const m = { top: 12, right: 66, bottom: 26, left: 30 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;
    const maxValue = Math.max(...rows.map((r) => Math.max(r.down, r.issues, r.news)));
    const ticks = niceTicks(maxValue);
    const yMax = ticks[ticks.length - 1];
    const x = (t) => m.left + ((t - t0) / span) * pw;
    const y = (v) => m.top + ph - (v / yMax) * ph;

    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true', focusable: 'false' });
    for (const v of ticks) {
      root.append(svg('line', { x1: m.left, x2: W - m.right, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }));
      root.append(svg('text', { x: m.left - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, String(v)));
    }
    const stepMs = hours <= 2 ? 30 * 60e3 : hours <= 6 ? 3600e3 : hours <= 12 ? 2 * 3600e3 : 4 * 3600e3;
    for (let t = Math.ceil(t0 / stepMs) * stepMs; t <= end; t += stepMs) {
      const px = x(t);
      if (px < m.left + 14 || px > W - m.right - 4) continue;
      const label = stepMs < 3600e3 ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : hourLabel(t);
      root.append(svg('text', { x: px, y: H - 6, 'text-anchor': 'middle', class: 'tick' }, label));
    }

    // Break lines where checks didn't run for a while, instead of drawing a fake slope.
    const segments = [];
    let current = [];
    for (const r of rows) {
      if (current.length && r.t - current[current.length - 1].t > 40 * 60e3) {
        segments.push(current);
        current = [];
      }
      current.push(r);
    }
    segments.push(current);

    for (const series of SERIES) {
      const g = svg('g', { class: `s-${series.key}` });
      for (const seg of segments) {
        if (seg.length === 1) {
          g.append(svg('circle', { cx: x(seg[0].t), cy: y(seg[0][series.key]), r: 2, class: 'end-dot' }));
          continue;
        }
        const line = seg.map((r, i) => `${i ? 'L' : 'M'}${x(r.t).toFixed(1)},${y(r[series.key]).toFixed(1)}`).join('');
        const area = `${line}L${x(seg[seg.length - 1].t).toFixed(1)},${y(0)}L${x(seg[0].t).toFixed(1)},${y(0)}Z`;
        g.append(svg('path', { d: area, class: 'area' }), svg('path', { d: line, class: 'line' }));
      }
      root.append(g);
    }

    // Direct labels at the right edge, only where they don't collide.
    const last = rows[rows.length - 1];
    const placed = [];
    for (const series of SERIES.slice().reverse()) {
      const value = last[series.key];
      if (!value) continue;
      const py = y(value);
      root.append(svg('circle', { cx: x(last.t), cy: py, r: 4, class: `end-dot s-${series.key}` }));
      if (placed.some((p) => Math.abs(p - py) < 14)) continue;
      placed.push(py);
      const short = series.key === 'news' ? 'in news' : series.key === 'issues' ? 'issues' : 'down';
      root.append(svg('text', { x: x(last.t) + 9, y: py + 4, class: 'end-label' }, `${value} ${short}`));
    }

    // Hover / keyboard layer
    const cross = svg('line', { y1: m.top, y2: m.top + ph, class: 'crosshair', visibility: 'hidden' });
    const dots = SERIES.map((s) => svg('circle', { r: 4.5, class: `hover-dot s-${s.key}`, visibility: 'hidden' }));
    root.append(cross, ...dots);
    const tip = el('div', { class: 'chart-tip', hidden: true });
    box.replaceChildren(root, tip);

    const peak = rows.reduce((a, b) => (b.down + b.issues + b.news > a.down + a.issues + a.news ? b : a));
    box.setAttribute(
      'aria-label',
      `Chart. Right now: ${last.down} down, ${last.issues} having issues, ${last.news} in the news. ` +
        `Most at once: ${peak.down + peak.issues + peak.news} services at ${clock(peak.t)}. Use the arrow keys to read values, or open the table below.`,
    );

    let index = rows.length - 1;
    const show = (i) => {
      index = Math.max(0, Math.min(rows.length - 1, i));
      const r = rows[index];
      const px = x(r.t);
      cross.setAttribute('x1', px);
      cross.setAttribute('x2', px);
      cross.setAttribute('visibility', 'visible');
      SERIES.forEach((s, k) => {
        dots[k].setAttribute('cx', px);
        dots[k].setAttribute('cy', y(r[s.key]));
        dots[k].setAttribute('visibility', 'visible');
      });
      tip.replaceChildren(
        el('div', { class: 'when' }, clock(r.t)),
        ...SERIES.slice()
          .reverse()
          .map((s) => el('div', { class: `row s-${s.key}` }, el('span', { class: 'line-key' }), el('b', null, String(r[s.key])), el('span', null, s.label))),
      );
      tip.hidden = false;
      const scale = box.clientWidth / W;
      const tipWidth = tip.offsetWidth || 160;
      let left = px * scale + 14;
      if (left + tipWidth > box.clientWidth) left = px * scale - tipWidth - 14;
      tip.style.left = `${Math.max(0, left)}px`;
      tip.style.top = `${m.top * scale}px`;
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      dots.forEach((d) => d.setAttribute('visibility', 'hidden'));
      tip.hidden = true;
    };
    const nearest = (clientX) => {
      const rect = root.getBoundingClientRect();
      const t = t0 + (((clientX - rect.left) * (W / rect.width) - m.left) / pw) * span;
      let best = 0;
      for (let i = 1; i < rows.length; i++) if (Math.abs(rows[i].t - t) < Math.abs(rows[best].t - t)) best = i;
      return best;
    };
    box.onpointermove = (e) => show(nearest(e.clientX));
    box.onpointerdown = (e) => show(nearest(e.clientX));
    box.onpointerleave = hide;
    box.onfocus = () => show(index);
    box.onblur = hide;
    box.onkeydown = (e) => {
      const moves = { ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: rows.length - 1 };
      if (e.key in moves) {
        e.preventDefault();
        show(moves[e.key]);
      } else if (e.key === 'Escape') hide();
    };
  }

  function renderChartTable(rows) {
    const holder = $('#chart-table .table-scroll');
    if (!rows.length) {
      holder.replaceChildren(el('p', { class: 'feed-empty', style: 'padding:8px 10px' }, 'No data yet.'));
      return;
    }
    const byHour = new Map();
    for (const r of rows) {
      const h = Math.floor(r.t / 3600e3) * 3600e3;
      const b = byHour.get(h) || { down: 0, issues: 0, news: 0 };
      b.down = Math.max(b.down, r.down);
      b.issues = Math.max(b.issues, r.issues);
      b.news = Math.max(b.news, r.news);
      byHour.set(h, b);
    }
    const body = [...byHour.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([h, b]) => el('tr', null, el('td', null, `${clock(h)} – ${hourLabel(h + 3600e3)}`), el('td', null, String(b.down)), el('td', null, String(b.issues)), el('td', null, String(b.news))));
    holder.replaceChildren(
      el(
        'table',
        null,
        el('caption', { class: 'visually-hidden' }, 'Most services with each problem at once, per hour'),
        el('thead', null, el('tr', null, el('th', { scope: 'col' }, 'Hour'), el('th', { scope: 'col' }, 'Down'), el('th', { scope: 'col' }, 'Issues'), el('th', { scope: 'col' }, 'In the news'))),
        el('tbody', null, body),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Detail dialog

  function openFromHash() {
    const m = location.hash.match(/^#s\/([\w-]+)$/);
    if (m && state.byId.has(m[1])) openDetail(m[1], { updateHash: false });
  }

  function openDetail(id, { updateHash = true } = {}) {
    if (!state.byId.has(id)) return;
    state.detailId = id;
    fillDetail(id);
    const dialog = $('#detail');
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
    if (updateHash) history.replaceState(null, '', `#s/${id}`);
  }

  function section(title, ...kids) {
    return el('section', { class: 'd-section' }, el('h3', null, title), kids);
  }

  function fillDetail(id) {
    const s = state.byId.get(id);
    if (!s) return;
    const doc = state.doc;
    const checked = Date.parse(s.checkedAt || doc.generatedAt);
    const body = $('#detail-body');
    const repo = doc.site?.repo;

    const checks = s.checks?.length
      ? el(
          'ul',
          { class: 'd-list' },
          s.checks.map((c) => {
            const st = c.state === 'fail' ? 'down' : c.state === 'slow' ? 'issues' : 'up';
            const ms = c.ms != null && c.state !== 'fail' ? ` · ${(c.ms / 1000).toFixed(1)}s` : '';
            return el(
              'li',
              null,
              el('span', { class: `mark s-${st}` }),
              el('span', null, el('strong', null, c.label), ` · ${c.reason}${ms}`, el('span', { class: 'sub' }, safeUrl(c.url) ? new URL(c.url).host + new URL(c.url).pathname.replace(/\/$/, '') : c.url)),
            );
          }),
        )
      : el('p', { class: 'd-fine' }, "We don't visit this one directly, so its status comes from news reports and its official status page.");

    let official = null;
    if (s.statusPage) {
      if (s.official) {
        official = section(
          'Official status page',
          el(
            'ul',
            { class: 'd-list' },
            el('li', null, el('span', { class: `mark s-${s.official.status === 'up' && (s.official.incidents.length || s.official.maintenance) ? 'news' : s.official.status}` }), el('span', null, s.official.description || 'No description')),
            s.official.incidents.map((i) =>
              el('li', null, el('span', { class: 'mark s-issues' }), el('span', null, extLink(i.url, i.name) || i.name, el('span', { class: 'sub' }, [i.status, i.impact && `${i.impact} impact`].filter(Boolean).join(' · ')))),
            ),
          ),
          el('p', { class: 'd-fine' }, extLink(s.statusPage, 'Open the official status page')),
        );
      } else {
        official = section('Official status page', el('p', { class: 'd-fine' }, "We can't read this one automatically. ", extLink(s.statusPage, 'Open it yourself')));
      }
    }

    const news = s.news?.length
      ? section(
          'In the news',
          el(
            'ul',
            { class: 'd-list' },
            s.news.map((n) =>
              el(
                'li',
                null,
                el('span', { class: `mark ${n.tone === 'update' ? 's-update' : 's-news'}` }),
                el('span', null, extLink(n.url, n.title) || n.title, el('span', { class: 'sub' }, `${n.source} · ${ago(Date.parse(n.publishedAt))}`)),
              ),
            ),
          ),
        )
      : null;

    const events = (doc.events || []).filter((e) => e.id === id).slice(-8).reverse();
    const changes = section(
      'Recent changes',
      events.length
        ? el(
            'ul',
            { class: 'd-list' },
            events.map((e) =>
              el('li', null, el('span', { class: `mark s-${e.to}` }), el('span', null, `${STATUS[e.to]?.label || e.to}`, el('span', { class: 'sub' }, `${clock(Date.parse(e.t))} · ${ago(Date.parse(e.t))}`))),
            ),
          )
        : el('p', { class: 'd-fine' }, `No changes since we started tracking it ${ago(Date.parse(s.firstSeen || doc.trackingSince || doc.generatedAt))}.`),
    );

    const wrong = repo
      ? `https://github.com/${repo}/issues/new?title=${encodeURIComponent(`Wrong status: ${s.name}`)}&body=${encodeURIComponent(
          `The tracker shows **${s.name}** as "${STATUS[s.status].label}" (${s.detail}).\n\nWhat I'm seeing instead:\n`,
        )}`
      : null;

    fill(
      body,
      el('button', { type: 'button', class: 'icon-btn d-close', 'aria-label': 'Close', onclick: () => $('#detail').close() }, icon('close')),
      el('div', { class: 'd-head' }, logo(s), el('div', null, el('h2', { id: 'd-name' }, s.name), el('p', null, `${s.category} · `, extLink(s.url, hostOf(s.url)) || hostOf(s.url)))),
      el('div', { class: 'd-status' }, pill(s.status), sinceLine(s)),
      detailNode(s, 'd-detail'),
      s.note ? el('p', { class: 'card-note' }, s.note) : null,
      section('Last 48 hours', strip(s, 48, 'big'), el('div', { class: 'strip-scale', style: 'margin-top:4px' }, el('span', null, '48h ago'), el('span', null, '24h'), el('span', null, 'Now'))),
      section('What we checked', checks, s.checks?.length ? el('p', { class: 'd-fine' }, `Checked ${ago(checked)} from ${doc.vantage || 'our servers'}. Sites that block robots but still answer count as working.`) : null),
      official,
      news,
      changes,
      el(
        'div',
        { class: 'd-actions' },
        el('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => testOne(s) }, 'Test from my network'),
        el('button', { type: 'button', class: 'btn btn-sm', onclick: () => shareService(s) }, 'Share'),
        wrong ? el('a', { class: 'btn btn-sm', href: wrong, target: '_blank', rel: 'noopener noreferrer' }, 'Wrong status? Tell us') : null,
      ),
      youLine(s.id),
    );
  }

  // ---------------------------------------------------------------------------
  // "Is it just me?" — reachability from the visitor's own browser

  function youLine(id) {
    const node = el('p', { class: 'you', 'data-you': id, hidden: true });
    paintYou(node, state.you.get(id));
    return node;
  }

  function paintYou(node, result) {
    if (!result) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.classList.remove('pending', 's-up', 's-down');
    if (result === 'pending') {
      node.classList.add('pending');
      node.textContent = 'Testing from your network…';
    } else if (result.ok) {
      node.classList.add('s-up');
      node.textContent = `Loads from your network (${(result.ms / 1000).toFixed(1)}s)`;
    } else {
      node.classList.add('s-down');
      node.textContent = "Didn't load from your network";
    }
  }

  function updateYou(id) {
    for (const node of document.querySelectorAll(`[data-you="${CSS.escape(id)}"]`)) paintYou(node, state.you.get(id));
  }

  async function reachable(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const started = performance.now();
    try {
      // Opaque request: we can't read the page, only whether the server answered at all.
      await fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controller.signal });
      return { ok: true, ms: performance.now() - started };
    } catch {
      return { ok: false, ms: performance.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }

  async function testOne(s) {
    state.you.set(s.id, 'pending');
    updateYou(s.id);
    const result = await reachable(s.url);
    state.you.set(s.id, result);
    updateYou(s.id);
    return result;
  }

  async function testAll() {
    if (!state.doc) return;
    const btn = $('#test-all');
    const label = $('#test-all-label');
    const list = state.doc.services.slice();
    let done = 0;
    btn.disabled = true;
    label.textContent = `Testing 0 of ${list.length}…`;
    const results = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (next < list.length) {
          const s = list[next++];
          results.push([s, await testOne(s)]);
          done += 1;
          label.textContent = `Testing ${done} of ${list.length}…`;
        }
      }),
    );
    btn.disabled = false;
    label.textContent = 'Test again';
    const failed = results.filter(([, r]) => !r.ok).map(([s]) => s);
    const summary = $('#test-summary');
    summary.hidden = false;
    summary.replaceChildren();
    if (failed.length > list.length * 0.6) {
      summary.append(el('strong', null, 'Most sites didn’t load from your browser.'), ' The problem is probably your own internet connection, not these services.');
    } else if (failed.length) {
      summary.append(
        el('strong', null, `${list.length - failed.length} of ${list.length} sites loaded from your network.`),
        ` Didn’t load: ${failed.slice(0, 6).map((s) => s.name).join(', ')}${failed.length > 6 ? ` and ${failed.length - 6} more` : ''}. Privacy extensions can block some of these.`,
      );
    } else {
      summary.append(el('strong', null, `All ${list.length} sites loaded from your network.`), ' If one still isn’t working for you, the problem may be your account or app, not the whole service.');
    }
  }

  // ---------------------------------------------------------------------------
  // Sharing

  const pageUrl = () => `${location.origin}${location.pathname}`;

  async function share(text, url) {
    if (navigator.share) {
      try {
        await navigator.share({ title: 'CyberTracker', text, url });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast('Link copied');
    } catch {
      window.prompt('Copy this link:', url);
    }
  }

  function sharePage() {
    if (!state.doc) return share("What's down right now:", pageUrl());
    const { summary, services } = state.doc;
    const n = problemCount(summary);
    if (!n) return share('Everything CyberTracker watches is working right now:', pageUrl());
    const names = services.filter((s) => PROBLEMS.includes(s.status)).sort(bySeverity).slice(0, 3).map((s) => s.name);
    return share(`${n} ${plural(n, 'service has', 'services have')} problems right now (${names.join(', ')}${n > 3 ? '…' : ''}). Live tracker:`, pageUrl());
  }

  function shareService(s) {
    const words = { down: 'is down', issues: 'is having issues', news: 'is being reported down in the news', up: 'is working', unknown: 'status unknown' };
    return share(`${s.name} ${words[s.status]} right now. Live status:`, `${pageUrl()}#s/${s.id}`);
  }

  // ---------------------------------------------------------------------------
  // Theme, tooltips, wiring

  function currentTheme() {
    return document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  }

  function paintThemeButton() {
    const btn = $('#theme-toggle');
    const dark = currentTheme() === 'dark';
    btn.replaceChildren(icon(dark ? 'sun' : 'moon'));
    btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }

  function showTip(target) {
    const tip = $('#tooltip');
    tip.textContent = target.dataset.tip;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.left + r.width / 2 - w / 2));
    const top = r.top - tip.offsetHeight - 8;
    tip.style.left = `${left}px`;
    tip.style.top = `${top < 8 ? r.bottom + 8 : top}px`;
  }

  function wire() {
    $('#test-all').addEventListener('click', testAll);
    $('#share').addEventListener('click', sharePage);
    $('#theme-toggle').addEventListener('click', () => {
      const next = currentTheme() === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      storage.set('ct-theme', next);
      paintThemeButton();
    });
    paintThemeButton();

    let typing;
    $('#q').addEventListener('input', (e) => {
      clearTimeout(typing);
      typing = setTimeout(() => {
        state.query = e.target.value.trim().toLowerCase();
        if (!state.doc) return;
        renderBoard();
        renderStories();
        renderChanges();
      }, 120);
    });

    const dialog = $('#detail');
    dialog.addEventListener('close', () => {
      state.detailId = null;
      if (location.hash.startsWith('#s/')) history.replaceState(null, '', location.pathname + location.search);
    });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    window.addEventListener('hashchange', () => state.doc && openFromHash());

    document.addEventListener('pointerover', (e) => {
      const target = e.target.closest && e.target.closest('[data-tip]');
      if (target) showTip(target);
    });
    document.addEventListener('pointerout', (e) => {
      if (e.target.closest && e.target.closest('[data-tip]')) $('#tooltip').hidden = true;
    });
    window.addEventListener('scroll', () => ($('#tooltip').hidden = true), { passive: true });

    let width = 0;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      if (state.doc && Math.abs(w - width) > 4) {
        width = w;
        requestAnimationFrame(renderChart);
      }
    });
    observer.observe($('#chart'));

    setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, POLL_MS);
    setInterval(renderClock, 15_000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') load();
    });
  }

  wire();
  load();
})();
