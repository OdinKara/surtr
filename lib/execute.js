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
 * What did a write response actually mean?
 *
 * THE SUCCESS SHAPE FOR THESE OPERATIONS IS NOT YET CONFIRMED. A 200 is not
 * proof of deletion - GraphQL returns 200 with an `errors` array for plenty of
 * failures - so until a real response has been seen and the shape recorded,
 * this function refuses to call anything `succeeded` on the strength of a
 * status code alone.
 *
 * `unverified` exists precisely so that a run can report "the request came back
 * 200 and we do not yet know that means deleted" instead of quietly inflating a
 * success count. That is the honest state of knowledge before the first live
 * call, and the 5-item test run is what replaces it with evidence.
 *
 * What IS safe to classify already:
 *   - a transport or auth failure is a failure
 *   - a GraphQL `errors` array is a failure, unless it names the tweet as
 *     already gone, which is a distinct and benign outcome
 */
export function classifyOutcome({ status, body, confirmedSuccessShape = null }) {
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

  // 2xx with no errors. Whether that means "deleted" depends on a response
  // shape nobody has looked at yet.
  if (confirmedSuccessShape && typeof confirmedSuccessShape === 'function') {
    return confirmedSuccessShape(body)
      ? { outcome: OUTCOME.SUCCEEDED, detail: 'matched the confirmed success shape' }
      : { outcome: OUTCOME.FAILED, detail: 'HTTP 200 but did not match the confirmed shape' };
  }

  return {
    outcome: OUTCOME.UNVERIFIED,
    detail: 'HTTP ' + status + ' with no errors, but the success shape for this ' +
      'operation has not been confirmed against a live response yet',
  };
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
