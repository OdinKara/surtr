/**
 * Filter predicates. PURE FUNCTIONS ONLY - no fetch, no chrome.*, no Date.now(),
 * no reading storage. Every function here takes a normalized post plus a config
 * and returns a boolean, which is what makes them testable without a browser.
 *
 * Composition rule: filters are ANDed. A post must satisfy every ENABLED filter
 * to match. A filter left unset is not a filter and does not participate.
 *
 * Veto rule: `excludePinned` and `keepIdList` are evaluated LAST and are hard
 * vetoes. No other filter can override them. They are the "never touch this"
 * list, and a safety rail that another setting could cancel is not a rail.
 */

/** A normalized post, for reference:
 * {
 *   id, kind: 'post'|'reply'|'retweet', createdAt (ISO string), text,
 *   likeCount, retweetCount, replyCount, hasMedia, isPinned,
 *   sourceTweetId (retweets only), permalink
 * }
 */

export const KINDS = ['post', 'reply', 'retweet'];

/** The shape the panel writes and the executor reads. */
export function defaultConfig() {
  return {
    beforeDate: null,      // ISO date string; keep posts strictly OLDER than this
    afterDate: null,       // ISO date string; keep posts strictly NEWER than this
    maxLikes: null,        // number; match when likeCount <= maxLikes
    minLikes: null,        // number; match when likeCount >= minLikes
    maxRetweets: null,     // number; match when retweetCount <= maxRetweets
    includeKinds: ['post', 'reply', 'retweet'],
    keywordContains: '',   // whitespace-separated terms; ANY term present
    keywordExcludes: '',   // whitespace-separated terms; NO term present
    hasMedia: null,        // tri-state: true | false | null (don't care)
    excludePinned: true,   // VETO, default on
    keepIdList: [],        // VETO, ids that must never be touched
  };
}

/* ------------------------------------------------------------- helpers --- */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/** Terms are whitespace-separated and matched case-insensitively as substrings. */
export function parseTerms(raw) {
  if (!isStr(raw)) return [];
  return raw.split(/\s+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function timeOf(post) {
  const t = Date.parse(post.createdAt);
  return Number.isNaN(t) ? null : t;
}

/* ------------------------------------------------------- the predicates --- */

/** Post is strictly older than the cutoff. Unparseable dates never match. */
export function beforeDate(post, cutoffIso) {
  if (!isStr(cutoffIso)) return true;
  const cutoff = Date.parse(cutoffIso);
  const t = timeOf(post);
  if (Number.isNaN(cutoff) || t === null) return false;
  return t < cutoff;
}

/** Post is strictly newer than the cutoff. */
export function afterDate(post, cutoffIso) {
  if (!isStr(cutoffIso)) return true;
  const cutoff = Date.parse(cutoffIso);
  const t = timeOf(post);
  if (Number.isNaN(cutoff) || t === null) return false;
  return t > cutoff;
}

export function maxLikes(post, n) {
  if (!isNum(n)) return true;
  return post.likeCount <= n;
}

export function minLikes(post, n) {
  if (!isNum(n)) return true;
  return post.likeCount >= n;
}

export function maxRetweets(post, n) {
  if (!isNum(n)) return true;
  return post.retweetCount <= n;
}

/** An empty or absent kind list means "no kind filter", not "match nothing". */
export function includeKinds(post, kinds) {
  if (!Array.isArray(kinds) || kinds.length === 0) return true;
  return kinds.includes(post.kind);
}

/** ANY term present. */
export function keywordContains(post, raw) {
  const terms = parseTerms(raw);
  if (terms.length === 0) return true;
  const hay = String(post.text || '').toLowerCase();
  return terms.some((t) => hay.includes(t));
}

/** NO term present. */
export function keywordExcludes(post, raw) {
  const terms = parseTerms(raw);
  if (terms.length === 0) return true;
  const hay = String(post.text || '').toLowerCase();
  return !terms.some((t) => hay.includes(t));
}

/** Tri-state: null means don't care. */
export function hasMedia(post, want) {
  if (want === null || want === undefined) return true;
  return Boolean(post.hasMedia) === Boolean(want);
}

/* ------------------------------------------------------------- vetoes --- */

/** VETO. Returns false when the post is pinned and pinned posts are protected. */
export function excludePinned(post, enabled) {
  if (!enabled) return true;
  return !post.isPinned;
}

/**
 * VETO. Returns false when the post id is on the keep list.
 *
 * For a retweet this checks BOTH the retweet's own id and the source post's id,
 * so keeping an original also keeps your retweet of it. That is the reading a
 * human means by "never touch this one".
 */
export function keepIdList(post, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return true;
  const keep = new Set(ids.map(String));
  if (keep.has(String(post.id))) return false;
  if (post.sourceTweetId && keep.has(String(post.sourceTweetId))) return false;
  return true;
}

/* --------------------------------------------------------- composition --- */

/**
 * Evaluate every filter against one post.
 *
 * Returns { matched, vetoed, reasons } where `reasons` names the filters that
 * rejected it. The panel shows those so an unexpected zero-match run is
 * diagnosable instead of mysterious.
 */
export function evaluate(post, cfg) {
  const c = { ...defaultConfig(), ...(cfg || {}) };
  const reasons = [];

  const checks = [
    ['beforeDate', beforeDate(post, c.beforeDate)],
    ['afterDate', afterDate(post, c.afterDate)],
    ['maxLikes', maxLikes(post, c.maxLikes)],
    ['minLikes', minLikes(post, c.minLikes)],
    ['maxRetweets', maxRetweets(post, c.maxRetweets)],
    ['includeKinds', includeKinds(post, c.includeKinds)],
    ['keywordContains', keywordContains(post, c.keywordContains)],
    ['keywordExcludes', keywordExcludes(post, c.keywordExcludes)],
    ['hasMedia', hasMedia(post, c.hasMedia)],
  ];
  for (const [name, ok] of checks) if (!ok) reasons.push(name);

  // Vetoes LAST, and they cannot be overridden by anything above.
  const vetoes = [
    ['excludePinned', excludePinned(post, c.excludePinned)],
    ['keepIdList', keepIdList(post, c.keepIdList)],
  ];
  let vetoed = false;
  for (const [name, ok] of vetoes) {
    if (!ok) {
      vetoed = true;
      reasons.push(name);
    }
  }

  return { matched: reasons.length === 0, vetoed, reasons };
}

/** Convenience: split a list of posts into matched and excluded. */
export function partition(posts, cfg) {
  const matched = [];
  const excluded = [];
  for (const p of posts) {
    const r = evaluate(p, cfg);
    (r.matched ? matched : excluded).push({ ...p, _reasons: r.reasons });
  }
  return { matched, excluded };
}
