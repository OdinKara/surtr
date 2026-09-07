/**
 * Scrape the bearer token and GraphQL queryIds out of X's live JS bundle.
 *
 * WHY THIS EXISTS AT ALL: every X bulk-delete tool that hardcodes a bearer
 * token or a queryId is broken within weeks, because both rotate whenever X
 * ships a frontend build. So Surtr reads them from the bundle the page is
 * ALREADY running. If X changes them tomorrow, Surtr keeps working with no
 * update from us. That is the single most important design decision in the
 * project and the reason nothing here is a constant.
 *
 * There is deliberately NO silent fallback to a last-known-good id. A stale
 * queryId does not fail cleanly - it fails as a 404 that looks like "your posts
 * are gone". If discovery fails we say so, and offer manual override inputs.
 *
 * This module must run in the x.com origin (the content script), because it
 * reads the page's own script tags and performance entries.
 */

/**
 * DEPENDENCIES ARE INJECTED, NOT IMPORTED.
 *
 * This module deliberately does not `import * as store from './store.js'`. A
 * web-accessible module fetched through a `use_dynamic_url` URL cannot resolve
 * its own static imports - the module loader fails the whole graph with
 * "Failed to fetch dynamically imported module", naming the entry file rather
 * than the dependency that actually failed. So every module under lib/ has to
 * be a LEAF, and content/executor.js wires the graph up itself. See DEV.md.
 */
let store = null;

/** Called by content/executor.js immediately after importing this module. */
export function provide(deps) {
  if (!deps || !deps.store) throw new Error('lib/discovery.js: provide() needs { store }.');
  store = deps.store;
}

/** Operations phase 1 needs unconditionally. Enumeration only. */
export const REQUIRED_OPERATIONS = ['UserByScreenName'];

/**
 * Timeline operations, in priority order, PER STREAM.
 *
 * X split the old single profile timeline into tab-scoped operations, and our
 * scope needs all THREE of them. Confirmed live, all 200:
 *
 *   UserOriginalsTimeline   Posts tab     posts only, NO retweets
 *   UserRepostsTimeline     Reposts tab   this is where retweets live
 *   UserRepliesTimeline     Replies tab   where replies live
 *
 * `UserTweetsAndReplies` was absent from all 364 requests in a live capture and
 * is a dead name, kept last in the posts list only so an older deployment still
 * resolves rather than failing outright.
 *
 * PRESENCE IN THE BUNDLE IS NOT PROOF THE SITE SERVES IT. The bundle carries
 * query ids for operations the running site may never call, which is exactly
 * how `UserTweetsAndReplies` looked fine for so long. Everything is reported as
 * "in bundle" until a request against it actually returns.
 */
export const STREAMS = {
  posts: {
    label: 'posts',
    candidates: ['UserOriginalsTimeline', 'UserTweets', 'UserTweetsAndReplies'],
  },
  reposts: {
    label: 'reposts',
    candidates: ['UserRepostsTimeline', 'UserRetweetsTimeline'],
  },
  replies: {
    label: 'replies',
    candidates: ['UserRepliesTimeline'],
  },
};

export const STREAM_KEYS = Object.keys(STREAMS);

/**
 * PHASE 2 write operations, discovered exactly like the read ones.
 *
 * Nothing about these is assumed to resemble the read operations - not the
 * queryId shape, not the method, not the rate limit, not the feature
 * requirements. They are looked up in the bundle by name and reported with the
 * same "in bundle" / "confirmed live" distinction, because a write queryId that
 * is present in the JavaScript but no longer served would fail in exactly the
 * way UserTweetsAndReplies did - except against a delete.
 */
export const WRITE_OPERATIONS = ['DeleteTweet', 'DeleteRetweet'];

/** Every candidate across both streams. */
export const TIMELINE_CANDIDATES =
  STREAM_KEYS.flatMap((k) => STREAMS[k].candidates);

/** Everything worth looking for in one list, for the bundle scan. */
export const OPERATIONS = [
  ...REQUIRED_OPERATIONS, ...TIMELINE_CANDIDATES, ...WRITE_OPERATIONS,
];

// The bearer X's web client ships. Not a secret and not ours - it is public in
// every page load - but we still never hardcode the value, only its shape.
const BEARER_RE = /AAAAAAAAA[A-Za-z0-9%]{80,}/;

const ASSET_HOST = 'abs.twimg.com';
// api.<hash>.js and main.<hash>.js are where the GraphQL operation table lives.
// CONFIRMED still correct for the logged-in app: the initiator of the live
// GraphQL calls reads main.<hash>.js. The Vite-style entry-client-* naming
// applies only to the LOGGED-OUT shell, which carries no operation table at all,
// so it is irrelevant here. We try these first and widen only if they come up
// empty.
const PRIORITY_RE = /(api|main)\.[0-9a-f]+\.js/;

/**
 * Every place a bundle URL can be observed. Three sources rather than one
 * because which of them is populated depends on how far the SPA has booted.
 */
export function candidateScriptUrls() {
  const urls = new Set();

  for (const el of document.querySelectorAll('script[src]')) {
    if (el.src) urls.add(el.src);
  }
  for (const el of document.querySelectorAll('link[rel="preload"][as="script"]')) {
    if (el.href) urls.add(el.href);
  }
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (e.name) urls.add(e.name);
    }
  } catch {
    // performance entries are best-effort; the DOM sources above are enough.
  }

  const all = [...urls].filter((u) => {
    try {
      const p = new URL(u, location.href);
      return p.hostname === ASSET_HOST && p.pathname.endsWith('.js');
    } catch {
      return false;
    }
  });

  const priority = all.filter((u) => PRIORITY_RE.test(u));
  const rest = all.filter((u) => !PRIORITY_RE.test(u));
  return [...priority, ...rest];
}

/** Pull the bearer token out of bundle text. */
export function findBearer(text) {
  const m = BEARER_RE.exec(text);
  return m ? m[0] : null;
}

/**
 * Pull one operation's queryId out of bundle text.
 *
 * Key order inside the object literal is NOT stable between builds - some ship
 * {queryId, operationName}, some ship {operationName, ..., queryId}. Matching
 * only one direction is how these scrapers quietly stop finding half the
 * operations, so we match both.
 */
export function findQueryId(text, operationName) {
  const name = operationName.replace(/[^\w]/g, '');
  const patterns = [
    new RegExp('queryId:"([\\w-]+)",operationName:"' + name + '"'),
    new RegExp('operationName:"' + name + '",[^}]*?queryId:"([\\w-]+)"'),
    // Same two shapes, quoted keys. Cheap to try, and some builds minify this way.
    new RegExp('"queryId":"([\\w-]+)","operationName":"' + name + '"'),
    new RegExp('"operationName":"' + name + '",[^}]*?"queryId":"([\\w-]+)"'),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return m[1];
  }
  return null;
}

async function fetchText(url) {
  const res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' fetching ' + url);
  return res.text();
}

/**
 * Discover bearer + queryIds, using the cache when the bundle URL is unchanged.
 *
 * Returns { bundleUrl, bearer, queryIds: {op: id}, missing: [op], scanned: n }.
 * `missing` being non-empty is a REPORTED failure, not a soft one - the caller
 * refuses to scan and the panel shows manual override inputs.
 */
export async function discover({ force = false, onProgress = () => {} } = {}) {
  const candidates = candidateScriptUrls();
  if (candidates.length === 0) {
    throw new Error(
      'No x.com script bundles visible on this page. Open a normal x.com tab ' +
      '(not a login or error page) and try again.'
    );
  }

  if (!force) {
    const cached = await store.readDiscovery(candidates[0]);
    if (cached && cached.bearer && cached.missing && cached.missing.length === 0) {
      onProgress('using cached discovery for ' + shortName(cached.bundleUrl));
      return cached;
    }
  }

  let bearer = null;
  const queryIds = {};
  let scanned = 0;
  let firstUrl = candidates[0];

  for (const url of candidates) {
    const stillNeeded = OPERATIONS.filter((op) => !queryIds[op]);
    if (bearer && stillNeeded.length === 0) break;

    let text;
    try {
      text = await fetchText(url);
    } catch (e) {
      onProgress('skipped ' + shortName(url) + ': ' + e.message);
      continue;
    }
    scanned += 1;

    if (!bearer) {
      const b = findBearer(text);
      if (b) {
        bearer = b;
        firstUrl = url;
        onProgress('bearer token found in ' + shortName(url));
      }
    }
    for (const op of stillNeeded) {
      const id = findQueryId(text, op);
      if (id) {
        queryIds[op] = id;
        onProgress('queryId for ' + op + ' found in ' + shortName(url));
      }
    }
  }

  const record = buildRecord({
    bundleUrl: candidates[0],
    bearerBundleUrl: firstUrl,
    bearer,
    queryIds,
    scanned,
  });

  await store.writeDiscovery(record);
  return record;
}

/**
 * Resolve each stream independently and say which one failed.
 *
 * Both streams are selected separately because they fail separately: the posts
 * operation resolving while the reposts one does not is a completely different
 * problem from the reverse, and collapsing them into one "discovery failed"
 * tells you nothing about which half X renamed.
 */
export function buildRecord({ bundleUrl, bearerBundleUrl, bearer, queryIds, scanned, manual }) {
  const timelines = {};
  const missing = REQUIRED_OPERATIONS.filter((op) => !queryIds[op]);

  for (const key of STREAM_KEYS) {
    const found = STREAMS[key].candidates.filter((op) => queryIds[op]);
    timelines[key] = {
      label: STREAMS[key].label,
      selected: found[0] || null,
      found,
      // Set to the operation name only once a request against it has actually
      // returned. Until then nothing may claim the site serves it - being in
      // the bundle is not the same thing, which is precisely how a dead
      // operation name went unnoticed for so long.
      confirmedLive: null,
    };
    if (!timelines[key].selected) {
      missing.push(STREAMS[key].label + ' timeline operation');
    }
  }

  // Write operations are reported separately and are NOT part of `missing`:
  // a scan must not be blocked because a delete operation could not be found.
  // Phase 2 checks these itself and refuses to arm without them.
  const writes = {};
  for (const op of WRITE_OPERATIONS) {
    writes[op] = {
      queryId: queryIds[op] || null,
      confirmedLive: null,
    };
  }

  return {
    bundleUrl,
    bearerBundleUrl,
    bearer,
    queryIds,
    timelines,
    writes,
    // Candidates present in the bundle that no stream selected. Where a rename
    // shows up first.
    unusedCandidates: TIMELINE_CANDIDATES.filter(
      (op) => queryIds[op] && !STREAM_KEYS.some((k) => timelines[k].selected === op)),
    missing: bearer ? missing : ['bearer', ...missing],
    scanned,
    manual: Boolean(manual),
    discoveredAt: new Date().toISOString(),
  };
}

/**
 * Record that a stream's operation actually answered. Called by the executor
 * after that stream's first successful page, and the only thing that upgrades
 * the panel from "in bundle" to "confirmed live".
 */
/** A write operation answered. Same evidence standard as the read streams. */
export async function markWriteConfirmedLive(operationName) {
  const rec = (await store.get(store.KEY.DISCOVERY)) || null;
  if (!rec || !rec.writes || !rec.writes[operationName]) return null;
  rec.writes[operationName].confirmedLive = operationName;
  await store.writeDiscovery(rec);
  return rec;
}

export async function markConfirmedLive(streamKey, operationName) {
  const rec = (await store.get(store.KEY.DISCOVERY)) || null;
  if (!rec || !rec.timelines || !rec.timelines[streamKey]) return null;
  rec.timelines[streamKey].confirmedLive = operationName;
  await store.writeDiscovery(rec);
  return rec;
}

/**
 * Apply values typed into the panel's manual override. Stored the same way as
 * a discovered record so the rest of the code cannot tell the difference - but
 * flagged `manual: true` so the panel can say where the values came from.
 */
export async function applyManual({ bearer, queryIds }) {
  const merged = buildRecord({
    bundleUrl: 'manual-override',
    bearerBundleUrl: 'manual-override',
    bearer: bearer || null,
    queryIds: queryIds || {},
    scanned: 0,
    manual: true,
  });
  await store.writeDiscovery(merged);
  return merged;
}

function shortName(url) {
  try {
    return new URL(url).pathname.split('/').pop();
  } catch {
    return String(url);
  }
}
