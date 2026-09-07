/**
 * Header construction, the fetch wrapper, rate-limit accounting, and GraphQL
 * feature negotiation.
 *
 * MUST run in the x.com origin (i.e. from content/executor.js). Two reasons,
 * both load-bearing:
 *
 *   1. `credentials: 'include'` attaches the HttpOnly `auth_token` cookie
 *      automatically. Surtr therefore never reads, stores, copies or transmits
 *      a credential. It cannot: the browser holds it and the browser attaches
 *      it. There is no code path here that could exfiltrate a session even if
 *      someone wanted one.
 *   2. `ct0` (the CSRF token) is a readable cookie on the x.com origin and it
 *      ROTATES. It is read fresh from document.cookie on every single request
 *      rather than captured once, because a cached ct0 starts returning 403
 *      mid-run and looks exactly like a revoked session.
 */

/**
 * DEPENDENCIES ARE INJECTED, NOT IMPORTED. A web-accessible module fetched
 * through a `use_dynamic_url` URL cannot resolve its own static imports, so
 * every module under lib/ is a leaf and content/executor.js wires the graph.
 * See DEV.md.
 */
let store = null;

/** Called by content/executor.js immediately after importing this module. */
export function provide(deps) {
  if (!deps || !deps.store) throw new Error('lib/api.js: provide() needs { store }.');
  store = deps.store;
}

const GQL_BASE = 'https://x.com/i/api/graphql';

/* --------------------------------------------------------------- cookies --- */

/** Read one cookie by name from the current origin. Returns '' when absent. */
export function readCookie(name) {
  const target = name + '=';
  for (const part of String(document.cookie || '').split(';')) {
    const s = part.trim();
    if (s.startsWith(target)) return decodeURIComponent(s.slice(target.length));
  }
  return '';
}

/* --------------------------------------------------------------- headers --- */

/**
 * Built fresh per request. Nothing here is cached, and ct0 in particular must
 * not be - see the module header.
 */
export function buildHeaders(bearer) {
  return {
    authorization: 'Bearer ' + bearer,
    'x-csrf-token': readCookie('ct0'),
    'x-twitter-active-user': 'yes',
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
  };
}

/* ----------------------------------------------------------- rate limits --- */

/**
 * Everything we know about X's limits is OBSERVED, never assumed. There is no
 * requests-per-window constant in this file on purpose: we do not know X's real
 * ceiling for any endpoint, it differs per endpoint and per account, and a
 * guessed number would either throttle pointlessly or trip a 429 anyway.
 * Instead we read the headers X sends, log what we saw, and back off when told.
 *
 * And observations are kept PER OPERATION, never merged. Different GraphQL
 * endpoints carry different budgets, so combining UserOriginalsTimeline's
 * remaining count with UserRepostsTimeline's produces a number that is wrong
 * for both - and since the point of hardcoding nothing is that we are trying to
 * LEARN the real ceilings, a merged figure would destroy the measurement it
 * exists to take.
 */
const rates = new Map();

function blankRate(operationName) {
  return {
    operationName,
    remaining: null,
    limit: null,
    reset: null,          // epoch seconds, the window boundary
    observedMinRemaining: null,
    observed429s: 0,
    concurrency: 1,       // enumeration is serial anyway; halved on every 429
    // PER WINDOW. Reset at every boundary - see absorbRateHeaders. Letting this
    // accumulate across windows produced "101 / 50 requests this window", which
    // is not merely wrong, it is impossible, and an impossible number in a
    // status line destroys trust in every other number beside it.
    requests: 0,
    windowStartedAt: null,
    // Run-long, deliberately not reset: these are what the run OBSERVED.
    totalRequests: 0,
    windows: 0,
  };
}

/** The live record for one operation, created on first sight. */
export function rateFor(operationName) {
  const key = String(operationName || 'unknown');
  if (!rates.has(key)) rates.set(key, blankRate(key));
  return rates.get(key);
}

function absorbRateHeaders(res, operationName) {
  const rate = rateFor(operationName);
  const num = (h) => {
    const v = res.headers.get(h);
    if (v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const remaining = num('x-rate-limit-remaining');
  const limit = num('x-rate-limit-limit');
  const reset = num('x-rate-limit-reset');

  // WINDOW BOUNDARY DETECTION. The window is fixed and the counter refills at
  // the boundary, so any of these means we are in a new one:
  //   - X reports a later reset than the one we were tracking
  //   - the reset we were tracking is now in the past
  //   - remaining went UP, which only happens on a refill
  const nowSec = Math.floor(Date.now() / 1000);
  const newWindow =
    (reset !== null && rate.reset !== null && reset > rate.reset) ||
    (rate.reset !== null && nowSec > rate.reset) ||
    (remaining !== null && rate.remaining !== null && remaining > rate.remaining);
  if (newWindow) {
    rate.requests = 0;
    rate.windowStartedAt = Date.now();
    rate.windows += 1;
  }
  rate.requests += 1;
  rate.totalRequests += 1;

  if (remaining !== null) {
    rate.remaining = remaining;
    if (rate.observedMinRemaining === null || remaining < rate.observedMinRemaining) {
      rate.observedMinRemaining = remaining;
    }
  }
  if (limit !== null) rate.limit = limit;
  if (reset !== null) rate.reset = reset;
  return { remaining, limit, reset };
}

/** Snapshot for ONE operation. There is deliberately no combined snapshot. */
export function rateSnapshot(operationName) {
  return { ...rateFor(operationName) };
}

/** Every operation's observations, keyed by name. For the export. */
export function allRates() {
  const out = {};
  for (const [k, v] of rates) out[k] = { ...v };
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sleep in slices, checking for an abort between them.
 *
 * A rate-limit wait can be a quarter of an hour. Sleeping through it in one
 * call means Stop does nothing until it ends, which is the same defect as a UI
 * that looks frozen: the tool stops responding to the user and gives no sign
 * that it is going to come back.
 *
 * `onTick` fires each second so the panel can show a countdown that visibly
 * moves. A countdown that does not tick is indistinguishable from a hang.
 */
async function sleepInterruptible(ms, shouldAbort, onTick) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (shouldAbort && shouldAbort()) return false;
    if (onTick) onTick(Math.max(0, until - Date.now()));
    await sleep(Math.min(1000, until - Date.now()));
  }
  return true;
}

/* --------------------------------------------------------------- errors --- */

export class AuthError extends Error {
  constructor(status) {
    super(
      'Session invalid (HTTP ' + status + '). Reload x.com, make sure you are ' +
      'logged in, then start the scan again.'
    );
    this.name = 'AuthError';
    this.status = status;
    this.fatal = true;
  }
}

export class FeatureError extends Error {
  constructor(message, raw) {
    super(message);
    this.name = 'FeatureError';
    this.raw = raw;
  }
}

export class AbortedError extends Error {
  constructor() {
    super('Scan stopped.');
    this.name = 'AbortedError';
  }
}

/* ------------------------------------------------------ feature negotiation --- */

/**
 * The smallest set worth starting from. This is a SEED, not a spec: the
 * negotiation loop below discovers whatever else the current build demands.
 * Keeping the seed short is deliberate - a long guessed list rots and produces
 * confusing errors about features that no longer exist.
 */
export function seedFeatures() {
  return {
    responsive_web_graphql_timeline_navigation_enabled: true,
    creator_subscriptions_tweet_preview_api_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
  };
}

// "The following features cannot be null: a, b, c"
const MISSING_RE = /features cannot be null:?\s*([\w,\s]+)/i;

/** Extract feature names X says are missing, from any error shape it uses. */
export function parseMissingFeatures(body) {
  const texts = [];
  if (typeof body === 'string') texts.push(body);
  if (body && Array.isArray(body.errors)) {
    for (const e of body.errors) if (e && e.message) texts.push(String(e.message));
  }
  if (body && typeof body.message === 'string') texts.push(body.message);

  const found = new Set();
  for (const t of texts) {
    const m = MISSING_RE.exec(t);
    if (!m) continue;
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (/^[a-z0-9_]+$/i.test(name)) found.add(name);
    }
  }
  return [...found];
}

/* ------------------------------------------------------------ the request --- */

const MAX_NEGOTIATION_ROUNDS = 25;

/**
 * Rate-limit waits tolerated within a single request, counted SEPARATELY from
 * negotiation rounds so the two cannot be confused for one another.
 */
const MAX_RATE_LIMIT_WAITS = 8;

/**
 * One GraphQL GET, with rate-limit backoff and feature negotiation.
 *
 * @param {object} o
 * @param {string} o.queryId        discovered, never hardcoded
 * @param {string} o.operationName
 * @param {object} o.variables
 * @param {string} o.bearer         discovered, never hardcoded
 * @param {object} [o.fieldToggles]
 * @param {function} [o.onLog]
 * @param {function} [o.shouldAbort] polled between attempts so Stop is prompt
 */
export async function gql({
  queryId,
  operationName,
  variables,
  bearer,
  fieldToggles = null,
  onLog = () => {},
  shouldAbort = () => false,
  onRateLimit = () => {},
}) {
  if (!queryId) throw new Error('No queryId for ' + operationName + '; run discovery first.');
  if (!bearer) throw new Error('No bearer token; run discovery first.');

  let features = (await store.readFeatures(operationName)) || seedFeatures();
  let rateLimitWaits = 0;

  for (let round = 0; round < MAX_NEGOTIATION_ROUNDS; round += 1) {
    if (shouldAbort()) throw new AbortedError();

    const params = new URLSearchParams();
    params.set('variables', JSON.stringify(variables));
    params.set('features', JSON.stringify(features));
    if (fieldToggles) params.set('fieldToggles', JSON.stringify(fieldToggles));

    const url = GQL_BASE + '/' + queryId + '/' + operationName + '?' + params.toString();

    const res = await fetch(url, {
      method: 'GET',
      headers: buildHeaders(bearer),
      credentials: 'include',
      referrer: 'https://x.com/',
    });

    absorbRateHeaders(res, operationName);

    // Auth failures are terminal. Retrying them in a loop is how a tool gets an
    // account rate-limited or flagged, and the fix is always human anyway.
    if (res.status === 401 || res.status === 403) throw new AuthError(res.status);

    if (res.status === 429) {
      const rate = rateFor(operationName);
      rate.observed429s += 1;
      rate.concurrency = Math.max(1, Math.floor(rate.concurrency / 2));
      const now = Math.floor(Date.now() / 1000);
      // x-rate-limit-reset is an ABSOLUTE timestamp for the window boundary,
      // not a duration. The window is fixed (~15 min) and the counter refills
      // at the boundary rather than sliding, so this is a real wall-clock time
      // we can count down to.
      const reset = rate.reset && rate.reset > now ? rate.reset : now + 60;
      const waitMs = (reset - now) * 1000 + 2000; // + 2s pad
      onLog(
        'warn',
        'HTTP 429 on ' + operationName + '. Observed limit=' + (rate.limit ?? '?') +
        ', remaining=' + (rate.remaining ?? '?') + '. Waiting ' +
        Math.round(waitMs / 1000) + 's until the window resets, concurrency now ' +
        rate.concurrency + '.'
      );
      // Publish the wait so the panel can show a live countdown. A stream
      // sleeping out a rate limit that looks identical to a hung one is a
      // defect, not a cosmetic issue.
      onRateLimit({
        operationName,
        resetAtMs: reset * 1000,
        waitMs,
        limit: rate.limit,
        requests: rate.requests,
      });
      const finished = await sleepInterruptible(waitMs, shouldAbort, null);
      onRateLimit(null);
      if (!finished) throw new AbortedError();
      // Do NOT trust the cached remaining after waking. The next response's
      // headers are the only authority on whether the window actually refilled;
      // treating the pre-sleep snapshot as still true is how a stream waits out
      // its window and then behaves as though it were still exhausted.
      rate.remaining = null;
      // A RATE LIMIT IS NOT A NEGOTIATION ROUND. Letting it consume one means
      // enough 429s exhaust the loop and throw "feature negotiation did not
      // converge" - an error that is both wrong and the kind that sends someone
      // looking in entirely the wrong place. Same value, two meanings, and the
      // loop counter cannot tell them apart unless it is told.
      round -= 1;
      rateLimitWaits += 1;
      if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
        throw new Error(operationName + ': still rate limited after ' +
          MAX_RATE_LIMIT_WAITS + ' window waits - giving up rather than looping forever.');
      }
      continue;
    }

    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }

    // Missing features come back as 400, but X has also returned them as 200
    // with an `errors` array. Check the body either way rather than the status.
    const missing = parseMissingFeatures(body || text);
    if (missing.length > 0) {
      const added = missing.filter((f) => !(f in features));
      if (added.length === 0) {
        throw new FeatureError(
          'X is asking for features that are already set - cannot negotiate further. ' +
          'Raw error: ' + text.slice(0, 500),
          text
        );
      }
      features = { ...features };
      for (const f of added) features[f] = true;
      onLog('info', 'feature negotiation round ' + (round + 1) + ': added ' + added.join(', '));
      await store.writeFeatures(operationName, features);
      continue;
    }

    if (!res.ok) {
      throw new Error(
        operationName + ' failed: HTTP ' + res.status + ' ' + text.slice(0, 500)
      );
    }
    if (body && Array.isArray(body.errors) && body.errors.length > 0 && !body.data) {
      throw new Error(
        operationName + ' returned errors: ' +
        body.errors.map((e) => e.message).join('; ').slice(0, 500)
      );
    }
    if (!body) throw new Error(operationName + ' returned a non-JSON body.');

    // Success. Persist the set that worked so the next run starts negotiated.
    await store.writeFeatures(operationName, features);
    return body;
  }

  throw new FeatureError(
    'Feature negotiation did not converge after ' + MAX_NEGOTIATION_ROUNDS +
    ' rounds. X is asking for a feature set this version cannot satisfy.'
  );
}

/* ---------------------------------------------------------- the WRITE path --- */

/**
 * One GraphQL POST. Used only by phase 2.
 *
 * SEPARATE FROM gql() ON PURPOSE. The read path assembles URL-encoded
 * `variables`/`features` query parameters onto a GET; writes take a JSON body
 * on a POST. Reusing the read assembly here would produce a request that looks
 * plausible and is wrong, and the failure mode of a wrong write request is not
 * an empty result set.
 *
 * Nothing about the read path is assumed to carry over:
 *
 *   - the METHOD differs (POST, JSON body)
 *   - the RATE LIMIT is unknown and separately tracked; api.rateFor() keys by
 *     operation name, so these get their own buckets automatically
 *   - the FEATURES requirements are unknown; whatever the caller passes is sent
 *     verbatim and nothing is invented
 *
 * There is no feature-negotiation retry loop here. On the read side that loop
 * is safe because a retried GET is free. Retrying a write against an unknown
 * error is not, so a non-2xx or errored response is returned to the caller for
 * classification and the caller decides. `onFirstFailure` receives the full
 * request and the raw body so a first live failure can be reported and the run
 * STOPPED rather than iterated on blind.
 */
export async function gqlPost({
  queryId,
  operationName,
  variables,
  features = null,
  bearer,
  onLog = () => {},
  shouldAbort = () => false,
  onRateLimit = () => {},
}) {
  if (!queryId) throw new Error('No queryId for ' + operationName + '; run discovery first.');
  if (!bearer) throw new Error('No bearer token; run discovery first.');
  if (shouldAbort()) throw new AbortedError();

  const url = GQL_BASE + '/' + queryId + '/' + operationName;
  const payload = { variables, queryId };
  if (features) payload.features = features;
  const bodyText = JSON.stringify(payload);

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(bearer),   // ct0 re-read fresh, same as the reads
    credentials: 'include',
    referrer: 'https://x.com/',
    body: bodyText,
  });

  absorbRateHeaders(res, operationName);

  if (res.status === 429) {
    const rate = rateFor(operationName);
    rate.observed429s += 1;
    const now = Math.floor(Date.now() / 1000);
    const reset = rate.reset && rate.reset > now ? rate.reset : now + 60;
    const waitMs = (reset - now) * 1000 + 2000;
    onLog('warn', 'HTTP 429 on ' + operationName + '. Waiting ' +
      Math.round(waitMs / 1000) + 's for the window to reset.');
    onRateLimit({
      operationName, resetAtMs: reset * 1000, waitMs,
      limit: rate.limit, requests: rate.requests,
    });
    const finished = await sleepInterruptible(waitMs, shouldAbort, null);
    onRateLimit(null);
    rate.remaining = null;
    if (!finished) throw new AbortedError();
    // Signal a retryable outcome rather than looping here - the caller owns the
    // decision to re-dispatch a write.
    return { status: 429, body: null, raw: '', request: { url, body: bodyText }, retryable: true };
  }

  const raw = await res.text();
  let body = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }

  return {
    status: res.status,
    body,
    raw: raw.slice(0, 4000),
    request: { url, method: 'POST', body: bodyText },
  };
}
