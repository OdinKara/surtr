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
  if (stream.endReason === 'page-limit') {
    return where + ': STOPPED AT THE PAGE BOUND after ' + stream.pages + ' pages and ' +
      n + ' item(s). The cursor never terminated, which is not normal - this is a ' +
      'floor, not a complete stream, and it is worth investigating.';
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
 * Did a stream run to a clean end, or did it stop for a reason that makes its
 * count a floor rather than a total?
 *
 * The four not-clean reasons are exactly the ones `streamReport()` writes
 * separate prose for: a suspected ceiling, the page bound, a repeated cursor,
 * and a user stop. Kept as a predicate because `completeness()` needs the
 * verdict rather than the sentence.
 */
export function streamRanClean(s) {
  return Boolean(s) && s.status === STATUS.DONE &&
    !s.ceilingSuspected &&
    s.endReason !== 'page-limit' &&
    s.endReason !== 'cursor-repeat' &&
    s.endReason !== 'stopped';
}

/**
 * Did this run actually see what it set out to see?
 *
 * TWO DIFFERENT QUESTIONS, and they must never be answered with the same
 * arithmetic.
 *
 * FULL SCOPE - every stream walked. `complete` requires BOTH that every stream
 * finished AND that the union is not materially short of what X reports. A
 * live run enumerated 604 items against an account reporting 2,616 and every
 * stream reported a clean cursor exhaustion - true per stream, badly
 * misleading about the whole, because ~2,000 replies lived in a stream that
 * was not being walked.
 *
 * FILTERED SCOPE - the kind filter excluded whole streams. X's account-wide
 * total is then the WRONG denominator: comparing against it reports the user's
 * own filter back as a gap. A deliberate posts-only scan read "23 of 2035
 * (1%), 2012 unaccounted for", in red, on a run that was entirely correct.
 * Severity spent on the routine case is severity unavailable for the real one.
 * So the comparison is dropped rather than softened, and the claim made here
 * is explicitly the weaker one - about the streams walked, never the account.
 */
export function completeness({ streams, enumerated, reportedTotal }) {
  const list = streams || [];
  const allSettled = list.length > 0 && list.every(
    (s) => s.status === STATUS.DONE || s.status === STATUS.SKIPPED);
  const allDone = list.length > 0 && list.every((s) => s.status === STATUS.DONE);
  const skipped = list.filter((s) => s.status === STATUS.SKIPPED);
  const inScope = list.filter((s) => s.status !== STATUS.SKIPPED);
  const failed = list.filter((s) => s.status === STATUS.FAILED);

  const total = Number.isFinite(reportedTotal) ? reportedTotal : null;
  const seen = Number(enumerated) || 0;
  const skippedLabels = skipped.map((s) => s.label);
  const scopeLabels = inScope.map((s) => s.label);

  // ---------------------------------------------------------------------
  // FILTERED SCOPE. The user asked for one or two kinds, so whole streams
  // were never walked. Comparing what we enumerated against X's ACCOUNT-WIDE
  // total then reports the user's own filter as a shortfall: a posts-only
  // scan read "23 of 2035 (1%), 2012 unaccounted for" and painted it red,
  // which is a false statement AND a boy-who-cried-wolf problem. A real
  // shortfall warning only works if it is rare.
  //
  // So the comparison is DROPPED, not softened. X publishes no per-stream
  // totals, so there is no in-scope denominator to compare against, and the
  // honest claim here is strictly weaker than the full-scope one: it is
  // about the streams that were walked, never about the account. It is
  // carried in `claim` so the UI renders that wording rather than deriving
  // its own - the rule lives in one place.
  // ---------------------------------------------------------------------
  if (skipped.length > 0 && inScope.length > 0) {
    const unclean = inScope.filter((s) => !streamRanClean(s));
    const reasons = [];
    if (failed.length) {
      reasons.push(failed.map((s) => s.label).join(' and ') + ' stream(s) failed');
    }
    const stoppedShort = unclean.filter((s) => s.status !== STATUS.FAILED);
    if (stoppedShort.length) {
      reasons.push(stoppedShort.map((s) => s.label).join(' and ') +
        ' stream(s) did not reach a clean end');
    }
    const notIncluded = skippedLabels.length
      ? 'The ' + skippedLabels.join(' and ') + ' stream(s) were not included, because ' +
        'your kind filter excludes them - nothing from them was read. '
      : '';
    const claim = unclean.length === 0
      ? 'Every stream Surtr walked ran to completion - no ceiling hit, no failure, no ' +
        'cursor exhaustion. That is a statement about the ' + scopeLabels.join(' and ') +
        ' stream(s) only. ' + notIncluded + 'X publishes no per-stream totals, so there ' +
        'is no number to check this against: Surtr cannot give you a percentage of your ' +
        'account here, and this is NOT a claim that your account holds nothing else.'
      : 'NOT COMPLETE EVEN FOR WHAT WAS SCANNED: ' + reasons.join('; ') + '. Treat these ' +
        'results as a floor for the ' + scopeLabels.join(' and ') + ' stream(s). ' +
        notIncluded;

    return {
      // A claim about THE SCOPE THAT WAS WALKED, never about the account.
      // `scopeFiltered` is what tells a reader which of the two this is, and
      // any consumer reading `complete` must read that alongside it.
      complete: unclean.length === 0,
      scopeFiltered: true,
      scopeStreams: scopeLabels,
      skippedStreams: skippedLabels,
      unknownTotal: total === null,
      allSettled,
      enumerated: seen,
      // Still reported, still unchanged - it is shown in the details. It is
      // simply not used as a denominator, because it does not denominate this.
      reportedTotal: total,
      // DELIBERATELY NULL. There is no in-scope denominator, so any number
      // here would be arithmetic against the wrong total.
      shortfall: null,
      materialShortfall: false,
      percent: null,
      claim,
      reason: reasons.length ? reasons.join('; ') : null,
    };
  }

  // Nothing at all was in scope: every stream was excluded by the filter.
  // A run that read no stream cannot be complete in any sense.
  if (list.length > 0 && inScope.length === 0) {
    return {
      complete: false,
      scopeFiltered: true,
      scopeStreams: [],
      skippedStreams: skippedLabels,
      unknownTotal: total === null,
      allSettled,
      enumerated: seen,
      reportedTotal: total,
      shortfall: null,
      materialShortfall: false,
      percent: null,
      claim: 'No stream was scanned - your kind filter excludes all of them. ' +
        'These results say nothing about your account.',
      reason: 'every stream was skipped by the kind filter',
    };
  }

  // ---------------------------------------------------------------------
  // FULL SCOPE. Unchanged: every stream was in scope, so X's account-wide
  // total IS the right denominator and the percentage means what it says.
  // ---------------------------------------------------------------------
  const shortfall = total === null ? null : Math.max(0, total - seen);
  const material = total !== null && total > 0 && seen < total * COMPLETENESS_TOLERANCE;

  const reasons = [];
  // NO DENOMINATOR MEANS NO CLAIM. An earlier version returned complete:true
  // when the account total was unknown, which is the same failure as the guard
  // it was meant to be: it cannot assess completeness, so it silently reported
  // completeness. Absence of evidence is not evidence of a clean sweep.
  if (total === null) {
    reasons.push('X reported no account total from any source, so completeness cannot be ' +
      'assessed - these results are a LOWER BOUND');
  }
  if (failed.length) {
    reasons.push(failed.map((s) => s.label).join(' and ') + ' stream(s) failed');
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
    complete: Boolean(allDone && !material && total !== null),
    scopeFiltered: false,
    scopeStreams: scopeLabels,
    skippedStreams: [],
    // Distinct from `complete: false` with a known shortfall: this says we do
    // not know, rather than that we came up short.
    unknownTotal: total === null,
    allSettled,
    enumerated: seen,
    reportedTotal: total,
    shortfall,
    materialShortfall: material,
    percent: total ? Math.round((seen / total) * 100) : null,
    claim: null,
    reason: reasons.length ? reasons.join('; ') : null,
  };
}

/**
 * The banner text when a run did not see what it set out to see. Deliberately
 * blunt: a run that reached a fraction of an account must never read as
 * complete. Returns null when there is nothing to warn about - including for a
 * filtered scan that ran clean, because a warning on a correct run is how a
 * warning stops meaning anything.
 */
export function shortfallBanner(c) {
  // A FILTERED SCAN NEVER BORROWS THE CONFIDENCE OF THE FULL COMPARISON.
  // There is no percentage and no shortfall to report, so the only thing that
  // can raise a warning here is a stream that WAS walked and did not reach a
  // clean end. A scan that is complete for its own scope raises nothing.
  if (c && c.scopeFiltered) {
    if (c.complete) return null;
    return 'INCOMPLETE FOR WHAT WAS SCANNED: ' + (c.claim || '');
  }
  if (c && c.unknownTotal) {
    return 'LOWER BOUND: X reported no account total, so there is no way to tell whether ' +
      'this run saw everything. ' + c.enumerated + ' item(s) enumerated. Completeness ' +
      'cannot be assessed - do not read this as a complete sweep.';
  }
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
 * PARTIAL, NOT ERROR, when anything was enumerated and anything failed.
 * Nothing already enumerated is ever discarded, so a run that got half the data
 * is not the same as a run that got none, and calling it "error" would invite
 * throwing away results that are perfectly good.
 *
 * PARTIAL MEANS SOMETHING WENT HALF-DONE - a stream failed, was stopped, or
 * came up short. It does NOT mean the user filtered a stream out. This used to
 * return 'partial' for done + skipped, so a deliberate posts-only scan reported
 * "streams finished (partial)" and told the user something had gone wrong when
 * nothing had. Same wrong reading as the completeness one: a stream the user
 * excluded is SCOPE, not incompleteness.
 *
 * The clean/not-clean judgement is `streamRanClean()`, shared with
 * `completeness()` so the two can never drift apart on what "finished" means.
 */
export function overallStatus(streams) {
  const active = (streams || []).filter((s) => s.status !== STATUS.SKIPPED);
  const anyFailed = active.some((s) => s.status === STATUS.FAILED);
  const allClean = active.length > 0 && active.every(streamRanClean);

  if (anyFailed) return active.some((s) => s.enumerated > 0) ? 'partial' : 'error';
  // Every stream filtered out: nothing ran, so nothing finished.
  if (active.length === 0) return 'partial';
  if (allClean) return 'done';
  return 'partial';
}
