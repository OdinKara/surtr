/**
 * Multi-stream enumeration: planning, merging, completeness, and reporting.
 *
 * PURE FUNCTIONS ONLY - no fetch, no chrome.*, no DOM. This is the merge logic
 * pulled out of the executor precisely so it can be tested without a browser,
 * because the thing it has to get right (never enumerating the same id twice,
 * and noticing when that happens) is not something to verify by inspection.
 *
 * This module is a LEAF, like everything under lib/. See DEV.md.
 *
 * WHY THREE STREAMS. X split the profile timeline into tab-scoped operations:
 *
 *   UserOriginalsTimeline   posts (and replies), NO retweets
 *   UserRepostsTimeline     retweets
 *   UserRepliesTimeline     replies
 *
 * Walking only the first two enumerated 604 items on an account reporting
 * 2,616, and every stream still reported a clean cursor exhaustion - true per
 * stream, and badly misleading about the account. Replies are the majority of a
 * normal account, so they are a stream, not an optional extra. See
 * `completeness()` for the check that now stops that from reading as success.
 */

/** Order is deliberate: posts, then reposts, then replies. See planStreams. */
export const STREAM_ORDER = ['posts', 'reposts', 'replies'];

export const STATUS = {
  PENDING: 'pending',
  RUNNING: 'running',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/**
 * Kinds each stream is expected to carry, for the skip decision.
 *
 * `posts` lists 'reply' as well as 'post' because UserOriginalsTimeline
 * genuinely returns both - "Originals" means not-retweets, not not-replies.
 * That is also why posts and replies can legitimately overlap; see
 * EXPECTED_OVERLAP.
 */
const STREAM_KINDS = {
  posts: ['post', 'reply'],
  reposts: ['retweet'],
  replies: ['reply'],
};

const LABEL = { posts: 'posts', reposts: 'reposts', replies: 'replies' };

/**
 * Stream pairs that may legitimately return the same id.
 *
 * UserOriginalsTimeline returns entries carrying in_reply_to_status_id_str -
 * confirmed in a live capture - so a self-reply can appear in BOTH the posts
 * and replies streams. That is X's model, not a defect in ours, and calling it
 * "the model is wrong" would be crying wolf.
 *
 * Every other pair should be disjoint: a post cannot be a repost. A collision
 * there really does mean our model of these operations is wrong.
 */
const EXPECTED_OVERLAP = new Set(['posts|replies']);

/** Canonical key for a pair of streams, order-independent. */
export function pairKey(a, b) {
  return [a, b].sort().join('|');
}

/** Is a collision between these two streams expected, or a defect signal? */
export function isExpectedOverlap(a, b) {
  return EXPECTED_OVERLAP.has(pairKey(a, b));
}

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
    crossStream.push({ id, from: streamKey, owner });
  }

  return {
    added,
    withinStream,
    crossStream,
    // Split by whether the pair is allowed to overlap. Only `unexpected` is a
    // defect signal; `expected` is posts/replies doing what X does.
    expected: crossStream.filter((c) => isExpectedOverlap(c.from, c.owner)),
    unexpected: crossStream.filter((c) => !isExpectedOverlap(c.from, c.owner)),
  };
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
  // Deliberately scoped to THIS STREAM. A clean endReason means this stream
  // exhausted its cursor; it says nothing whatever about whether the account
  // was fully enumerated. Conflating the two is how a run that reached 23% of
  // an account read as "complete".
  return where + ': this stream is fully enumerated, ' + n + ' item(s). X ran ' +
    'out of cursor before the ~' + ceilingHint + ' limit. This is a statement ' +
    'about this stream only, not about the account.';
}

/* ------------------------------------------------------- completeness --- */

/**
 * Material shortfall threshold. Below this fraction of what X reports for the
 * account, the run is not allowed to describe itself as complete.
 *
 * It is a fraction rather than a count because the acceptable gap scales: a
 * handful missing from 2,600 is rounding (deleted items, visibility), a
 * thousand is a stream nobody walked.
 */
export const COMPLETENESS_TOLERANCE = 0.95;

/**
 * Did this run actually see the account?
 *
 * `complete` requires BOTH that every stream finished AND that the union is not
 * materially short of what X reports. A live run enumerated 604 items against
 * an account reporting 2,616 and every stream reported a clean cursor
 * exhaustion - which was true per stream and badly misleading about the whole,
 * because ~2,000 replies lived in a stream that was not being walked.
 */
export function completeness({ streams, enumerated, reportedTotal }) {
  const list = streams || [];
  const allSettled = list.length > 0 && list.every(
    (s) => s.status === STATUS.DONE || s.status === STATUS.SKIPPED);
  const allDone = list.length > 0 && list.every((s) => s.status === STATUS.DONE);
  const skipped = list.filter((s) => s.status === STATUS.SKIPPED);
  const failed = list.filter((s) => s.status === STATUS.FAILED);

  const total = Number.isFinite(reportedTotal) ? reportedTotal : null;
  const seen = Number(enumerated) || 0;
  const shortfall = total === null ? null : Math.max(0, total - seen);
  const material = total !== null && total > 0 && seen < total * COMPLETENESS_TOLERANCE;

  const reasons = [];
  if (failed.length) {
    reasons.push(failed.map((s) => s.label).join(' and ') + ' stream(s) failed');
  }
  if (skipped.length) {
    reasons.push(skipped.map((s) => s.label).join(' and ') +
      ' stream(s) skipped by the kind filter');
  }
  if (material) {
    const missingStreams = list
      .filter((s) => s.status !== STATUS.DONE)
      .map((s) => s.label);
    reasons.push(
      seen + ' of ' + total + ' reported by X (' + Math.round((seen / total) * 100) +
      '%), ' + shortfall + ' unaccounted for' +
      (missingStreams.length
        ? ' - most likely the ' + missingStreams.join(' and ') + ' stream(s)'
        : ' - cause unknown, every stream ran to completion, so this needs looking at'));
  }

  return {
    complete: Boolean(allDone && !material),
    allSettled,
    enumerated: seen,
    reportedTotal: total,
    shortfall,
    materialShortfall: material,
    percent: total ? Math.round((seen / total) * 100) : null,
    reason: reasons.length ? reasons.join('; ') : null,
  };
}

/**
 * The banner text when a run did not see the whole account. Deliberately blunt:
 * a run that reached a fraction of an account must never read as complete.
 */
export function shortfallBanner(c) {
  if (!c || !c.materialShortfall) return null;
  return 'INCOMPLETE: ' + c.enumerated + ' of ' + c.reportedTotal + ' items X reports ' +
    'for this account (' + c.percent + '%). ' + c.shortfall + ' unaccounted for. ' +
    (c.reason || '') + '. Do not treat these results as the full account.';
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
