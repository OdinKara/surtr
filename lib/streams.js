/**
 * Two-stream enumeration: planning, merging, and reporting.
 *
 * PURE FUNCTIONS ONLY - no fetch, no chrome.*, no DOM. This is the merge logic
 * pulled out of the executor precisely so it can be tested without a browser,
 * because the thing it has to get right (never enumerating the same id twice,
 * and noticing when that happens) is not something to verify by inspection.
 *
 * This module is a LEAF, like everything under lib/. See DEV.md.
 *
 * WHY TWO STREAMS. X split the profile timeline into tab-scoped operations:
 * UserOriginalsTimeline serves posts (and replies) but NOT retweets, and
 * retweets live in UserRepostsTimeline. Scope is posts + retweets, so
 * enumeration walks both - sequentially, posts first.
 */

/** Order is deliberate: posts first. See planStreams. */
export const STREAM_ORDER = ['posts', 'reposts'];

export const STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/** Kinds each stream is expected to carry, for the skip decision. */
const STREAM_KINDS = {
  posts: ['post', 'reply'],
  reposts: ['retweet'],
};

const LABEL = { posts: 'posts', reposts: 'reposts' };

export function emptyStreamState(key, op) {
  return {
    key,
    label: LABEL[key] || key,
    op: op || null,
    status: STATUS.PENDING,
    pages: 0,
    enumerated: 0,
    cursor: null,
    seenCursors: [],
    endReason: null,
    ceilingSuspected: false,
    error: null,
    reportedTotal: null,
    // Rate-limit observations for THIS operation only. Never merged with
    // another stream's - different endpoints may carry different budgets and a
    // combined figure is wrong for both of them.
    rate: null,
  };
}

/**
 * Decide which streams run, in order.
 *
 * Posts always runs: UserOriginalsTimeline carries posts AND replies, so there
 * is no filter setting that makes it pointless.
 *
 * Reposts is SKIPPED when the filter excludes retweets. Walking it would spend
 * rate budget on entries every one of which is about to be filtered out. The
 * skip is recorded as `endReason: 'skipped-by-filter'` and must be surfaced in
 * the panel AND the export, at the same prominence as any other reason a run is
 * incomplete: a scan that quietly did less work than the user assumed is the
 * same failure as an export that looks complete and is not.
 *
 * A stream whose operation never resolved is `failed` with `no-operation`, not
 * skipped - those are different problems and must not read the same.
 */
export function planStreams({ config, timelines }) {
  const kinds = (config && config.includeKinds) || [];
  const out = [];

  for (const key of STREAM_ORDER) {
    const op = timelines && timelines[key] ? timelines[key].selected : null;
    const s = emptyStreamState(key, op);

    if (!op) {
      s.status = STATUS.FAILED;
      s.endReason = 'no-operation';
      s.error = 'No ' + s.label + ' operation resolved from the bundle.';
      out.push(s);
      continue;
    }

    // An empty kind list means "no kind filter", i.e. everything is wanted.
    const wanted = kinds.length === 0 || STREAM_KINDS[key].some((k) => kinds.includes(k));
    if (!wanted) {
      s.status = STATUS.SKIPPED;
      s.endReason = 'skipped-by-filter';
      out.push(s);
      continue;
    }

    out.push(s);
  }
  return out;
}

/**
 * Merge one page of results into the union, deduplicating by id.
 *
 * CROSS-STREAM DUPLICATES ARE A DEFECT SIGNAL, NOT HYGIENE. The two streams are
 * tab-scoped and should be disjoint: a post cannot be a repost. If the same id
 * arrives from both, our model of these operations is wrong - X is serving
 * something we do not understand - and that is a finding worth reporting, not
 * noise to swallow.
 *
 * So the dedupe happens (correctness first: the id must appear once in the
 * results), and the collision is COUNTED and the ids RECORDED, then surfaced in
 * the panel and the export. A non-zero count means go and look.
 *
 * `idOwner` maps id -> the stream key that first produced it, and persists
 * across the whole run (including across a resume, rebuilt from the results).
 *
 * Returns { added, withinStream, crossStream } where crossStream is the list of
 * ids that arrived from a different stream than the one that first produced
 * them.
 */
export function mergePage({ all, idOwner, posts, streamKey }) {
  let added = 0;
  const withinStream = [];
  const crossStream = [];

  for (const post of posts || []) {
    const id = String(post.id);
    const owner = idOwner.get(id);

    if (owner === undefined) {
      idOwner.set(id, streamKey);
      all.push({ ...post, _stream: streamKey });
      added += 1;
      continue;
    }
    if (owner === streamKey) {
      // Ordinary within-stream repeat: overlapping pages, a cursor replay.
      // Expected, uninteresting.
      withinStream.push(id);
      continue;
    }
    crossStream.push(id);
  }

  return { added, withinStream, crossStream };
}

/** Rebuild the id -> stream ownership map from an existing result set. */
export function ownerMapFrom(all) {
  const m = new Map();
  for (const p of all || []) {
    const id = String(p.id);
    if (!m.has(id)) m.set(id, p._stream || 'posts');
  }
  return m;
}

/**
 * One sentence per stream, never collapsed into a single verdict for the run.
 *
 * Each stream terminates for its own reason: a run can hit X's ~3,200 ceiling
 * on posts and end on genuine cursor exhaustion on reposts. Picking one of
 * those to report would be a claim about the other that we did not measure.
 */
export function streamReport(stream, ceilingHint) {
  const n = stream.enumerated;
  const where = stream.label + ' (' + (stream.op || 'no operation') + ')';

  switch (stream.status) {
    case STATUS.SKIPPED:
      return where + ': SKIPPED - the filter excludes this kind, so the stream ' +
        'was not walked at all. Nothing from it is in these results.';
    case STATUS.FAILED:
      return where + ': FAILED after ' + stream.pages + ' page(s) - ' +
        (stream.error || 'unknown error') +
        (n > 0 ? '. The ' + n + ' item(s) captured before the failure ARE included.' : '');
    case STATUS.PENDING:
      return where + ': not started.';
    case STATUS.RUNNING:
      return where + ': running, ' + n + ' item(s) so far.';
    default:
      break;
  }
  if (stream.endReason === 'stopped') {
    return where + ': stopped by you at ' + n + ' item(s). Progress is ' +
      'checkpointed; starting again resumes this stream from its last page.';
  }
  if (stream.ceilingSuspected) {
    return where + ": reached X's timeline limit at " + n + ' item(s). Older ' +
      'entries exist and are still publicly reachable by direct URL, but this ' +
      'method cannot see them. Requesting your X data archive is the only ' +
      'complete enumeration.';
  }
  if (stream.endReason === 'cursor-repeat') {
    return where + ': ended at ' + n + ' item(s) because X returned a cursor it ' +
      'had already given us. That usually means the end of what it will serve, ' +
      'but it is not a clean end-of-history signal - treat this as a floor.';
  }
  return where + ': complete, ' + n + ' item(s). X ran out of cursor before the ' +
    '~' + ceilingHint + ' timeline limit, so this is the full reachable history ' +
    'for this stream.';
}

/** Cumulative page count across streams, plus the per-stream breakdown. */
export function pagesBreakdown(streams) {
  const total = (streams || []).reduce((a, s) => a + (s.pages || 0), 0);
  const parts = (streams || [])
    .filter((s) => s.status !== STATUS.SKIPPED)
    .map((s) => s.label + ' ' + (s.pages || 0));
  return { total, text: parts.length ? parts.join(', ') : '' };
}

/**
 * Overall run status from the per-stream states.
 *
 * PARTIAL, NOT ERROR, when anything was enumerated and anything failed or was
 * skipped. Nothing already enumerated is ever discarded, so a run that got half
 * the data is not the same as a run that got none, and calling it "error" would
 * invite throwing away results that are perfectly good.
 */
export function overallStatus(streams) {
  const active = (streams || []).filter((s) => s.status !== STATUS.SKIPPED);
  const anyFailed = active.some((s) => s.status === STATUS.FAILED);
  const anySkipped = (streams || []).some((s) => s.status === STATUS.SKIPPED);
  const allDone = active.length > 0 && active.every((s) => s.status === STATUS.DONE);

  if (anyFailed) return active.some((s) => s.enumerated > 0) ? 'partial' : 'error';
  if (allDone && anySkipped) return 'partial';
  if (allDone) return 'done';
  return 'partial';
}
