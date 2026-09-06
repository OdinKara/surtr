/**
 * Side panel: display and control only.
 *
 * THIS FILE NEVER FETCHES x.com. Not once, not for "just the user id". Every
 * network call belongs to content/executor.js, which runs in the x.com origin
 * so the browser attaches the session cookie itself. The panel sends
 * start/stop/config messages and renders what it reads out of storage.
 *
 * Storage is also why the panel survives everything: close it mid-scan, let the
 * service worker die, reopen it, and the counters are still right, because they
 * were never in memory here to begin with.
 */

import * as store from '../lib/store.js';
import * as filters from '../lib/filters.js';

const $ = (id) => document.getElementById(id);

/** Rows rendered into the DOM. The full set still exports. */
const MAX_ROWS = 500;

/* ----------------------------------------------------------------- relay --- */

/** Everything to the executor goes through background.js. */
function send(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SURTR_RELAY', payload }, (reply) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(reply || { ok: false, error: 'No reply.' });
    });
  });
}

/* ----------------------------------------------------------------- config --- */

function numOrNull(el) {
  const v = el.value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateOrNull(el) {
  const v = el.value.trim();
  return v === '' ? null : new Date(v + 'T00:00:00Z').toISOString();
}

function readConfig() {
  const kinds = [];
  if ($('k-post').checked) kinds.push('post');
  if ($('k-reply').checked) kinds.push('reply');
  if ($('k-retweet').checked) kinds.push('retweet');

  const media = $('f-media').value;

  return {
    ...filters.defaultConfig(),
    beforeDate: dateOrNull($('f-before')),
    afterDate: dateOrNull($('f-after')),
    maxLikes: numOrNull($('f-maxlikes')),
    minLikes: numOrNull($('f-minlikes')),
    maxRetweets: numOrNull($('f-maxrts')),
    includeKinds: kinds,
    keywordContains: $('f-contains').value,
    keywordExcludes: $('f-excludes').value,
    hasMedia: media === '' ? null : media === 'true',
    excludePinned: $('v-pinned').checked,
    keepIdList: $('v-keep').value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
  };
}

function applyConfig(cfg) {
  if (!cfg) return;
  const day = (iso) => (iso ? String(iso).slice(0, 10) : '');
  $('f-before').value = day(cfg.beforeDate);
  $('f-after').value = day(cfg.afterDate);
  $('f-maxlikes').value = cfg.maxLikes ?? '';
  $('f-minlikes').value = cfg.minLikes ?? '';
  $('f-maxrts').value = cfg.maxRetweets ?? '';
  const kinds = cfg.includeKinds || [];
  $('k-post').checked = kinds.includes('post');
  $('k-reply').checked = kinds.includes('reply');
  $('k-retweet').checked = kinds.includes('retweet');
  $('f-contains').value = cfg.keywordContains || '';
  $('f-excludes').value = cfg.keywordExcludes || '';
  $('f-media').value = cfg.hasMedia === null || cfg.hasMedia === undefined
    ? '' : String(Boolean(cfg.hasMedia));
  $('v-pinned').checked = cfg.excludePinned !== false;
  $('v-keep').value = (cfg.keepIdList || []).join('\n');
}

/* --------------------------------------------------------------- rendering --- */

function setStatus(el, ok, text) {
  el.textContent = text;
  el.className = ok === null ? 'pending' : ok ? 'ok' : 'bad';
}

/**
 * Connection rows, one per stream.
 *
 * Two things this must get right.
 *
 * First: a query id found in X's bundle is NOT evidence that the site still
 * serves that operation. X retired UserTweetsAndReplies while its id was still
 * sitting in the bundle, so a row that says "discovered" off a bundle hit is
 * lying by omission. Nothing here claims more than it knows - "in bundle" until
 * a request comes back, and only then "confirmed live".
 *
 * Second: the posts and reposts streams fail SEPARATELY and are reported
 * separately. "Posts resolved, reposts did not" is a completely different
 * problem from the reverse, and one collapsed "discovery failed" row would tell
 * you nothing about which half X renamed.
 */
function renderDiscovery(d) {
  const row = (id, stream) => {
    const el = $(id);
    if (!stream) { setStatus(el, null, 'not found'); return; }
    if (!stream.selected) { setStatus(el, false, 'NONE FOUND'); return; }
    const live = stream.confirmedLive === stream.selected;
    setStatus(el, true, stream.selected + (live ? '  [confirmed live]' : '  [in bundle]'));
  };

  if (!d) {
    setStatus($('st-bearer'), null, 'not discovered');
    setStatus($('st-q1'), null, 'not found');
    row('st-posts', null);
    row('st-reposts', null);
    setStatus($('st-alt'), null, '—');
    return;
  }

  setStatus($('st-bearer'), Boolean(d.bearer), d.bearer ? 'present' : 'MISSING');
  const q = d.queryIds || {};
  setStatus($('st-q1'), Boolean(q.UserByScreenName), q.UserByScreenName || 'MISSING');

  const t = d.timelines || {};
  row('st-posts', t.posts);
  row('st-reposts', t.reposts);

  const unused = d.unusedCandidates || [];
  setStatus($('st-alt'), null, unused.length ? unused.join(', ') : '—');

  if (d.missing && d.missing.length > 0) $('manual-wrap').open = true;
}

function renderJob(job) {
  const j = job || store.emptyJob();
  $('c-enum').textContent = j.enumerated || 0;
  $('c-match').textContent = j.matched || 0;
  $('c-excl').textContent = j.excluded || 0;
  $('c-pages').textContent = j.pages || 0;

  const busy = j.status === store.JOB_RUNNING || j.status === store.JOB_STOPPING;
  $('btn-scan').disabled = busy;
  $('btn-stop').disabled = !busy;
  const resumable = (j.streams || []).some(
    (s) => s.status === 'pending' || s.status === 'running');
  $('btn-scan').textContent =
    j.status === store.JOB_RUNNING ? 'Scanning...'
    : (resumable && j.enumerated) ? 'Resume dry-run scan'
    : 'Start dry-run scan';

  // Cumulative pages with the per-stream breakdown, so a single number never
  // has to be explained and never appears to jump backwards.
  const active = (j.streams || []).filter((s) => s.status !== 'skipped');
  const breakdown = active.map((s) => s.label + ' ' + (s.pages || 0)).join(', ');
  const line = $('stream-line');
  if (j.streams && j.streams.length) {
    const cur = (j.streams || []).find((s) => s.key === j.currentStream);
    const idx = cur ? j.streams.indexOf(cur) + 1 : null;
    line.textContent =
      (cur ? 'stream ' + idx + ' of ' + j.streams.length + ' \u00b7 ' + cur.label +
             ' \u00b7 ' + cur.op + ' \u00b7 running' : 'streams idle') +
      (breakdown ? '   |   pages ' + (j.pages || 0) + ' (' + breakdown + ')' : '');
    line.hidden = false;
  } else {
    line.hidden = true;
  }

  // A SKIPPED STREAM MUST BE VISIBLE AT A GLANCE. Not only in the export.
  const skippedStreams = (j.streams || []).filter((s) => s.status === 'skipped');
  const banner = $('stream-skipped');
  if (skippedStreams.length) {
    banner.textContent = skippedStreams
      .map((s) => s.label.toUpperCase() + ' NOT INCLUDED \u2014 stream skipped because the ' +
                  'kind filter excludes it. It was not walked at all; nothing from it is in ' +
                  'these results.')
      .join('  ');
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }

  // Cross-stream duplicates are a DEFECT SIGNAL, not hygiene: these streams are
  // tab-scoped and should be disjoint.
  const dupes = $('dupes');
  if (j.crossStreamDuplicates > 0) {
    dupes.className = 'banner bad';
    dupes.textContent =
      'CROSS-STREAM DUPLICATES: ' + j.crossStreamDuplicates + ' id(s) arrived from more ' +
      'than one stream. These streams are meant to be disjoint, so this means the model ' +
      'of X\u2019s operations is wrong \u2014 worth investigating. ' +
      'Ids: ' + (j.crossStreamDuplicateIds || []).slice(0, 10).join(', ') +
      ((j.crossStreamDuplicateIds || []).length > 10 ? ' \u2026' : '');
    dupes.hidden = false;
  } else {
    dupes.hidden = true;
  }

  // One report per stream. NEVER collapsed into a single verdict: a run can hit
  // the ceiling on one stream and end on genuine cursor exhaustion on another.
  const reports = $('stream-reports');
  reports.textContent = '';
  for (const s of j.streams || []) {
    if (!s.termination) continue;
    const p = document.createElement('p');
    p.className = 'termination' +
      (s.status === 'failed' ? ' failed' : s.status === 'skipped' ? ' skipped' : '');
    p.textContent = s.termination;
    reports.append(p);
  }

  const err = $('scan-error');
  if (j.error) {
    err.textContent = j.error;
    err.hidden = false;
  } else {
    err.hidden = true;
  }

  // What the parser refused. A "FOREIGN AUTHOR" count is the safety gate
  // rejecting the who-to-follow module - the guard working, not a fault.
  const skipped = $('skipped');
  const rej = {};
  for (const s of j.streams || []) {
    for (const [w, n] of Object.entries(s.rejected || {})) rej[w] = (rej[w] || 0) + n;
  }
  const totals = (j.streams || [])
    .filter((s) => s.reportedTotal)
    .map((s) => s.label + ': X reports ' + s.reportedTotal);
  if (Object.keys(rej).length || totals.length) {
    skipped.textContent =
      (Object.keys(rej).length
        ? 'skipped entries: ' + Object.entries(rej).map(([w, n]) => n + ' x ' + w).join(', ')
        : '') +
      (totals.length ? '   |   ' + totals.join('   |   ') : '');
    skipped.hidden = false;
  } else {
    skipped.hidden = true;
  }
}

/**
 * Rate meter for the CURRENT stream's operation only.
 *
 * Deliberately never a combined figure. Different endpoints carry different
 * budgets, so an average or a sum across operations is wrong for both of them -
 * and since the tool exists partly to LEARN the real ceilings, a merged number
 * would destroy the measurement.
 */
function renderRate(job) {
  const bar = $('rate-bar');
  const text = $('rate-text');
  const streams = (job && job.streams) || [];
  const current =
    streams.find((s) => s.key === job.currentStream) ||
    [...streams].reverse().find((s) => s.rate) ||
    null;
  const r = current && current.rate;

  if (!r || r.remaining === null || r.remaining === undefined) {
    bar.style.width = '0%';
    text.textContent = 'rate limit: not observed yet';
    return;
  }
  const limit = r.limit || null;
  bar.style.width = limit ? Math.max(0, Math.min(100, (r.remaining / limit) * 100)) + '%' : '100%';
  const resetIn = r.reset ? Math.max(0, r.reset - Math.floor(Date.now() / 1000)) : null;
  text.textContent =
    r.operationName + ': ' + r.remaining + (limit ? ' / ' + limit : '') + ' remaining' +
    (resetIn !== null ? ', resets in ' + resetIn + 's' : '') +
    (r.observed429s ? ' - ' + r.observed429s + ' x 429' : '') +
    (streams.filter((s) => s.rate).length > 1 ? '  (this operation only)' : '');
}

function preview(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 140) + '…' : t;
}

function renderResults(posts, cfg) {
  const { matched } = filters.partition(posts || [], cfg);
  $('res-count').textContent = matched.length;

  const body = $('results-body');
  body.textContent = '';

  if (matched.length === 0) {
    const tr = document.createElement('tr');
    tr.className = 'empty';
    const td = document.createElement('td');
    td.colSpan = 6;
    td.textContent = (posts && posts.length)
      ? 'Nothing matched these filters. ' + posts.length + ' posts were enumerated.'
      : 'No scan has run yet.';
    tr.append(td);
    body.append(tr);
    $('res-more').hidden = true;
    return matched;
  }

  const frag = document.createDocumentFragment();
  for (const p of matched.slice(0, MAX_ROWS)) {
    const tr = document.createElement('tr');

    const date = document.createElement('td');
    date.className = 'num';
    date.textContent = p.createdAt ? p.createdAt.slice(0, 10) : '?';

    const kind = document.createElement('td');
    kind.className = 'kind';
    kind.textContent = p.kind;

    const likes = document.createElement('td');
    likes.className = 'num';
    likes.textContent = p.likeCount;

    const rts = document.createElement('td');
    rts.className = 'num';
    rts.textContent = p.retweetCount;

    const txt = document.createElement('td');
    txt.className = 'txt';
    txt.textContent = preview(p.text);

    const link = document.createElement('td');
    const a = document.createElement('a');
    a.href = p.permalink;
    a.target = '_blank';
    a.rel = 'noreferrer';
    a.textContent = 'open';
    link.append(a);

    tr.append(date, kind, likes, rts, txt, link);
    frag.append(tr);
  }
  body.append(frag);

  const more = $('res-more');
  if (matched.length > MAX_ROWS) {
    more.textContent =
      'Showing the first ' + MAX_ROWS + ' of ' + matched.length +
      '. Export to see them all.';
    more.hidden = false;
  } else {
    more.hidden = true;
  }
  return matched;
}

function renderLog(lines) {
  $('log').textContent = (lines || [])
    .map((l) => l.t.slice(11, 19) + '  ' + l.level.toUpperCase().padEnd(5) + '  ' + l.message)
    .join('\n');
}

/* ------------------------------------------------------------------ paint --- */

let lastMatched = [];

async function paint() {
  const [job, results, cfgSaved, disc, log] = await Promise.all([
    store.readJob(),
    store.readResults(),
    store.get(store.KEY.CONFIG),
    store.get(store.KEY.DISCOVERY),
    store.get(store.KEY.LOG),
  ]);
  if (cfgSaved && !paint._configApplied) {
    applyConfig(cfgSaved);
    paint._configApplied = true;
  }
  renderDiscovery(disc);
  renderJob(job);
  renderRate(job);
  renderLog(log);
  lastMatched = renderResults(results, readConfig());
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (Object.keys(changes).some((k) => k.startsWith('surtr:'))) paint();
});

/* ----------------------------------------------------------------- export --- */

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * Save a file from the panel.
 *
 * A blob URL plus a synthetic anchor click, NOT chrome.downloads. The panel is
 * an ordinary extension page, so `<a download>` works here with no permission
 * at all - and asking for `downloads` would mean asking for the ability to
 * write files the user never requested, to justify saving a file the user just
 * clicked a button to save. The smaller permission set is the point.
 */
function download(text, mime, filename) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  // Revoke late: the browser needs the blob alive until the save has started.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function toCsv(rows) {
  // `_stream` records which timeline the item came from - the CSV has no room
  // for the streams block, so at minimum every row says where it originated.
  const cols = [
    'id', 'kind', '_stream', 'createdAt', 'likeCount', 'retweetCount', 'replyCount',
    'quoteCount', 'hasMedia', 'isPinned', 'sourceTweetId', 'permalink', 'text',
  ];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [cols.join(',')];
  for (const r of rows) out.push(cols.map((c) => esc(r[c])).join(','));
  return out.join('\r\n');
}

/* ------------------------------------------------------------------ wiring --- */

$('btn-discover').addEventListener('click', async () => {
  const r = await send({ type: 'SURTR_DISCOVER' });
  setStatus($('st-tab'), r.ok || r.hasBearer !== undefined, r.error ? r.error : 'connected');
  await paint();
});

$('btn-rediscover').addEventListener('click', async () => {
  const r = await send({ type: 'SURTR_DISCOVER', force: true });
  setStatus($('st-tab'), !r.error, r.error || 'connected');
  await paint();
});

$('btn-manual').addEventListener('click', async () => {
  const postsOp = $('m-op').value.trim() || 'UserOriginalsTimeline';
  const repostsOp = $('m-op2').value.trim() || 'UserRepostsTimeline';
  const queryIds = { UserByScreenName: $('m-q1').value.trim() };
  if ($('m-q2').value.trim()) queryIds[postsOp] = $('m-q2').value.trim();
  if ($('m-q3').value.trim()) queryIds[repostsOp] = $('m-q3').value.trim();
  const values = { bearer: $('m-bearer').value.trim(), queryIds };
  await send({ type: 'SURTR_MANUAL', values });
  await paint();
});

$('btn-scan').addEventListener('click', async () => {
  const config = readConfig();
  $('scan-error').hidden = true;
  const r = await send({ type: 'SURTR_START', config });
  if (!r.ok && r.error) {
    $('scan-error').textContent = r.error;
    $('scan-error').hidden = false;
  }
  await paint();
});

$('btn-stop').addEventListener('click', async () => {
  await send({ type: 'SURTR_STOP' });
  await paint();
});

$('btn-reset').addEventListener('click', async () => {
  await send({ type: 'SURTR_RESET' });
  await paint();
});

/**
 * The streams block. THE EXPORT IS THE PRE-DELETION RECORD, so it has to say
 * what it does NOT contain: which streams ran, which failed partway, which were
 * skipped by the filter and never walked at all, how each one terminated, and
 * whether any id turned up in more than one stream. A partial export that reads
 * as complete is the same class of error as a bundle hit that reads as
 * "discovered".
 */
function streamsBlock(job) {
  const j = job || {};
  return {
    complete: (j.streams || []).length > 0 &&
      (j.streams || []).every((s) => s.status === 'done'),
    runStatus: j.status || 'unknown',
    streams: (j.streams || []).map((s) => ({
      key: s.key,
      operation: s.op,
      status: s.status,
      endReason: s.endReason,
      ceilingSuspected: Boolean(s.ceilingSuspected),
      pages: s.pages || 0,
      enumerated: s.enumerated || 0,
      error: s.error || null,
      reportedTotal: s.reportedTotal ?? null,
      note: s.termination || null,
      // Kept per operation, never merged: different endpoints, different budgets.
      rateObserved: s.rate
        ? {
            operationName: s.rate.operationName,
            limit: s.rate.limit,
            lowestRemainingSeen: s.rate.observedMinRemaining,
            observed429s: s.rate.observed429s,
            requests: s.rate.requests,
          }
        : null,
    })),
    crossStreamDuplicates: j.crossStreamDuplicates || 0,
    crossStreamDuplicateIds: j.crossStreamDuplicateIds || [],
  };
}

$('btn-json').addEventListener('click', async () => {
  if (lastMatched.length === 0) return;
  const job = await store.readJob();
  const payload = {
    tool: 'Surtr',
    phase: 'dry-run',
    generatedAt: new Date().toISOString(),
    count: lastMatched.length,
    filters: readConfig(),
    enumeration: streamsBlock(job),
    posts: lastMatched,
  };
  download(JSON.stringify(payload, null, 2), 'application/json',
    'surtr-report-' + stamp() + '.json');
});

$('btn-csv').addEventListener('click', () => {
  if (lastMatched.length === 0) return;
  download(toCsv(lastMatched), 'text/csv', 'surtr-report-' + stamp() + '.csv');
});

// Re-filter live as settings change. Cheap: the posts are already in memory.
for (const id of [
  'f-before', 'f-after', 'f-maxlikes', 'f-minlikes', 'f-maxrts', 'f-media',
  'k-post', 'k-reply', 'k-retweet', 'f-contains', 'f-excludes', 'v-pinned', 'v-keep',
]) {
  $(id).addEventListener('change', paint);
  $(id).addEventListener('input', paint);
}

/* ------------------------------------------------------------------- boot --- */

(async () => {
  await paint();
  const ping = await send({ type: 'SURTR_PING' });
  setStatus($('st-tab'), Boolean(ping.ok), ping.ok ? 'connected' : (ping.error || 'not found'));
})();
