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
import * as streams from '../lib/streams.js';
import { computeBuildId } from '../lib/build.js';
import * as execute from '../lib/execute.js';

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
    row('st-replies', null);
    setStatus($('st-alt'), null, '—');
    return;
  }

  setStatus($('st-bearer'), Boolean(d.bearer), d.bearer ? 'present' : 'MISSING');
  summariseConnection(d);
  const q = d.queryIds || {};
  setStatus($('st-q1'), Boolean(q.UserByScreenName), q.UserByScreenName || 'MISSING');

  const t = d.timelines || {};
  row('st-posts', t.posts);
  row('st-reposts', t.reposts);
  row('st-replies', t.replies);

  const unused = d.unusedCandidates || [];
  setStatus($('st-alt'), null, unused.length ? unused.join(', ') : '—');

  // Open the manual override once when discovery is incomplete, not on every
  // repaint. The same state-vs-event confusion as the kill-log auto-download,
  // in a harmless place: forcing it open on every render means a user who
  // closes it has it reopen under them at the next storage change.
  if (d.missing && d.missing.length > 0 && !renderDiscovery._openedManual) {
    renderDiscovery._openedManual = true;
    $('manual-wrap').open = true;
  }
}

/**
 * The one line somebody who is not debugging should read.
 *
 * The queryIds, build fingerprint and "in bundle" / "confirmed live" wording all
 * still exist, unchanged, behind the Diagnostics disclosure - that is how a
 * rename gets diagnosed. They are simply not the first thing on screen.
 */
function summariseConnection(d) {
  const el = $('conn-summary');
  if (!el) return;
  if (!d) {
    el.className = 'lede';
    el.textContent = 'Not connected yet. Open x.com in a tab and press Connect.';
    return;
  }
  const missing = d.missing || [];
  if (missing.length === 0) {
    el.className = 'lede ready';
    el.textContent = 'Ready. Surtr can read your posts, replies and reposts.';
    return;
  }
  el.className = 'lede notready';
  el.textContent = 'Not ready yet \u2014 ' + missing.join(', ') +
    ' could not be found. Make sure you are signed in to x.com, then press ' +
    'Connect again. Diagnostics below has the detail.';
}

/**
 * The one line a stranger reads.
 *
 * Plain language, no operation names, no entry-type jargon: what was scanned,
 * how many were found, how many match, what was left out. Everything else is
 * in Scan details, unchanged.
 *
 * SEVERITY HAS TO MEAN SOMETHING. Red is reserved for a stream that was walked
 * and came up short, a ceiling, a failure, an unknown account total on a full
 * scan, or cross-stream duplicates. A correct scan that covered exactly what
 * the user asked for shows no warning colour, so that when the red one does
 * appear it still carries weight.
 */
function renderScanSummary(j, c, warning) {
  const el = $('scan-summary');
  const caveat = $('scan-caveat');
  const details = $('scan-details');

  const anyDetail = Boolean(c) || (j.streams || []).some((s) => s.termination);
  details.hidden = !anyDetail;

  if (!c) {
    el.hidden = true;
    caveat.hidden = true;
    return;
  }

  const list = (arr) => {
    const a = (arr || []).slice();
    if (a.length <= 1) return a[0] || '';
    return a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
  };
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

  const scanned = list(c.scopeStreams) || 'account';
  const left = list(c.skippedStreams);

  let text = 'Scanned your ' + scanned + '. ' + (j.enumerated || 0) + ' found, ' +
    (j.matched || 0) + ' match your filters.';
  if (left) text += ' ' + cap(left) + ' were not included.';

  // Cross-stream duplicates are a defect signal in their own right and must
  // reach the summary rather than sitting only in the details.
  const dupeWarn = j.crossStreamDuplicates > 0
    ? 'Some items arrived from two streams that should not overlap - see Scan details.'
    : null;

  const problems = [warning, dupeWarn].filter(Boolean);
  el.className = problems.length ? 'banner bad' : 'banner';
  el.textContent = problems.length ? text + ' ' + problems.join(' ') : text;
  el.hidden = false;

  // THE WEAKER CLAIM, VISIBLE. A filtered scan cannot be checked against a
  // number, and the user is told that in the open rather than left to infer a
  // clean sweep. Suppressed when a warning is showing, which already carries it.
  if (c.claim && !problems.length) {
    caveat.textContent = c.claim;
    caveat.hidden = false;
  } else {
    caveat.hidden = true;
  }
}

function renderJob(job) {
  const j = job || store.emptyJob();
  $('c-enum').textContent = j.enumerated || 0;
  $('c-match').textContent = j.matched || 0;
  $('c-excl').textContent = j.excluded || 0;
  $('c-pages').textContent = j.pages || 0;

  // `live` is THE answer to "is a scan actually in progress", and every other
  // piece of the UI is derived from it. Nothing else may decide separately.
  const live = j.status === store.JOB_RUNNING || j.status === store.JOB_STOPPING;
  $('btn-scan').disabled = live;
  $('btn-stop').disabled = !live;
  const resumable = (j.streams || []).some(
    (s) => s.status === 'pending' || s.status === 'running');
  // Derived from the SAME `live` flag as the status line, so the two cannot
  // contradict each other.
  $('btn-scan').textContent =
    live && j.rateLimited ? 'Rate limited - waiting'
    : live ? 'Scanning...'
    : (resumable && j.enumerated) ? 'Resume dry-run scan'
    : 'Start dry-run scan';

  // The rate-limit banner: a live countdown to the window boundary. The wait is
  // interruptible, so Stop still works while it runs.
  const wait = $('rate-wait');
  if (live && j.rateLimited) {
    const rl = j.rateLimited;
    wait.textContent =
      'RATE LIMITED on ' + rl.operationName + ' \u2014 resuming in ' +
      countdown(rl.resetAtMs) +
      (rl.limit ? '. Budget ' + rl.requests + ' / ' + rl.limit + ' this window' : '') +
      '. The scan is waiting, not stuck; Stop still works.';
    wait.hidden = false;
  } else {
    wait.hidden = true;
  }

  // Cumulative pages with the per-stream breakdown, so a single number never
  // has to be explained and never appears to jump backwards.
  const active = (j.streams || []).filter((s) => s.status !== 'skipped');
  const breakdown = active.map((s) => s.label + ' ' + (s.pages || 0)).join(', ');
  const line = $('stream-line');
  if (j.streams && j.streams.length) {
    // ONE SOURCE OF TRUTH. This used to be the literal string 'running', which
    // meant the line said "running" whenever a currentStream existed - including
    // long after a run had died. The button derived from j.status and said
    // "Resume" at the same moment. A screen showing two different answers to
    // "is it working?" is the same defect as a countdown that does not tick.
    const cur = live ? (j.streams || []).find((s) => s.key === j.currentStream) : null;
    const idx = cur ? j.streams.indexOf(cur) + 1 : null;
    const state = runState(j, cur);
    line.textContent =
      (cur ? 'stream ' + idx + ' of ' + j.streams.length + ' \u00b7 ' + cur.label +
             ' \u00b7 ' + state
           : 'streams ' + state) +
      (breakdown ? '   |   pages ' + (j.pages || 0) + ' (' + breakdown + ')' : '') +
      (cur && cur.rate && cur.rate.limit
        ? '   |   ' + cur.rate.requests + ' / ' + cur.rate.limit + ' this window' +
          (cur.rate.totalRequests && cur.rate.totalRequests !== cur.rate.requests
            ? ' (' + cur.rate.totalRequests + ' total)' : '')
        : '');
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

  // DID THIS RUN ACTUALLY SEE THE ACCOUNT? A clean endReason per stream is not
  // an answer to that question. A run that reached a fraction of an account
  // must never read as complete. The full text lives in Scan details; when it
  // exists at all, the summary line above turns red and carries it.
  //
  // ONE COPY OF THE RULE. This used to be a second, hand-maintained transcription
  // of shortfallBanner() living in the UI - the same drift that the build-id
  // separator caused. The module owns the wording; the panel renders it.
  const short = $('shortfall');
  const c = j.completeness;
  const warning = c ? streams.shortfallBanner(c) : null;
  if (warning) {
    short.textContent = warning;
    short.hidden = false;
  } else {
    short.hidden = true;
  }

  // Cross-stream duplicates between pairs that should be DISJOINT are a defect
  // signal. posts/replies is excluded - those two overlap by design, and
  // flagging that as a model error would be crying wolf.
  const dupes = $('dupes');
  if (j.crossStreamDuplicates > 0) {
    dupes.className = 'banner bad';
    dupes.textContent =
      'CROSS-STREAM DUPLICATES: ' + j.crossStreamDuplicates + ' id(s) arrived from two ' +
      'streams that should be disjoint, so the model of these operations is wrong - ' +
      'worth investigating. Ids: ' +
      (j.crossStreamDuplicateIds || []).slice(0, 10).join(', ') +
      ((j.crossStreamDuplicateIds || []).length > 10 ? ' ...' : '');
    dupes.hidden = false;
  } else {
    dupes.hidden = true;
  }

  // Expected overlap is informational, never a warning.
  const overlap = $('overlap');
  if (j.crossStreamExpected > 0) {
    overlap.textContent =
      j.crossStreamExpected + ' item(s) appeared in both the posts and replies streams ' +
      'and were counted once. Those two overlap by design - UserOriginalsTimeline ' +
      'returns replies too - so this is expected, not a defect.';
    overlap.hidden = false;
  } else {
    overlap.hidden = true;
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
  // THE ACCOUNT TOTAL STILL HAS TO BE VISIBLE. It used to reach the screen only
  // inside the red shortfall banner, so suppressing that banner for a correct
  // filtered scan would have quietly taken the number away with it. It is
  // demoted into the details, not deleted, and it carries its provenance.
  if (j.reportedTotal) {
    totals.unshift('X reports ' + j.reportedTotal + ' item(s) on this account' +
      (j.reportedTotalSource ? ' (source: ' + j.reportedTotalSource + ')' : ''));
  }
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

  // LAST, because it summarises everything above it.
  renderScanSummary(j, c, warning);
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
  const resetIn = r.reset ? r.reset - Math.floor(Date.now() / 1000) : null;
  // Once the boundary has passed the cached remaining is stale by definition -
  // saying "0 / 50 remaining, resets in 0s" describes a window that no longer
  // exists and reads as a stuck stream.
  const elapsed = resetIn !== null && resetIn <= 0;
  text.textContent =
    r.operationName + ': ' +
    (elapsed
      ? 'window elapsed, budget refilled - awaiting the next response'
      : r.remaining + (limit ? ' / ' + limit : '') + ' remaining' +
        (resetIn !== null ? ', resets in ' + resetIn + 's' : '')) +
    (r.observed429s ? ' - ' + r.observed429s + ' x 429' : '') +
    (streams.filter((s) => s.rate).length > 1 ? '  (this operation only)' : '');
}

function preview(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 140 ? t.slice(0, 140) + '…' : t;
}

/**
 * One item, as a two-line block rather than a table row.
 *
 * Six columns cannot be read in a 380px side panel - the text was cut off and
 * needed horizontal scrolling, and the text is the column that matters: it is
 * how somebody recognises a post they did not mean to lose. This list is a
 * safety surface, so it has to be legible at the width it actually gets.
 */
function itemBlock(p) {
  const el = document.createElement('div');
  el.className = 'item';

  const head = document.createElement('div');
  head.className = 'item-head';

  const date = document.createElement('span');
  date.textContent = p.createdAt ? p.createdAt.slice(0, 10) : 'undated';

  const kind = document.createElement('span');
  kind.className = 'item-kind';
  kind.textContent = KIND_LABEL[p.kind] || p.kind || 'item';

  const stats = document.createElement('span');
  stats.className = 'item-stats';
  stats.textContent = (p.likeCount || 0) + ' likes \u00b7 ' + (p.retweetCount || 0) + ' reposts';

  const a = document.createElement('a');
  a.className = 'item-link';
  a.href = p.permalink;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = 'view';

  head.append(date, kind, stats, a);

  const text = document.createElement('div');
  const t = String(p.text || '').replace(/\s+/g, ' ').trim();
  text.className = t ? 'item-text' : 'item-text empty';
  text.textContent = t || '(no text)';

  el.append(head, text);
  return el;
}

const KIND_LABEL = { post: 'post', reply: 'reply', retweet: 'repost' };

function placeholder(container, message) {
  container.textContent = '';
  const p = document.createElement('div');
  p.className = 'placeholder';
  p.textContent = message;
  container.append(p);
}

function renderResults(posts, cfg) {
  const { matched } = filters.partition(posts || [], cfg);
  $('res-count').textContent = matched.length;

  const body = $('results-body');
  body.textContent = '';

  if (matched.length === 0) {
    placeholder(body, (posts && posts.length)
      ? 'Nothing matches these filters yet. ' + posts.length +
        ' items were read - try loosening a filter.'
      : 'Nothing scanned yet. Press "Scan my account" above.');
    $('res-more').hidden = true;
    return matched;
  }

  const frag = document.createDocumentFragment();
  for (const p of matched.slice(0, MAX_ROWS)) frag.append(itemBlock(p));
  body.append(frag);

  const more = $('res-more');
  if (matched.length > MAX_ROWS) {
    more.textContent =
      'Showing the first ' + MAX_ROWS + ' of ' + matched.length +
      '. Save the list to see them all.';
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
  renderExec(await store.get(store.KEY.EXEC));
  await refreshExecute();
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
    // `complete` requires BOTH that every stream finished AND that the union is
    // not materially short of what X reports for the account. Either condition
    // alone is a claim this run cannot support - a live run had every stream
    // report a clean cursor exhaustion while seeing 23% of the account.
    complete: Boolean(j.completeness && j.completeness.complete),
    incompleteReason: (j.completeness && j.completeness.reason) || null,
    accountTotalReportedByX: (j.completeness && j.completeness.reportedTotal) ?? null,
    // WHERE the total came from. The value landed correctly and the provenance
    // did not, which is the kind of gap that turns a verified number back into
    // an unverifiable one the moment anybody asks how it was obtained.
    accountTotalSource: j.reportedTotalSource || null,
    enumerated: (j.completeness && j.completeness.enumerated) ?? (j.enumerated || 0),
    shortfall: (j.completeness && j.completeness.shortfall) ?? null,
    percentOfAccount: (j.completeness && j.completeness.percent) ?? null,
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
      reportedTotalSource: s.reportedTotalSource || null,
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
    // Only between pairs that should be disjoint. posts/replies overlap is
    // expected and is counted separately.
    crossStreamDuplicates: j.crossStreamDuplicates || 0,
    crossStreamDuplicateIds: j.crossStreamDuplicateIds || [],
    expectedOverlapDeduped: j.crossStreamExpected || 0,
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

/* ----------------------------------------------------------------- execute --- */

/**
 * PHASE 2 CONTROLS.
 *
 * These render at all only when there is a completed scan FROM THIS SESSION
 * whose filters still match the ones on screen. Everything below is a
 * convenience for the user; the actual gate lives in the executor, which
 * re-derives the matched set and re-checks every condition itself. A panel
 * cannot be trusted to guard a delete - it is the thing an attacker or a bug
 * would reach first.
 *
 * Dry-run is the default and is re-asserted on every load. It is deliberately
 * NOT persisted: an armed state surviving a reload is how someone comes back to
 * a page an hour later and clicks the wrong button.
 */
let execSession = null;
let execPlanCount = 0;

/**
 * Has the kill log been saved during THIS panel session?
 *
 * Session-only, and conservative by design: after a reload we cannot know
 * whether the file still exists or was ever kept, so the reminder goes back to
 * saying it has NOT been saved. Over-reminding costs a glance; under-reminding
 * costs the only record of what was destroyed.
 */
let killLogSavedThisSession = false;

async function refreshExecute() {
  const job = await store.readJob();
  const results = await store.readResults();
  const config = readConfig();
  const card = $('exec-card');
  const blocked = $('exec-blocked');
  const body = $('exec-body');

  // Same conditions, same order, reworded. Nothing here decides anything: the
  // executor re-derives and re-checks every one of these before dispatching.
  const reasons = [];
  if (job.status !== store.JOB_DONE && job.status !== store.JOB_PARTIAL) {
    reasons.push('no finished scan yet');
  }
  if (!execSession || !job.scanSessionId || job.scanSessionId !== execSession.sessionId) {
    reasons.push('this scan is from an earlier session, so scan again');
  }
  if (job.scanConfigFingerprint &&
      job.scanConfigFingerprint !== execute.configFingerprint(config)) {
    reasons.push('the filters changed after the scan, so the list is out of date - scan again');
  }

  // The section is always visible so its place in the order is obvious, but the
  // CONTROLS still do not render until a scan has completed in this session.
  // Unchanged: this is the safety model, and the executor re-checks all of it
  // regardless of what the panel shows.
  card.hidden = false;

  if (job.status !== store.JOB_DONE && job.status !== store.JOB_PARTIAL) {
    blocked.textContent =
      'Scan first. Deleting is only offered for a list Surtr has just built, so ' +
      'you can see exactly what would go.';
    blocked.hidden = false;
    body.hidden = true;
    return;
  }

  if (reasons.length) {
    blocked.textContent = 'Not available yet \u2014 ' + reasons.join('; ') + '.';
    blocked.hidden = false;
    body.hidden = true;
    return;
  }
  blocked.hidden = true;
  body.hidden = false;

  const { matched } = filters.partition(results, config);
  execPlanCount = matched.length;
  const sum = execute.summarise(matched);
  $('exec-summary').textContent =
    sum.total + ' items match: ' + sum.byKind.post + ' posts, ' + sum.byKind.reply +
    ' replies, ' + sum.byKind.retweet + ' reposts' +
    (sum.oldest ? ', from ' + sum.oldest.slice(0, 10) + ' to ' + sum.newest.slice(0, 10) : '') +
    '.';

  // The 5 the test run would act on, shown BEFORE arming so they can be checked.
  // The exact five the first run would act on, shown before anything is armed.
  const preview = execute.selectTestItems(matched);
  const tb = $('test-preview');
  tb.textContent = '';
  if (preview.length === 0) {
    placeholder(tb, 'Nothing to delete yet.');
  } else {
    for (const p of preview) tb.append(itemBlock(p));
  }
  $('btn-test').disabled = preview.length === 0;

  const disc = await store.get(store.KEY.DISCOVERY);
  const w = (disc && disc.writes) || {};
  const unconfirmedOps = execute.unconfirmedOperations();
  for (const [op, id] of [['DeleteTweet', 'st-del-tweet'], ['DeleteRetweet', 'st-del-retweet']]) {
    const found = w[op] && w[op].queryId;
    // Two independent facts, and conflating them would be the same mistake as
    // "in bundle" vs "confirmed live": whether the queryId was FOUND, and
    // whether we know what a successful RESPONSE from it looks like.
    // Same two facts, same distinction, inside Diagnostics where it belongs.
    const shapeNote = unconfirmedOps.includes(op)
      ? '  \u2014 replies not yet confirmed'
      : '  \u2014 replies confirmed';
    setStatus($(id), Boolean(found),
      (found ? (w[op].confirmedLive ? found + '  [confirmed live]' : found + '  [in bundle]')
             : 'NOT FOUND - run Discover') + shapeNote);
  }

  const verified = (await store.get(store.KEY.TEST_VERIFIED)) === true;
  $('test-verified').checked = verified;

  const armed = $('exec-live').checked;
  const typed = $('exec-confirm').value.trim();
  // Shown in context, on the Delete section itself, rather than as a badge in
  // the header that is either shouting or lying depending on the moment.
  const mode = $('exec-mode');
  mode.textContent = armed ? 'ARMED' : 'Not armed';
  mode.className = armed ? 'chip armed' : 'chip';
  $('btn-execute').disabled =
    !armed || !verified || execPlanCount === 0 || String(execPlanCount) !== typed;
}

function preview_text(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 60) + '\u2026' : t;
}

function renderExec(x) {
  if (!x) return;
  const c = x.counts || {};
  $('x-done').textContent = x.done || 0;
  $('x-ok').textContent = c.succeeded || 0;
  $('x-deferred').textContent = c.deferred || 0;
  $('x-fail').textContent = c.failed || 0;

  const st = $('exec-status');
  // The word "complete" is reserved for a run that reached the end of its plan.
  // Anything else says what it actually was, because "done" is the word someone
  // remembers later when deciding whether the rest of their account is intact.
  const verdict = execute.runIsComplete(x.status) ? 'complete'
    : x.status === 'aborted' ? 'ABORTED - INCOMPLETE'
    : x.status;
  st.textContent = 'run ' + x.runId + (x.testMode ? ' (TEST)' : '') + ' \u2014 ' +
    verdict + ', ' + (x.done || 0) + ' of ' + x.total + ' dispatched' +
    (x.rateLimited ? ' \u2014 RATE LIMITED, resuming in ' +
      countdown(x.rateLimited.resetAtMs) : '') +
    (x.stoppedReason && x.status !== 'aborted' ? ' \u2014 ' + x.stoppedReason : '');
  st.hidden = false;

  // The abort banner. Prominent, and it carries the raw failure bodies, because
  // those are what the next fix is made of.
  const ab = $('exec-aborted');
  if (x.abortedByBreaker && x.breaker) {
    const b = x.breaker;
    ab.textContent =
      'RUN ABORTED BY THE CIRCUIT BREAKER after ' + (x.done || 0) + ' dispatched of ' +
      x.total + ': ' + b.reason + '. ' +
      (c.succeeded || 0) + ' succeeded, ' + (c.alreadyGone || 0) + ' already gone, ' +
      (c.failed || 0) + ' failed. The remaining ' +
      Math.max(0, (x.total || 0) - (x.done || 0)) + ' item(s) were NOT dispatched. ' +
      'This run is NOT complete. Failures: ' +
      (b.failures || []).map((f) => '[' + f.op + ' ' + f.targetId + ' HTTP ' + f.status +
        '] ' + (f.raw || f.detail || '')).join('   ');
    ab.hidden = false;
  } else {
    ab.hidden = true;
  }

  // DEFERRED items still exist. Saying so matters more than the count: the
  // failure this replaces was two live posts recorded as "failed", which reads
  // as an error to investigate rather than work still to do.
  const df = $('exec-deferred');
  if (c.deferred) {
    df.className = 'banner';
    df.textContent =
      c.deferred + ' item(s) DEFERRED - rate limited after ' +
      execute.MAX_WRITE_ATTEMPTS + ' attempts. They were NOT deleted and STILL EXIST. ' +
      'Re-scan and run again to pick them up. This is not an error.';
    df.hidden = false;
  } else {
    df.hidden = true;
  }

  // Succeeded, but with nothing to confirm it. Distinct from both "failed" and
  // from "we do not know this operation's success shape".
  const uok = $('exec-unverified-ok');
  if (c.unverifiedOk) {
    uok.className = 'banner';
    uok.textContent =
      c.unverifiedOk + ' item(s) succeeded but could not be verified - the original post ' +
      'no longer exists, so X had nothing to echo back. Not a failure.';
    uok.hidden = false;
  } else {
    uok.hidden = true;
  }

  const u = $('exec-unverified');
  const unconfirmed = execute.unconfirmedOperations();
  if (c.unverified) {
    u.className = 'banner';
    u.textContent =
      c.unverified + ' request(s) returned 200 with no errors, but the success shape for ' +
      (unconfirmed.length ? unconfirmed.join(' and ') : 'this operation') +
      ' has NOT been confirmed against a live response. They are counted as UNVERIFIED, ' +
      'not deleted. Check by hand and send the raw response from the kill log so the ' +
      'shape can be encoded.';
    u.hidden = false;
  } else {
    u.hidden = true;
  }

  // NOTHING IS DOWNLOADED AUTOMATICALLY. The reminder below is the entire
  // mechanism - see the note in lib/execute.js.
  updateKillLogReminder(x);
}

/**
 * Remind, do not act.
 *
 * When a run ends, the kill log is the only record of what was destroyed, and
 * losing it is unrecoverable. That justifies a loud reminder; it does not
 * justify writing the full text of deleted posts to somebody's disk on an event
 * they did not ask for.
 */
function updateKillLogReminder(x) {
  const el = $('killlog-reminder');
  if (!el) return;
  const terminal = x && x.status && x.status !== 'running';
  if (!terminal) {
    el.hidden = true;
    return;
  }
  (async () => {
    const log = (await store.get('surtr:killlog')) || [];
    if (log.length === 0) {
      el.hidden = true;
      return;
    }
    if (killLogSavedThisSession) {
      el.className = 'banner';
      el.textContent =
        'Kill log saved this session (' + log.length + ' entr' +
        (log.length === 1 ? 'y' : 'ies') + '). It is still the only record of what was ' +
        'destroyed - keep the file somewhere you will find it.';
    } else {
      el.className = 'banner bad';
      el.textContent =
        'THE KILL LOG HAS NOT BEEN SAVED. ' + log.length + ' entr' +
        (log.length === 1 ? 'y' : 'ies') + ' recording what this run destroyed - the full ' +
        'text, ids and permalinks - exist only in this extension\u2019s storage. This is ' +
        'the ONLY record. Download it now.';
    }
    el.hidden = false;
  })();
}

async function downloadKillLog(kind) {
  const log = await store.get('surtr:killlog');
  if (!log || log.length === 0) return;
  // Only a deliberate download sets this, which is the only kind there is.
  killLogSavedThisSession = true;
  if (kind === 'csv') {
    download(killlog_toCsv(log), 'text/csv', 'surtr-killlog-' + stamp() + '.csv');
    return;
  }
  // The export states the run's REAL status. A kill log from an aborted run
  // read later, out of context, must not look like the record of a completed
  // sweep - that is the reading that would let somebody conclude the rest of
  // their account was already processed.
  const x = (await store.get(store.KEY.EXEC)) || null;
  const run = x ? {
    runId: x.runId,
    status: x.status,
    complete: execute.runIsComplete(x.status),
    testMode: Boolean(x.testMode),
    dispatched: x.done || 0,
    planned: x.total || 0,
    notDispatched: Math.max(0, (x.total || 0) - (x.done || 0)),
    abortedByBreaker: Boolean(x.abortedByBreaker),
    abortReason: (x.breaker && x.breaker.reason) || x.stoppedReason || null,
    breakerFailures: (x.breaker && x.breaker.failures) || null,
    counts: x.counts || null,
  } : null;
  download(JSON.stringify({
    tool: 'Surtr', kind: 'kill-log', generatedAt: new Date().toISOString(),
    run, entries: log,
  }, null, 2), 'application/json', 'surtr-killlog-' + stamp() + '.json');
}

// Inlined rather than imported: killlog.js needs `store` injected and the panel
// only ever formats, never writes.
function killlog_toCsv(log) {
  const cols = ['attemptedAt', 'runId', 'testMode', 'op', 'targetId', 'id', 'kind',
    'sourceTweetId', 'createdAt', 'outcome', 'outcomeDetail', 'responseStatus',
    'resolvedAt', 'likeCount', 'retweetCount', 'replyCount', 'stream', 'permalink', 'text'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [cols.join(',')];
  for (const e of log || []) out.push(cols.map((c) => esc(e[c])).join(','));
  return out.join('\r\n');
}

async function dispatchExecute(testMode) {
  const config = readConfig();
  const payload = {
    type: 'SURTR_EXECUTE',
    testMode,
    armed: testMode ? true : $('exec-live').checked === true,
    dryRun: false,
    confirmCount: testMode ? undefined : Number($('exec-confirm').value.trim()),
    config,
  };
  if (testMode) {
    const results = await store.readResults();
    const { matched } = filters.partition(results, config);
    payload.confirmCount = execute.selectTestItems(matched).length;
  }
  const r = await send(payload);
  if (!r.ok) {
    $('exec-blocked').textContent = 'EXECUTION REFUSED: ' + (r.error || 'unknown');
    $('exec-blocked').hidden = false;
  }
  await paint();
}

$('btn-test').addEventListener('click', async () => {
  const n = Number($('test-preview').childElementCount);
  if (!window.confirm(
    'Permanently delete ' + n + ' item(s)?\n\nThis is the 5-item test run. It cannot be ' +
    'undone. The kill log records what is attempted before each request.')) return;
  await dispatchExecute(true);
});

$('btn-execute').addEventListener('click', async () => {
  if (!window.confirm(
    'Permanently delete ' + execPlanCount + ' item(s)?\n\nThis CANNOT be undone, by this ' +
    'tool or by X. Download the kill log afterwards - it is the only record.')) return;
  await dispatchExecute(false);
});

$('btn-exec-stop').addEventListener('click', async () => { await send({ type: 'SURTR_STOP' }); });
$('btn-kill-json').addEventListener('click', async () => {
  await downloadKillLog('json');
  updateKillLogReminder(await store.get(store.KEY.EXEC));
});
$('btn-kill-csv').addEventListener('click', async () => {
  await downloadKillLog('csv');
  updateKillLogReminder(await store.get(store.KEY.EXEC));
});

$('test-verified').addEventListener('change', async () => {
  await store.set(store.KEY.TEST_VERIFIED, $('test-verified').checked === true);
  await refreshExecute();
});

for (const id of ['exec-live', 'exec-confirm']) {
  $(id).addEventListener('input', refreshExecute);
  $(id).addEventListener('change', refreshExecute);
}

/* --------------------------------------------------------------- countdown --- */

/** mm:ss until an absolute epoch-ms boundary, or "any moment" once it passes. */
function countdown(untilMs) {
  const left = Math.round((Number(untilMs) - Date.now()) / 1000);
  // Past the boundary the honest answer is not "0s" - that reads as stuck. The
  // window has refilled and the next request will say so.
  if (!(left > 0)) return 'any moment';
  const m = Math.floor(left / 60);
  const s = left % 60;
  return m + ':' + String(s).padStart(2, '0');
}

/**
 * The single description of what the run is doing, used by the status line.
 *
 * Derived from job.status, never from the presence of leftover state. A stream
 * object hanging around from a finished or crashed run must not be able to
 * make the panel claim work is in progress.
 */
function runState(j, cur) {
  const live = j.status === store.JOB_RUNNING || j.status === store.JOB_STOPPING;
  if (!live) {
    return j.status === store.JOB_ERROR ? 'STOPPED (error)'
      : j.status === store.JOB_PARTIAL ? 'finished (partial)'
      : j.status === store.JOB_DONE ? 'finished'
      : 'idle';
  }
  if (j.rateLimited) return 'RATE LIMITED, resuming in ' + countdown(j.rateLimited.resetAtMs);
  if (j.status === store.JOB_STOPPING) return 'stopping';
  return cur ? cur.status : 'running';
}

/**
 * The countdown has to tick on its own.
 *
 * Storage does not change while a stream sleeps, so the storage.onChanged
 * repaint never fires and the panel would sit on a number that never moves -
 * which looks exactly like the hang it is supposed to distinguish itself from.
 * This is the one thing in the panel driven by a timer rather than by state.
 */
setInterval(async () => {
  const job = await store.readJob();
  if (!job || !job.rateLimited) return;
  renderJob(job);
}, 1000);

/* ------------------------------------------------------------------ donate --- */

/**
 * A bare target="_blank" anchor does not reliably navigate from inside a side
 * panel, so the click is handled explicitly. The href stays on the element as
 * the semantic target - and so the destination is visible to anyone reading the
 * markup - this just makes it actually open.
 *
 * chrome.tabs.create needs no "tabs" permission: that permission gates reading
 * a tab's URL and title, not opening one.
 */
const DONATE_URL = 'https://donate.grimnirworks.com/';

$('donate').addEventListener('click', (ev) => {
  ev.preventDefault();
  if (chrome.tabs && chrome.tabs.create) {
    chrome.tabs.create({ url: DONATE_URL });
  } else {
    window.open(DONATE_URL, '_blank', 'noopener,noreferrer');
  }
});

/* -------------------------------------------------------------------- build --- */

/**
 * Which code is actually loaded, fingerprinted from the loaded files.
 *
 * A live run was once interpreted against the wrong build because the extension
 * had not been reloaded, and there was no way to tell from the panel. This is
 * the answer to "which build am I looking at" - compare it with
 * `node tools/build-id.mjs`.
 */
(async () => {
  try {
    const b = await computeBuildId();
    setStatus($('st-build'), b.missing.length === 0,
      b.id + (b.missing.length ? '  MISSING ' + b.missing.join(', ') : ''));
    $('st-build').title = 'Fingerprint of the ' + b.files +
      ' loaded files. Compare with: node tools/build-id.mjs';
  } catch (e) {
    setStatus($('st-build'), false, 'unavailable: ' + (e && e.message ? e.message : e));
  }
})();

/* ------------------------------------------------------------------- boot --- */

(async () => {
  // DRY RUN IS RE-ASSERTED ON EVERY LOAD and is never persisted. An armed state
  // that survived a reload is how somebody returns to this page later and
  // clicks a button meaning something other than what they left it meaning.
  $('exec-live').checked = false;
  $('exec-confirm').value = '';

  execSession = await send({ type: 'SURTR_SESSION' });
  await paint();
  const ping = await send({ type: 'SURTR_PING' });
  setStatus($('st-tab'), Boolean(ping.ok), ping.ok ? 'connected' : (ping.error || 'not found'));
})();
