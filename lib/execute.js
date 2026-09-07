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
  DUPLICATE_TARGET: 'duplicate-target',
};

/** Outcomes. `unverified` is deliberately NOT a synonym for success. */
export const OUTCOME = {
  SUCCEEDED: 'succeeded',
  ALREADY_GONE: 'already-gone',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  UNVERIFIED: 'unverified',
  // The response matched the confirmed shape and carried nothing to check
  // against. NOT a failure: an absent answer is not a negative answer. Used
  // when a DeleteRetweet succeeds but X has no source tweet left to echo back,
  // because the original post is gone.
  UNVERIFIED_OK: 'unverified-ok',
  // NOT a failure. The item was rate limited, the retries were exhausted, and it
  // STILL EXISTS. A re-scan will pick it up. Grading this as `failed` reads as
  // an error worth investigating and, worse, as an item already dealt with.
  DEFERRED: 'deferred',
  ATTEMPTED: 'attempted',      // written before dispatch; replaced by the above
};

/**
 * How many times one item may be dispatched before it is deferred.
 *
 * Each retry happens AFTER api.gqlPost has already waited out the rate-limit
 * window, so three attempts is three windows, not three rapid-fire requests.
 */
export const MAX_WRITE_ATTEMPTS = 3;

/**
 * Should this item be dispatched again?
 *
 * A 429 IS NEVER A FAILURE - it means "try again later", and the wait has
 * already happened by the time this is asked. The breaker has always treated
 * 429 as neutral; the classification path did not, and two items were graded
 * `failed` and burned while still live on the account. Same value, two code
 * paths, one of them wrong.
 */
export function shouldRetry({ outcome, retryable, attempt, max = MAX_WRITE_ATTEMPTS }) {
  if (!retryable && outcome !== OUTCOME.DEFERRED) return false;
  return attempt < max;
}

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
  // One write per target, per plan. Results are already deduplicated by ITEM
  // id, but two distinct items could in principle resolve to the same delete
  // target - two retweet entries carrying the same sourceTweetId, say - and a
  // plan that dispatches the same target twice would send a second, pointless
  // write against an account. Deduplicating here makes "one run dispatches an
  // item twice" structurally impossible rather than merely unobserved.
  const seenTargets = new Set();

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
    if (planned.skip) {
      skipped.push(planned);
      continue;
    }
    const key = planned.op + ':' + planned.targetId;
    if (seenTargets.has(key)) {
      skipped.push({ skip: true, reason: SKIP.DUPLICATE_TARGET, item });
      continue;
    }
    seenTargets.add(key);
    dispatch.push(planned);
  }

  return { dispatch, skipped };
}

/* ------------------------------------------------- request variables --- */

/**
 * The variables each write operation takes. ONE ENTRY PER OPERATION, NEVER
 * SHARED, and that separation is the actual fix rather than a style choice.
 *
 * Both operations were originally dispatched through a single builder sending
 * `{ tweet_id, dark_request }`. That is correct for DeleteTweet and wrong for
 * DeleteRetweet, which returned:
 *
 *     HTTP 422
 *     {"errors":[{"code":"GRAPHQL_VALIDATION_FAILED",
 *                 "message":"must be defined",
 *                 "path":["variable","source_tweet_id"]}]}
 *
 * The verb selection and the target were both right - sourceTweetId resolved
 * and targetId matched it - and the request still failed, purely because one
 * operation inherited the other's key name. A shared builder makes that class
 * of mistake invisible: the code reads correctly and sends the wrong thing.
 * Separate tables make it impossible, because there is nothing to inherit from.
 *
 * DELETETWEET'S SHAPE IS PROVEN WORKING. Do not "tidy" these two together.
 */
export const WRITE_VARIABLES = {
  // Confirmed by a successful 5-item live run.
  DeleteTweet: (targetId) => ({ tweet_id: targetId, dark_request: false }),

  // NOT yet confirmed. `source_tweet_id` is named by X's own validation error,
  // so it is evidence rather than a guess.
  //
  // Nothing else is sent. DeleteTweet also takes `dark_request`, and it would
  // be reasonable to assume this does too - but reasonable is not the standard
  // here, and the bundle is only readable from a logged-in session so it could
  // not be checked. If another variable is required, the next 422 will NAME it
  // exactly as this one did, and it gets added then. One variable per
  // iteration, each one named by X, never blind.
  DeleteRetweet: (targetId) => ({ source_tweet_id: targetId }),
};

/**
 * Variables for one dispatch. Throws on an unknown operation rather than
 * returning something plausible - a write with guessed variables is worse than
 * a write that does not happen.
 */
export function variablesFor(operationName, targetId) {
  const build = WRITE_VARIABLES[operationName];
  if (typeof build !== 'function') {
    throw new Error('No variables shape defined for ' + operationName +
      ' - refusing to dispatch a write with guessed variables.');
  }
  return build(targetId);
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
  /**
   * DeleteTweet. Confirmed on a 5-item live run, verified by hand afterwards.
   *
   *     {"data":{"delete_tweet":{"tweet_results":{}}}}
   *
   * `tweet_results` is EMPTY - the tweet no longer exists to be returned - so
   * there is nothing here to verify against. This shape is deliberately NOT
   * made stricter to match DeleteRetweet's: verify what the response actually
   * gives you. Inventing a check against a field that is always empty would be
   * theatre.
   */
  DeleteTweet: (body) => {
    const ok = Boolean(body) && !('errors' in body) && Boolean(body.data) &&
      typeof body.data.delete_tweet === 'object' && body.data.delete_tweet !== null;
    return ok ? { ok: true } : { ok: false, detail: 'no data.delete_tweet in a 2xx body' };
  },

  /**
   * DeleteRetweet. Confirmed on 10 successful live responses, all identical:
   *
   *     {"data":{"unretweet":{"source_tweet_results":{"result":{"rest_id":"..."}}}}}
   *
   * NOTE THE KEY IS `unretweet`, NOT `delete_retweet`. The response key is not
   * derivable from the operation name and was not guessed - it was read off a
   * live response.
   *
   * STRICTER THAN DeleteTweet, ON PURPOSE. This response echoes back the id it
   * acted on, which DeleteTweet's does not, so there is something real to check
   * and it gets checked: the echoed `rest_id` must equal the `source_tweet_id`
   * we sent.
   *
   * A mismatch is a FAILURE, never a success, and it is reported with BOTH ids.
   * A response confirming a different tweet than the one we targeted is the
   * single worst thing this tool could quietly accept - it would mean either
   * our target resolution or X's routing is wrong, and either way the next
   * dispatch would be made on a broken assumption.
   */
  DeleteRetweet: (body, ctx) => {
    if (!body || ('errors' in body)) {
      return { ok: false, detail: 'errors present in a 2xx body' };
    }
    const un = body.data && body.data.unretweet;
    if (!un || typeof un !== 'object') {
      return { ok: false, detail: 'no data.unretweet in a 2xx body' };
    }
    const echoed = un.source_tweet_results &&
      un.source_tweet_results.result &&
      un.source_tweet_results.result.rest_id;
    const target = ctx && ctx.targetId;

    if (echoed === undefined || echoed === null) {
      // EMPTY IS AN ABSENCE, NOT A MISMATCH.
      //
      // Observed live: 118 of 119 responses echoed the source id, and one
      // returned `source_tweet_results: {}` with no rest_id at all. The
      // unretweet had genuinely worked - the Reposts tab emptied and X's own
      // count agreed. The original post was simply gone (deleted by its author,
      // or the account suspended), so X had nothing to echo.
      //
      // Grading that as a failure is the same error class as grading a 429 as
      // one: a non-answer read as a negative answer.
      return {
        ok: false,
        unverifiable: true,
        detail: 'data.unretweet present and source_tweet_results is EMPTY - the original ' +
          'post no longer exists, so there was nothing to echo back. The unretweet ' +
          'itself is not in question; only the confirmation is missing.',
      };
    }
    if (String(echoed) !== String(target)) {
      return {
        ok: false,
        mismatch: true,
        detail: 'ECHOED ID MISMATCH: we sent source_tweet_id=' + String(target) +
          ' and the response confirmed rest_id=' + String(echoed) +
          '. This response is about a DIFFERENT tweet than the one targeted.',
      };
    }
    return { ok: true };
  },
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
  status, body, operationName = null, targetId = null, confirmedSuccessShape = null,
}) {
  if (status === 401 || status === 403) {
    return { outcome: OUTCOME.FAILED, detail: 'auth failure (HTTP ' + status + ')', fatal: true };
  }
  if (status === 429) {
    // DEFERRED, never FAILED. If the caller has retries left it will
    // re-dispatch; if not, the item is still there and a re-scan finds it.
    return {
      outcome: OUTCOME.DEFERRED,
      detail: 'rate limited (HTTP 429) - not attempted successfully, the item still exists',
      retryable: true,
    };
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
    // Shapes may return a boolean (the test override) or a richer verdict.
    const raw = shape(body, { targetId, operationName });
    const r = typeof raw === 'boolean' ? { ok: raw } : (raw || { ok: false });
    if (r.ok) {
      return { outcome: OUTCOME.SUCCEEDED, detail: 'matched the confirmed success shape' };
    }
    // Nothing to verify against is NOT the same as verified wrong. A DIFFERENT
    // id means something is broken and stays fatal; an ABSENT id means there
    // was no check to perform.
    if (r.unverifiable) {
      return {
        outcome: OUTCOME.UNVERIFIED_OK,
        detail: 'HTTP ' + status + ': ' + r.detail,
      };
    }
    return {
      outcome: OUTCOME.FAILED,
      mismatch: Boolean(r.mismatch),
      detail: r.detail
        ? 'HTTP ' + status + ': ' + r.detail
        : 'HTTP ' + status + ' but the body did not match the confirmed success shape for ' +
          (operationName || 'this operation'),
    };
  }

  return {
    outcome: OUTCOME.UNVERIFIED,
    detail: 'HTTP ' + status + ' with no errors, but the success shape for ' +
      (operationName || 'this operation') + ' has not been confirmed against a live ' +
      'response yet',
  };
}

/* -------------------------------------------------- circuit breaker --- */

/**
 * Consecutive failures before a run is aborted.
 *
 * The existing first-item guard only catches a run that is broken from the very
 * start. A run where item 1 succeeds and items 2..N fail identically would
 * dispatch every one of them - on a 452-item run, the difference between losing
 * one item to a bug and losing four hundred.
 */
export const CONSECUTIVE_FAILURE_LIMIT = 5;

/**
 * Create the breaker for one run.
 *
 * IN MEMORY, PER RUN, DELIBERATELY NOT PERSISTED - and that is the opposite of
 * the kill-log offer flag, which had to persist. The two rules look
 * contradictory and are not, so the distinction is worth stating because this
 * codebase now has the state-vs-transition problem cutting both ways:
 *
 *   The offer flag SUPPRESSES an action. A stale one means a download that
 *   should have happened does not - mildly annoying. Losing it means writing
 *   somebody's deleted post text to disk unasked, every time they open a panel.
 *   So it persists: the failure mode of forgetting is worse.
 *
 *   The failure counter TRIGGERS an action, and the action is aborting a run.
 *   A stale one means a healthy run is killed for failures that happened
 *   yesterday, and the user cannot resume without hunting down invisible state.
 *   So it resets: the failure mode of remembering is worse.
 *
 * The rule generalises: persist what suppresses, reset what triggers. Ask which
 * direction a stale value fails in, not whether staleness is bad in general.
 */
export function createBreaker(limit = CONSECUTIVE_FAILURE_LIMIT) {
  return {
    limit,
    consecutive: 0,
    tripped: false,
    reason: null,
    immediate: false,
    failures: [],
  };
}

/**
 * A failure that will not fix itself by trying again.
 *
 * A validation error means the REQUEST SHAPE is wrong. The hundredth attempt
 * will be rejected exactly like the first, and every one in between is a wasted
 * write against a real account. Same for any other 4xx that is not a rate limit
 * and not the already-gone case: the server is telling us the request is
 * unacceptable, not that it is busy.
 *
 * 429 is explicitly excluded - it is a "later", not a "no", and it already has
 * its own backoff. 5xx is excluded too: a server error genuinely might be
 * transient, so it counts toward the consecutive limit rather than aborting on
 * its own.
 */
export function isUnrecoverableFailure({ status, body, mismatch }) {
  // A response confirming a different tweet than the one targeted means either
  // our target resolution or X's routing is wrong. Continuing would dispatch
  // every remaining write on a broken assumption, so this aborts at once
  // rather than counting toward a streak.
  if (mismatch) {
    return { unrecoverable: true, reason: 'ECHOED ID MISMATCH - the response confirmed a ' +
      'different tweet than the one targeted, so every further dispatch would rest on a ' +
      'broken assumption' };
  }
  const errors = body && Array.isArray(body.errors) ? body.errors : [];
  for (const e of errors) {
    const code = (e && (e.code || (e.extensions && e.extensions.code))) || '';
    if (String(code) === 'GRAPHQL_VALIDATION_FAILED') {
      return { unrecoverable: true, reason: 'GRAPHQL_VALIDATION_FAILED - the request ' +
        'shape is wrong and retrying cannot fix it' };
    }
  }
  if (status >= 400 && status < 500 && status !== 429) {
    return { unrecoverable: true, reason: 'HTTP ' + status + ' - the request was refused, ' +
      'not deferred, so retrying cannot fix it' };
  }
  return { unrecoverable: false, reason: null };
}

/**
 * Feed one graded outcome to the breaker. Returns the breaker.
 *
 * SUCCESS and ALREADY-GONE reset the counter: the endpoint is evidently working
 * and whatever caused earlier failures was not systemic.
 *
 * 429 is NEUTRAL - neither counted nor reset. Counting it would abort a run
 * that is merely being throttled, and resetting on it would let a genuinely
 * broken run launder its failure streak through rate limits.
 *
 * UNVERIFIED is neutral for the same reason in the other direction: it is not a
 * failure, but it is not evidence of success either, so it must not clear a
 * streak.
 */
export function recordOutcome(
  breaker, { outcome, status, body, detail, targetId, op, mismatch },
) {
  if (!breaker || breaker.tripped) return breaker;

  if (outcome === OUTCOME.SUCCEEDED || outcome === OUTCOME.ALREADY_GONE) {
    breaker.consecutive = 0;
    return breaker;
  }
  // unverified, unverified-ok, deferred, skipped: all neutral. A deferred item
  // was rate limited rather than rejected; an unverified-ok item succeeded and
  // simply had nothing to confirm it. Neither is evidence of a broken run, so
  // neither may count toward a failure streak.
  if (outcome !== OUTCOME.FAILED) return breaker;

  // A rate limit is a "later", not a failure of the request itself.
  if (status === 429) return breaker;

  breaker.failures.push({
    op: op || null,
    targetId: targetId || null,
    status: status ?? null,
    detail: detail ? String(detail).slice(0, 500) : null,
    raw: body ? truncateRaw(JSON.stringify(body), 1000) : null,
  });
  breaker.failures = breaker.failures.slice(-breaker.limit);

  const { unrecoverable, reason } = isUnrecoverableFailure({ status, body, mismatch });
  if (unrecoverable) {
    breaker.tripped = true;
    breaker.immediate = true;
    breaker.reason = reason;
    breaker.consecutive += 1;
    return breaker;
  }

  breaker.consecutive += 1;
  if (breaker.consecutive >= breaker.limit) {
    breaker.tripped = true;
    breaker.reason = breaker.consecutive + ' consecutive failures';
  }
  return breaker;
}

/**
 * The status of a finished run.
 *
 * `aborted` is its own value and is checked FIRST. An aborted run must never
 * present as a completed one - not in the counters, not in a banner, not in the
 * export - because "done" is the word someone will remember later when deciding
 * whether the rest of their account is still there.
 */
export function runStatusFor({ abortedByBreaker, fatal, stopped }) {
  if (abortedByBreaker) return 'aborted';
  if (fatal) return 'error';
  if (stopped) return 'stopped';
  return 'done';
}

/** True only for a run that ran to the end of its plan without being cut short. */
export function runIsComplete(status) {
  return status === 'done';
}

/** The line an aborted run is allowed to say about itself. */
export function breakerReport(breaker, counts, dispatched) {
  if (!breaker || !breaker.tripped) return null;
  const c = counts || {};
  return 'RUN ABORTED BY THE CIRCUIT BREAKER after ' + dispatched + ' dispatched: ' +
    breaker.reason + '. ' +
    (c.succeeded || 0) + ' succeeded, ' + (c.alreadyGone || 0) + ' already gone, ' +
    (c.failed || 0) + ' failed, ' + (c.unverified || 0) + ' unverified. ' +
    'The remaining items were NOT dispatched. This run is not complete and must not be ' +
    'read as one.';
}

/*
 * There is deliberately NO auto-offer of the kill log here, and no flag that
 * could re-enable one.
 *
 * An earlier version downloaded it automatically when a run finished. That
 * writes the full text of somebody's deleted posts to their filesystem on an
 * event they did not ask for, and no amount of gating makes that the user's
 * decision rather than the tool's. The gating version was also wrong in
 * practice - it fired on panel open - but the gating was never the point.
 *
 * The panel shows a prominent reminder when a run ends, with the download
 * buttons beside it. A reminder does the same job as an automatic download
 * except for the part where personal data reaches disk without being asked for.
 *
 * If you are adding a "just save it for them" convenience: the user decides
 * when personal data hits the filesystem, always.
 */

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
    succeeded: 0, alreadyGone: 0, failed: 0, skipped: 0, unverified: 0,
    unverifiedOk: 0, deferred: 0, attempted: 0,
  };
  for (const e of entries || []) {
    switch (e.outcome) {
      case OUTCOME.SUCCEEDED: counts.succeeded += 1; break;
      case OUTCOME.ALREADY_GONE: counts.alreadyGone += 1; break;
      case OUTCOME.FAILED: counts.failed += 1; break;
      case OUTCOME.SKIPPED: counts.skipped += 1; break;
      case OUTCOME.UNVERIFIED: counts.unverified += 1; break;
      case OUTCOME.UNVERIFIED_OK: counts.unverifiedOk += 1; break;
      case OUTCOME.DEFERRED: counts.deferred += 1; break;
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
  if (counts.unverifiedOk) {
    parts.push(counts.unverifiedOk + ' succeeded but unverifiable (nothing to echo back)');
  }
  if (counts.alreadyGone) parts.push(counts.alreadyGone + ' already gone');
  if (counts.deferred) {
    parts.push(counts.deferred + ' DEFERRED (rate limited, still exist, a re-scan finds them)');
  }
  if (counts.failed) parts.push(counts.failed + ' failed');
  if (counts.skipped) parts.push(counts.skipped + ' skipped');
  if (counts.attempted) parts.push(counts.attempted + ' ATTEMPTED, outcome unknown (crash?)');
  return parts.length ? parts.join(', ') : 'nothing dispatched';
}
