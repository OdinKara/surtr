/**
 * PHASE 2 PLANNING. The decisions that destroy data.
 *
 * PURE FUNCTIONS ONLY - no fetch, no chrome.*, no DOM. This module decides
 * WHAT to act on and WHICH verb to use; content/executor.js does the acting.
 * The split exists so the irreversible decisions can be tested exhaustively
 * without a browser and without an account.
 *
 * This module is a LEAF, like everything under lib/.
 *
 * ================================ READ THIS ================================
 * Every other module in this project can be wrong and produce a bad report.
 * This one can be wrong and delete somebody's posts - possibly somebody else's.
 * Three rules follow from that, and none of them are negotiable:
 *
 *   1. FAIL CLOSED. Anything unrecognised, ambiguous or missing is SKIPPED and
 *      reported. Nothing is ever guessed at, defaulted, or "probably fine".
 *   2. NEVER INFER A TARGET. A delete target is read from an explicit field or
 *      the item is skipped. There is no fallback chain, because the fallback
 *      for a retweet would be somebody else's post id.
 *   3. RE-DERIVE, DO NOT TRUST. Vetoes and filters are re-evaluated at dispatch
 *      time from the live config, never carried over from the scan.
 * ===========================================================================
 */

/** The two write operations. Discovered like any other - never hardcoded ids. */
export const WRITE_OPERATIONS = {
  DeleteTweet: 'DeleteTweet',
  DeleteRetweet: 'DeleteRetweet',
};

/** Why an item was not dispatched. Every one is reported, never silent. */
export const SKIP = {
  UNKNOWN_KIND: 'unknown-kind',
  RETWEET_WITHOUT_SOURCE: 'retweet-without-source',
  MALFORMED_ID: 'malformed-id',
  VETOED_PINNED: 'vetoed-pinned',
  VETOED_KEEP_LIST: 'vetoed-keep-list',
  NO_LONGER_MATCHED: 'no-longer-matched',
};

/** Outcomes. `unverified` is deliberately NOT a synonym for success. */
export const OUTCOME = {
  SUCCEEDED: 'succeeded',
  ALREADY_GONE: 'already-gone',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  UNVERIFIED: 'unverified',
  ATTEMPTED: 'attempted',      // written before dispatch; replaced by the above
};

/** X ids are decimal strings. Anything else is not something we will act on. */
export function isPlausibleId(id) {
  return typeof id === 'string' && /^[0-9]{5,25}$/.test(id);
}

/**
 * Choose the verb and the target for ONE item.
 *
 * THIS IS THE MOST DANGEROUS FUNCTION IN THE PROJECT.
 *
 *   post, reply -> DeleteTweet   on the item's OWN id
 *   retweet     -> DeleteRetweet on sourceTweetId, the ORIGINAL post
 *
 * Getting that backwards does not fail loudly - it sends a well-formed request
 * naming the wrong tweet. For a retweet the item's own id is our copy and
 * sourceTweetId is ANOTHER USER'S POST, so a mix-up means either failing to
 * undo the retweet or issuing a delete against a stranger's id. A retweet with
 * no sourceTweetId is therefore SKIPPED, never fallen back to the item id.
 *
 * Returns { op, targetId, item } or { skip, reason, item }.
 */
export function planItem(item) {
  const kind = item && item.kind;

  if (kind === 'post' || kind === 'reply') {
    if (!isPlausibleId(String(item.id))) {
      return { skip: true, reason: SKIP.MALFORMED_ID, item };
    }
    return { op: WRITE_OPERATIONS.DeleteTweet, targetId: String(item.id), item };
  }

  if (kind === 'retweet') {
    const source = item.sourceTweetId;
    // No guessing. The alternative to skipping here is acting on item.id, which
    // is our retweet rather than the post being unretweeted - and the whole
    // reason sourceTweetId is captured during the scan is that these differ.
    if (source === null || source === undefined || source === '') {
      return { skip: true, reason: SKIP.RETWEET_WITHOUT_SOURCE, item };
    }
    if (!isPlausibleId(String(source))) {
      return { skip: true, reason: SKIP.MALFORMED_ID, item };
    }
    return { op: WRITE_OPERATIONS.DeleteRetweet, targetId: String(source), item };
  }

  return { skip: true, reason: SKIP.UNKNOWN_KIND, item };
}

/**
 * Build the dispatch plan, re-evaluating the vetoes from the LIVE config.
 *
 * `evaluate` is filters.evaluate, injected rather than imported (leaf rule).
 * The scan's verdict is not trusted: a user who ticked "keep this id" after
 * scanning must have that honoured, and an item that no longer matches the
 * current filters must not be acted on because it matched an hour ago.
 */
export function buildPlan({ items, config, evaluate }) {
  const dispatch = [];
  const skipped = [];

  for (const item of items || []) {
    const verdict = evaluate(item, config);

    if (verdict.vetoed) {
      // Distinguish the two vetoes, because "I told it to keep that one" and
      // "it is my pinned post" are different things to have to explain.
      const reason = (verdict.reasons || []).includes('keepIdList')
        ? SKIP.VETOED_KEEP_LIST : SKIP.VETOED_PINNED;
      skipped.push({ skip: true, reason, item });
      continue;
    }
    if (!verdict.matched) {
      skipped.push({ skip: true, reason: SKIP.NO_LONGER_MATCHED, item });
      continue;
    }

    const planned = planItem(item);
    (planned.skip ? skipped : dispatch).push(planned);
  }

  return { dispatch, skipped };
}

/* --------------------------------------------------------- test selection --- */

/** Total public engagement, used to rank how consequential an item is. */
export function engagementOf(item) {
  return (Number(item.likeCount) || 0) + (Number(item.retweetCount) || 0) +
    (Number(item.replyCount) || 0) + (Number(item.quoteCount) || 0);
}

export const TEST_RUN_SIZE = 5;

/**
 * The 5 items for the first live test: LOWEST ENGAGEMENT FIRST, oldest as the
 * tie-break.
 *
 * Ranking engagement ahead of age is deliberate. The point of the test run is
 * to make the first irreversible action the least consequential one available,
 * and a forgotten post with zero interactions is a cheaper mistake than an old
 * post that people replied to. Age is the tie-break because among equally
 * ignored posts the oldest is the least likely to be missed.
 *
 * Items with no parseable date sort last rather than first: an unknown date is
 * not evidence of age, and this function must not treat missing data as
 * qualifying.
 */
export function selectTestItems(items, n = TEST_RUN_SIZE) {
  const withKeys = (items || []).map((item) => {
    const t = Date.parse(item.createdAt);
    return { item, engagement: engagementOf(item), time: Number.isNaN(t) ? Infinity : t };
  });
  withKeys.sort((a, b) =>
    a.engagement - b.engagement ||
    a.time - b.time ||
    String(a.item.id).localeCompare(String(b.item.id)));
  return withKeys.slice(0, n).map((x) => x.item);
}

/* -------------------------------------------------------------- summary --- */

/** Count by kind, and the date range, for the pre-dispatch confirmation. */
export function summarise(items) {
  const byKind = { post: 0, reply: 0, retweet: 0, other: 0 };
  let oldest = null;
  let newest = null;

  for (const item of items || []) {
    byKind[item.kind in byKind ? item.kind : 'other'] += 1;
    const t = Date.parse(item.createdAt);
    if (Number.isNaN(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
    if (newest === null || t > newest) newest = t;
  }

  return {
    total: (items || []).length,
    byKind,
    oldest: oldest === null ? null : new Date(oldest).toISOString(),
    newest: newest === null ? null : new Date(newest).toISOString(),
  };
}

/* --------------------------------------------------------- the arm gate --- */

/**
 * Is this run allowed to dispatch?
 *
 * Checked in the EXECUTOR, not only in the panel. The panel's controls are a
 * convenience; this is the gate. A message arriving with armed:true and the
 * right count still has to satisfy every one of these against state the
 * executor derived itself.
 *
 * `scanSessionId` vs `currentSessionId` is what makes "a completed scan in THIS
 * session" enforceable: the executor mints a session id when the content script
 * loads, so a checkpoint left over from a previous page load cannot be executed
 * against - it has to be re-scanned.
 */
export function checkArmed({
  armed,
  dryRun,
  confirmCount,
  expectedCount,
  scanStatus,
  scanSessionId,
  currentSessionId,
  configFingerprint,
  scanConfigFingerprint,
  testMode,
  testVerified,
}) {
  const refusals = [];

  if (dryRun !== false) refusals.push('still in dry-run mode');
  if (armed !== true) refusals.push('not armed');

  if (scanStatus !== 'done' && scanStatus !== 'partial') {
    refusals.push('no completed scan (status: ' + (scanStatus || 'none') + ')');
  }
  if (!scanSessionId || scanSessionId !== currentSessionId) {
    refusals.push('the scan was not completed in this session - re-scan first');
  }
  if (!configFingerprint || configFingerprint !== scanConfigFingerprint) {
    refusals.push('filters changed since the scan - the matched set is stale, re-scan first');
  }
  if (expectedCount <= 0) refusals.push('nothing to act on');
  if (Number(confirmCount) !== Number(expectedCount)) {
    refusals.push('confirmation count ' + confirmCount + ' does not equal ' + expectedCount);
  }
  if (testMode !== true && testVerified !== true) {
    refusals.push('the 5-item test run has not been verified yet - full runs are locked');
  }

  return { ok: refusals.length === 0, refusals };
}

/**
 * A stable fingerprint of the filter settings.
 *
 * Used to detect "filters changed since the scan". Key order is fixed rather
 * than relying on JSON.stringify's insertion order, so a config rebuilt in a
 * different order does not read as a different config.
 */
export function configFingerprint(config) {
  const c = config || {};
  const keys = [
    'beforeDate', 'afterDate', 'maxLikes', 'minLikes', 'maxRetweets',
    'keywordContains', 'keywordExcludes', 'hasMedia', 'excludePinned',
  ];
  const parts = keys.map((k) => k + '=' + JSON.stringify(c[k] ?? null));
  parts.push('includeKinds=' + JSON.stringify([...(c.includeKinds || [])].sort()));
  parts.push('keepIdList=' + JSON.stringify([...(c.keepIdList || [])].map(String).sort()));
  return parts.join('|');
}

/* ------------------------------------------------------ outcome grading --- */

/**
 * Success shapes, CONFIRMED FROM LIVE RESPONSES - one per operation.
 *
 * An operation absent from this table has no confirmed shape, and a clean 2xx
 * for it grades as `unverified` rather than `succeeded`. That is the point of
 * the table: knowledge about one operation must not leak into a claim about
 * another.
 *
 * DeleteTweet - confirmed on a 5-item live run, identical on all three captured
 * responses and verified by hand afterwards (5 targets gone, 4 controls
 * untouched, account total 2616 -> 2611):
 *
 *     HTTP 200
 *     {"data":{"delete_tweet":{"tweet_results":{}}}}
 *
 * `tweet_results` is deliberately EMPTY. The tweet no longer exists to be
 * returned, so the empty object IS the confirmation - nothing inside it is
 * required, and requiring anything would turn a correct response into a
 * reported failure.
 *
 * DeleteRetweet - NOT CONFIRMED. No retweet has been deleted, so no response
 * has been seen. It probably looks like `data.unretweet`, and probably is not
 * good enough for something irreversible: guessing here would mean either
 * reporting a real failure as a success, or a real success as a failure, and
 * both are worse than saying "unverified" until a live response exists.
 */
export const CONFIRMED_SUCCESS_SHAPES = {
  DeleteTweet: (body) =>
    Boolean(body) &&
    !('errors' in body) &&
    Boolean(body.data) &&
    typeof body.data.delete_tweet === 'object' &&
    body.data.delete_tweet !== null,
  // DeleteRetweet: deliberately absent until a live response is captured.
};

/** Operations whose success shape is still unknown. Surfaced in the panel. */
export function unconfirmedOperations() {
  return Object.values(WRITE_OPERATIONS)
    .filter((op) => !CONFIRMED_SUCCESS_SHAPES[op]);
}

/**
 * What did a write response actually mean?
 *
 * A 200 is not proof of deletion - GraphQL returns 200 with an `errors` array
 * for plenty of failures - so a clean status code alone never produces
 * `succeeded`. Success requires a shape that has been confirmed against a live
 * response for THAT operation.
 *
 * `unverified` exists so a run can report "the request came back 200 and we do
 * not yet know that means deleted" instead of quietly inflating a success
 * count. It is still the honest answer for DeleteRetweet.
 *
 * Pass `operationName` to use the confirmed table; `confirmedSuccessShape`
 * overrides it (used by the tests).
 */
export function classifyOutcome({
  status, body, operationName = null, confirmedSuccessShape = null,
}) {
  if (status === 401 || status === 403) {
    return { outcome: OUTCOME.FAILED, detail: 'auth failure (HTTP ' + status + ')', fatal: true };
  }
  if (status === 429) {
    return { outcome: OUTCOME.FAILED, detail: 'rate limited', retryable: true };
  }

  const errors = body && Array.isArray(body.errors) ? body.errors : [];
  const messages = errors.map((e) => String((e && e.message) || '')).join(' | ');

  if (errors.length > 0) {
    // "not found" / "does not exist" for a delete means the thing we were about
    // to destroy is already gone. Benign, but NOT a success - we did not do it.
    if (/not found|does not exist|no status found|already deleted/i.test(messages)) {
      return { outcome: OUTCOME.ALREADY_GONE, detail: messages.slice(0, 300) };
    }
    return { outcome: OUTCOME.FAILED, detail: messages.slice(0, 300) };
  }

  if (status < 200 || status >= 300) {
    return { outcome: OUTCOME.FAILED, detail: 'HTTP ' + status };
  }

  // 2xx with no errors. Whether that means "deleted" depends on whether this
  // operation's success shape has been confirmed against a live response.
  const shape = confirmedSuccessShape ||
    (operationName ? CONFIRMED_SUCCESS_SHAPES[operationName] : null);

  if (typeof shape === 'function') {
    return shape(body)
      ? { outcome: OUTCOME.SUCCEEDED, detail: 'matched the confirmed success shape' }
      : {
          outcome: OUTCOME.FAILED,
          detail: 'HTTP ' + status + ' but the body did not match the confirmed success ' +
            'shape for ' + (operationName || 'this operation'),
        };
  }

  return {
    outcome: OUTCOME.UNVERIFIED,
    detail: 'HTTP ' + status + ' with no errors, but the success shape for ' +
      (operationName || 'this operation') + ' has not been confirmed against a live ' +
      'response yet',
  };
}

/* ------------------------------------------------ kill log auto-offer --- */

/**
 * Should the kill log be offered for download automatically?
 *
 * THIS IS A TRANSITION, NOT A STATE, and conflating the two wrote five copies
 * of somebody's deleted post text to disk simply for opening the side panel.
 * The panel rehydrates from storage on every open, saw a completed run with a
 * log attached, and read "a completed run exists" as "a run just completed".
 *
 * Same shape as the dead run that kept rendering as live: a persisted condition
 * mistaken for an event. The difference is the blast radius - this one silently
 * writes personal data to disk on a UI event nobody asked for.
 *
 * Three conditions, all required:
 *
 *   1. the run has actually finished (a terminal status)
 *   2. THIS panel session dispatched it - a run rehydrated from storage was not
 *      completed in front of the person now looking at the screen
 *   3. it has not been offered before, checked against a PERSISTED record so a
 *      reload cannot resurrect the offer
 *
 * The manual download buttons are unaffected: retrieving the log later is a
 * deliberate act and always available.
 */
export function shouldOfferKillLog({
  status, runId, dispatchedThisSession, alreadyOffered,
}) {
  if (!runId) return false;
  if (!status || status === 'running') return false;
  if (!dispatchedThisSession) return false;
  if (alreadyOffered) return false;
  return true;
}

/** Record an offer without losing the previous ones. Ids only - no post text. */
export function recordOffered(offered, runId) {
  const list = Array.isArray(offered) ? offered.slice() : [];
  if (runId && !list.includes(runId)) list.push(runId);
  // Bounded: this is a small set of run ids, but it is persisted forever.
  return list.slice(-200);
}

/* ------------------------------------------------- raw body retention --- */

/** Hard cap so one enormous response cannot bloat the log. */
export const RAW_MAX = 4000;

/** First N of a run kept regardless, for shape confirmation. */
export const RAW_HEAD_COUNT = 3;

/**
 * Should this response's raw body be kept in the kill log?
 *
 * POSITION IS THE WRONG CRITERION ON ITS OWN. Keeping only the first three of a
 * run captures exactly the responses you already understand, and drops the one
 * that matters: if item 300 fails in an unexpected way, the raw body is the
 * whole diagnosis and it would not be there.
 *
 * So: ANY non-success outcome is retained wherever it occurs, plus the first
 * few of a run for confirming shapes. Success is the only outcome cheap enough
 * to discard, because a confirmed success shape is by definition already known.
 */
export function shouldRetainRaw({ outcome, indexInRun }) {
  if (outcome !== OUTCOME.SUCCEEDED) return true;
  return Number(indexInRun) < RAW_HEAD_COUNT;
}

/** Truncate a retained body, marking the truncation so it is never mistaken. */
export function truncateRaw(raw, max = RAW_MAX) {
  const s = String(raw ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n...[truncated ' + (s.length - max) + ' more characters]';
}

/** Tally outcomes without ever letting one category absorb another. */
export function tally(entries) {
  const counts = {
    succeeded: 0, alreadyGone: 0, failed: 0, skipped: 0, unverified: 0, attempted: 0,
  };
  for (const e of entries || []) {
    switch (e.outcome) {
      case OUTCOME.SUCCEEDED: counts.succeeded += 1; break;
      case OUTCOME.ALREADY_GONE: counts.alreadyGone += 1; break;
      case OUTCOME.FAILED: counts.failed += 1; break;
      case OUTCOME.SKIPPED: counts.skipped += 1; break;
      case OUTCOME.UNVERIFIED: counts.unverified += 1; break;
      // Written before dispatch and never resolved - a crash mid-request. It is
      // its own category because it is genuinely unknown, and rolling it into
      // either success or failure would be a claim we cannot support.
      default: counts.attempted += 1; break;
    }
  }
  return counts;
}

/**
 * The one-line claim a run is allowed to make about itself.
 *
 * Deliberately refuses to state a "deleted" total that includes unverified or
 * unresolved items, because that is the number a person will quote later.
 */
export function outcomeSummary(counts) {
  const parts = [];
  if (counts.succeeded) parts.push(counts.succeeded + ' deleted');
  if (counts.unverified) {
    parts.push(counts.unverified + ' sent, outcome UNVERIFIED (success shape not yet confirmed)');
  }
  if (counts.alreadyGone) parts.push(counts.alreadyGone + ' already gone');
  if (counts.failed) parts.push(counts.failed + ' failed');
  if (counts.skipped) parts.push(counts.skipped + ' skipped');
  if (counts.attempted) parts.push(counts.attempted + ' ATTEMPTED, outcome unknown (crash?)');
  return parts.length ? parts.join(', ') : 'nothing dispatched';
}
