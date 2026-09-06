/**
 * Cursor-paginated walk of your own timeline, and normalization of what comes
 * back into a flat shape the filters can reason about.
 *
 * READ ONLY. Nothing in this file mutates anything on X. Phase 1 is a scanner.
 */

/**
 * DEPENDENCIES ARE INJECTED, NOT IMPORTED. A web-accessible module fetched
 * through a `use_dynamic_url` URL cannot resolve its own static imports, so
 * every module under lib/ is a leaf and content/executor.js wires the graph.
 * See DEV.md.
 *
 * Only `api` is needed here. The old `import * as store` was never used by
 * anything in this file and is gone.
 */
let api = null;

/** Called by content/executor.js immediately after importing this module. */
export function provide(deps) {
  if (!deps || !deps.api) throw new Error('lib/enumerate.js: provide() needs { api }.');
  api = deps.api;
}

/**
 * X stops serving your own older history through this timeline somewhere around
 * 3,200 entries. It is not a documented number and it is not exact, so this is
 * a threshold for RAISING THE QUESTION, not a claim about where the wall is.
 */
export const CEILING_HINT = 3200;
const CEILING_SUSPECT_AT = 3000;

export const CEILING_MESSAGE =
  "Reached X's timeline limit at {N} posts. Older posts exist and are still " +
  'publicly reachable by direct URL, but this method cannot see them. ' +
  'Requesting your X data archive is the only complete enumeration.';

/* ------------------------------------------------------ who am I --------- */

/** Scrape the logged-in handle out of the page chrome. */
export function screenNameFromPage() {
  const profileLink = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
  if (profileLink) {
    const href = profileLink.getAttribute('href') || '';
    const m = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(href);
    if (m) return m[1];
  }
  const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
  if (switcher) {
    const m = /@([A-Za-z0-9_]{1,15})/.exec(switcher.textContent || '');
    if (m) return m[1];
  }
  const avatar = document.querySelector('[data-testid^="UserAvatar-Container-"]');
  if (avatar) {
    const id = avatar.getAttribute('data-testid') || '';
    const m = /UserAvatar-Container-([A-Za-z0-9_]{1,15})$/.exec(id);
    if (m) return m[1];
  }
  return null;
}

/**
 * The `twid` cookie is literally `u=<numeric id>` on the x.com origin. It is a
 * fallback for when the sidebar is not rendered (narrow window, a route that
 * hides the nav). Read, never written anywhere.
 */
export function userIdFromCookie() {
  const raw = api.readCookie('twid');
  const m = /u=?(\d+)/.exec(raw || '');
  return m ? m[1] : null;
}

/**
 * Resolve the logged-in user to { userId, screenName, via }.
 *
 * The id is returned to the caller and used for the duration of the scan. It is
 * NEVER written to storage and never appears in an exported report, because a
 * numeric X id is a personal identifier and this repo is destined to be public.
 */
export async function resolveUser({ bearer, queryIds, onLog = () => {}, shouldAbort }) {
  const screenName = screenNameFromPage();

  if (screenName) {
    const body = await api.gql({
      queryId: queryIds.UserByScreenName,
      operationName: 'UserByScreenName',
      variables: { screen_name: screenName, withSafetyModeUserFields: true },
      bearer,
      onLog,
      shouldAbort,
    });
    const result = body?.data?.user?.result;
    const restId = result?.rest_id;
    if (restId) {
      // The account-wide total lives HERE, on the user response - not on the
      // timeline responses. Reading it in the wrong place is why it was null.
      const reportedTotal = tweetCountOf(body);
      onLog('info', 'resolved @' + screenName + ' via UserByScreenName' +
        (reportedTotal === null
          ? ' (X reported no account total - the completeness check cannot run)'
          : '; X reports ' + reportedTotal + ' items on this account'));
      return { userId: String(restId), screenName, via: 'UserByScreenName', reportedTotal };
    }
    onLog('warn', 'UserByScreenName returned no rest_id for @' + screenName);
  } else {
    onLog('warn', 'could not read a handle from the page chrome');
  }

  const cookieId = userIdFromCookie();
  if (cookieId) {
    onLog('info', 'resolved user id from the twid cookie (page scrape failed)');
    return {
      userId: cookieId, screenName: screenName || null, via: 'twid-cookie',
      reportedTotal: null,
    };
  }

  throw new Error(
    'Could not work out which account is logged in. Open https://x.com/home in ' +
    'this tab, make sure you are logged in, and try again.'
  );
}

/* --------------------------------------------- response tree walking ----- */

/**
 * Instructions, from the CONFIRMED live shape first.
 *
 *     data.user.result.timeline.timeline.instructions
 *
 * There is no `timeline_v2` in the live response. Phase 1 was written against a
 * spec that said there was, and the predicted symptom of that being wrong -
 * "page one returns zero posts" - is exactly what it would have produced.
 * Fallbacks are kept for older or differently-shaped deployments, but the live
 * path is first.
 */
export function instructionsOf(body) {
  const u = body?.data?.user?.result;
  const tl =
    u?.timeline?.timeline ||        // CONFIRMED live shape
    u?.timeline_v2?.timeline ||     // fallback: older builds
    u?.timeline_response?.timeline ||
    null;
  const ins = tl?.instructions;
  return Array.isArray(ins) ? ins : [];
}

/**
 * Total items X reports for the account, used as a progress denominator and -
 * more importantly - as the check that a run actually saw the account.
 *
 * THIS CAME BACK NULL ON THE FIRST LIVE RUN. It was only ever read off the
 * TIMELINE response, which does not carry it; the count lives on the USER
 * response from UserByScreenName. Several shapes are tried because X has moved
 * this field before, and a null here now has real consequences: without it the
 * completeness check cannot fire, and a run that reached 23% of an account
 * reads as complete.
 */
export function tweetCountOf(body) {
  const r = body?.data?.user?.result;
  const candidates = [
    r?.tweet_counts?.tweets,
    r?.legacy?.statuses_count,
    r?.core?.statuses_count,
    body?.tweet_counts?.tweets,
    body?.legacy?.statuses_count,
  ];
  for (const n of candidates) {
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * Coarse entry-id prefix, for reporting what was rejected.
 * "who-to-follow-1234" -> "who-to-follow", "tweet-1955..." -> "tweet".
 */
export function entryPrefix(entryId) {
  const s = String(entryId || 'unknown');
  const out = [];
  for (const part of s.split('-')) {
    if (out.length >= 3 || !/^[a-zA-Z]+$/.test(part)) break;
    out.push(part);
  }
  return out.length ? out.join('-') : s.slice(0, 24);
}

/** Unwrap the two tweet result shapes X uses. */
function unwrapTweet(node) {
  if (!node) return null;
  if (node.__typename === 'TweetWithVisibilityResults' && node.tweet) return node.tweet;
  if (node.tweet && !node.legacy) return node.tweet;
  return node;
}

/**
 * Collect this user's tweets and the bottom cursor from one instruction set.
 *
 * THIS FUNCTION IS A SAFETY BOUNDARY, NOT A CONVENIENCE. Read before loosening.
 *
 * The entries array does not contain only your posts. A live response carries a
 * `who-to-follow-` TimelineTimelineModule of SUGGESTED ACCOUNTS, and every
 * suggested user brings `pinned_items.tweet_ids_str` with it - OTHER PEOPLE'S
 * TWEET IDS, sitting in the same array as yours and shaped identically. A loose
 * walk that scoops up anything tweet-shaped harvests them, and a future
 * execution phase would then try to delete a stranger's post. That is the worst
 * thing this program could do.
 *
 * So an entry is accepted ONLY when all three hold:
 *
 *   1. `entry.content.entryType === 'TimelineTimelineItem'`
 *   2. `entry.content.itemContent.__typename === 'TimelineTweet'`
 *   3. `tweet.legacy.user_id_str === expectedUserId`  (resolved via
 *      UserByScreenName, i.e. proven to be us)
 *
 * Everything else is rejected and COUNTED by entry-id prefix, so the panel can
 * show what was skipped instead of silently dropping it. Modules are not walked
 * into at all - there is nothing of ours inside one.
 *
 * `expectedUserId` is mandatory and there is no permissive default: without it
 * this FAILS CLOSED and accepts nothing. A missing id must never mean "accept
 * everything", which is the shape this bug would take if anyone ever made the
 * argument optional.
 *
 * Instructions are iterated by TYPE, never by position - `instructions[0]` in
 * the live response is `{"type":"TimelineClearCache"}` and carries no entries.
 *
 * Returns { tweets, bottomCursor, accepted, entryCount, rejected }.
 */
export function collectEntries(instructions, { expectedUserId } = {}) {
  const tweets = [];
  let bottomCursor = null;
  let entryCount = 0;
  const rejected = {};
  const pinnedIds = new Set();

  const reject = (entry, why) => {
    const key = entryPrefix(entry?.entryId) + ' (' + why + ')';
    rejected[key] = (rejected[key] || 0) + 1;
  };

  /** The three-part gate. Returns the tweet result, or null. */
  const acceptTweet = (entry) => {
    const content = entry?.content;
    if (content?.entryType !== 'TimelineTimelineItem') {
      reject(entry, 'not a TimelineTimelineItem');
      return null;
    }
    const item = content.itemContent;
    if (item?.__typename !== 'TimelineTweet') {
      reject(entry, 'itemContent is ' + (item?.__typename || 'absent'));
      return null;
    }
    const result = unwrapTweet(item?.tweet_results?.result);
    if (!result?.legacy) {
      reject(entry, 'no legacy on tweet_results.result');
      return null;
    }
    if (!expectedUserId || String(result.legacy.user_id_str) !== String(expectedUserId)) {
      // The important one. A foreign author here is not a parse failure, it is
      // the who-to-follow payload doing exactly what it always does.
      reject(entry, 'FOREIGN AUTHOR');
      return null;
    }
    return result;
  };

  for (const ins of instructions) {
    const type = ins?.type || ins?.__typename;

    if (type === 'TimelineAddEntries') {
      for (const entry of ins.entries || []) {
        entryCount += 1;
        const content = entry?.content;

        // Cursor. Confirmed shape: content.__typename TimelineTimelineCursor,
        // cursorType "Bottom", opaque `value`, entryId prefix "cursor-bottom-".
        if (content?.__typename === 'TimelineTimelineCursor' ||
            content?.entryType === 'TimelineTimelineCursor') {
          if (content.cursorType === 'Bottom') bottomCursor = content.value;
          continue;
        }

        const result = acceptTweet(entry);
        if (result) tweets.push({ result, isPinned: pinnedIds.has(String(result.legacy.id_str)) });
      }
      continue;
    }

    // A pinned entry is recorded as an ID ONLY, never enumerated from here:
    // entries come from TimelineAddEntries and nowhere else. This exists so the
    // exclude-pinned veto still has something to match if the pinned post also
    // appears in the added entries. Untested against a real pinned post - the
    // captured account has none - so treat it as a guard, not a proven path.
    if (type === 'TimelinePinEntry' && ins.entry) {
      const result = acceptTweet(ins.entry);
      if (result?.legacy?.id_str) pinnedIds.add(String(result.legacy.id_str));
      continue;
    }

    // TimelineClearCache and anything else: no entries, nothing to do.
  }

  return { tweets, bottomCursor, accepted: tweets.length, entryCount, rejected };
}

/* ------------------------------------------------------- normalization --- */

function textOf(legacy, note) {
  if (note && typeof note.text === 'string') return note.text;
  return String(legacy?.full_text ?? legacy?.text ?? '');
}

function mediaOf(legacy) {
  const m =
    legacy?.extended_entities?.media ||
    legacy?.entities?.media ||
    [];
  return Array.isArray(m) && m.length > 0;
}

/**
 * Flatten one raw tweet result into the shape everything downstream uses.
 *
 * KIND IS DETERMINED PER ENTRY, NEVER FROM THE OPERATION IT ARRIVED IN.
 * "Originals" means not-retweets, not not-replies: UserOriginalsTimeline does
 * return replies (entries carry `in_reply_to_screen_name` and a
 * quick_promote_eligibility of "ReplyTweet"). Inferring kind from the stream
 * would mislabel every one of them.
 *
 *   reply   = legacy.in_reply_to_status_id_str present
 *   retweet = legacy.retweeted_status_result present
 *   post    = neither
 *
 * `sourceTweetId` is populated for retweets even though PHASE 1 NEVER USES IT.
 * It is captured now because phase 2 will undo a retweet against the ORIGINAL
 * post, not against your copy of it - and re-running a whole scan later just to
 * pick up one field would be silly.
 */
export function normalize(entry, screenName) {
  const result = entry?.result || entry;
  const legacy = result?.legacy;
  if (!legacy) return null;

  const id = String(legacy.id_str || result.rest_id || '');
  if (!id) return null;

  const rt = unwrapTweet(legacy.retweeted_status_result?.result);
  const isRetweet = Boolean(rt);
  const isReply = Boolean(legacy.in_reply_to_status_id_str);

  const kind = isRetweet ? 'retweet' : isReply ? 'reply' : 'post';

  // For a retweet the counts and text that matter to a human are the original's.
  const shown = isRetweet ? rt.legacy || legacy : legacy;
  const note = result?.note_tweet?.note_tweet_results?.result;

  const created = Date.parse(legacy.created_at);
  const handle =
    result?.core?.user_results?.result?.legacy?.screen_name ||
    result?.core?.user_results?.result?.core?.screen_name ||
    screenName ||
    'i';

  return {
    id,
    kind,
    createdAt: Number.isNaN(created) ? null : new Date(created).toISOString(),
    text: textOf(shown, isRetweet ? null : note),
    // All four confirmed to live under `legacy`.
    likeCount: Number(shown.favorite_count ?? 0),
    retweetCount: Number(shown.retweet_count ?? 0),
    replyCount: Number(shown.reply_count ?? 0),
    quoteCount: Number(shown.quote_count ?? 0),
    hasMedia: mediaOf(shown),
    isPinned: Boolean(entry?.isPinned),
    sourceTweetId: isRetweet ? String(rt.rest_id || rt.legacy?.id_str || '') : null,
    permalink: 'https://x.com/' + handle + '/status/' + id,
  };
}

/* ----------------------------------------------------------- the walk ---- */

/**
 * Walk the selected profile timeline operation to exhaustion.
 *
 * `operationName` is chosen by lib/discovery.js from TIMELINE_CANDIDATES and
 * passed in - it is NOT hardcoded here. X split the old single profile
 * timeline into tab-scoped operations and retired `UserTweetsAndReplies`, so a
 * hardcoded name is a guaranteed future outage.
 *
 * NOTE: the parsing below (instructionsOf / collectEntries / normalize) has NOT
 * yet been revalidated against the newer operations' responses. It is unchanged
 * on purpose, pending confirmation of which stream actually carries retweets.
 *
 * `onPage(posts, state)` is awaited after EVERY page. That is the checkpoint
 * hook, and it is why closing the tab mid-scan costs one page rather than the
 * run. Do not make it fire less often.
 *
 * Termination, in order of precedence:
 *   - shouldAbort()             -> endReason 'stopped'
 *   - no bottom cursor returned -> 'cursor-exhausted'
 *   - cursor repeats            -> 'cursor-repeat'  (X looping us)
 *   - an empty page             -> 'empty-page'
 * and independently, if the total is near CEILING_HINT we mark ceilingSuspected.
 */
export async function walkTimeline({
  userId,
  screenName,
  bearer,
  queryIds,
  operationName,
  startCursor = null,
  seenCursors = [],
  onPage,
  onLog = () => {},
  shouldAbort = () => false,
  pageSize = 100,
}) {
  let cursor = startCursor;
  const seen = new Set(seenCursors);
  let total = 0;
  let pages = 0;
  let endReason = null;
  const rejectedTotals = {};
  // user.tweet_counts.tweets - what X says the account has. A denominator for a
  // progress estimate, not a target: it counts differently from what this walk
  // can reach (the ~3,200 ceiling), so never treat a shortfall as an error.
  let reportedTotal = null;

  for (;;) {
    if (shouldAbort()) {
      endReason = 'stopped';
      break;
    }

    const variables = {
      userId,
      count: pageSize,
      includePromotedContent: false,
      withCommunity: true,
      withVoice: true,
      withV2Timeline: true,
    };
    if (cursor) variables.cursor = cursor;

    const body = await api.gql({
      queryId: queryIds[operationName],
      operationName,
      variables,
      bearer,
      fieldToggles: { withArticlePlainText: false },
      onLog,
      shouldAbort,
    });

    const instructions = instructionsOf(body);
    // expectedUserId is the safety gate - see collectEntries. It is the id
    // resolved through UserByScreenName, not anything read off an entry.
    const { tweets, bottomCursor, entryCount, rejected } =
      collectEntries(instructions, { expectedUserId: userId });

    if (reportedTotal === null) reportedTotal = tweetCountOf(body);

    const posts = [];
    for (const t of tweets) {
      const n = normalize(t, screenName);
      if (n) posts.push(n);
    }

    // Report what was skipped rather than dropping it silently. A
    // "FOREIGN AUTHOR" line here is the who-to-follow module being refused,
    // which is the guard working, not a fault.
    for (const [why, n] of Object.entries(rejected)) {
      rejectedTotals[why] = (rejectedTotals[why] || 0) + n;
    }
    if (Object.keys(rejected).length > 0) {
      onLog('info', 'page ' + (pages + 1) + ': skipped ' +
        Object.entries(rejected).map(([w, n]) => n + ' x ' + w).join(', '));
    }

    pages += 1;
    total += posts.length;

    await onPage(posts, {
      pages,
      total,
      cursor: bottomCursor,
      seenCursors: [...seen],
      rate: api.rateSnapshot(operationName),
      rejected: { ...rejectedTotals },
      reportedTotal,
    });

    if (posts.length === 0 && entryCount <= 2) {
      // Two entries or fewer and no posts means the page held nothing but
      // cursors. X is done serving history.
      endReason = 'empty-page';
      break;
    }
    if (!bottomCursor) {
      endReason = 'cursor-exhausted';
      break;
    }
    if (seen.has(bottomCursor)) {
      endReason = 'cursor-repeat';
      break;
    }
    seen.add(bottomCursor);
    cursor = bottomCursor;
  }

  const ceilingSuspected = total >= CEILING_SUSPECT_AT;
  return {
    total, pages, endReason, ceilingSuspected, lastCursor: cursor,
    rejected: rejectedTotals, reportedTotal,
  };
}

/**
 * Say plainly why we stopped. This is the one place the tool is allowed to be
 * blunt at the user's expense: if we cannot see the whole history we say so,
 * because "scan complete" over a partial view is the failure that would let
 * someone believe posts are gone when they are not.
 */
export function terminationReport({ total, endReason, ceilingSuspected }) {
  if (endReason === 'stopped') {
    return 'Stopped by you at ' + total + ' posts. Progress is checkpointed; ' +
      'starting again resumes from the last page.';
  }
  if (ceilingSuspected) {
    return CEILING_MESSAGE.replace('{N}', String(total));
  }
  if (endReason === 'cursor-repeat') {
    return 'Enumeration ended at ' + total + ' posts because X returned a cursor ' +
      'it had already given us. That usually means the end of what it will serve, ' +
      'but it is not a clean end-of-history signal - treat this count as a floor.';
  }
  return 'Enumeration complete: ' + total + ' posts. X ran out of cursor before ' +
    'the ~' + CEILING_HINT + ' timeline limit, so this is your full reachable history.';
}
