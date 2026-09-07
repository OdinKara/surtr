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

/**
 * Hard bound on pages per stream.
 *
 * Nothing else bounds the walk: it stops when the cursor runs out, repeats, or
 * returns an empty page. If X ever hands back a fresh cursor indefinitely,
 * those three never fire and the walk runs until someone notices. A live
 * replies stream reached 133 pages legitimately, so the bound has to be well
 * clear of real depth - but unbounded is not a safe default for a loop that
 * makes network requests.
 *
 * Generous on purpose: 500 pages is ~10,000 entries, far past X's own ~3,200
 * ceiling, so hitting this means something is wrong rather than that an account
 * is large.
 */
export const MAX_PAGES_PER_STREAM = 500;

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
 * The account-wide item total, used as a progress denominator and - far more
 * importantly - as the check that a run actually saw the account.
 *
 * TWO SOURCES, BOTH VERIFIED AGAINST A CAPTURED LIVE BODY. No speculative
 * paths: an earlier version guessed at four of them and every one came back
 * null, which is worse than useless because it makes the guard look present.
 *
 *   PRIMARY   the author object embedded in every tweet entry:
 *             result.core.user_results.result.tweet_counts.tweets
 *             (captured live as {"media_tweets": 86, "tweets": 2616})
 *   SECONDARY the UserByScreenName user response: result.tweet_counts.tweets
 *
 * The primary is read from the first ACCEPTED entry of the first page, and that
 * word is load-bearing. Every author object carries its own count, including
 * the foreign ones: the captured replies page held 19 DIFFERENT totals, from 14
 * to 359,228, one per participant in the threads. Reading the count off an
 * ungated entry would silently produce a denominator belonging to a stranger,
 * and the completeness check would then be measuring against someone else's
 * account. Accepted means the gate passed, so the author is us and the count is
 * ours.
 */

/** PRIMARY. Read the total off an accepted tweet result's embedded author. */
export function accountTotalFromTweet(result) {
  const n = result?.core?.user_results?.result?.tweet_counts?.tweets;
  return Number.isFinite(n) ? n : null;
}

/** SECONDARY. Read the total off a UserByScreenName response. */
export function tweetCountOf(body) {
  const n = body?.data?.user?.result?.tweet_counts?.tweets;
  return Number.isFinite(n) ? n : null;
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
 * CONVERSATION MODULES. UserRepliesTimeline does not return flat entries at
 * all: replies arrive wrapped in `profile-conversation-` modules whose items[]
 * hold the thread. Those ARE walked into - and the module contains the other
 * participants' tweets by definition, so the gate above is applied to every
 * item unchanged. The `who-to-follow-` module is also a module and is still
 * rejected whole; the predicate is scoped to conversation modules specifically,
 * never to modules generally.
 *
 * Returns { tweets, bottomCursor, accepted, entryCount, rejected,
 *            dispensableAnomalies }.
 */
export function collectEntries(instructions, { expectedUserId } = {}) {
  const tweets = [];
  let bottomCursor = null;
  let entryCount = 0;
  const rejected = {};
  const pinnedIds = new Set();
  const dispensableAnomalies = [];

  const reject = (entryId, why) => {
    const key = entryPrefix(entryId) + ' (' + why + ')';
    rejected[key] = (rejected[key] || 0) + 1;
  };

  /**
   * The gate itself, applied to one itemContent. Used UNMODIFIED by both the
   * flat-entry path and the conversation-module path - the only difference
   * between them is how you get here, never how strict it is once you have.
   */
  const acceptItemContent = (itemContent, entryId) => {
    if (itemContent?.__typename !== 'TimelineTweet') {
      reject(entryId, 'itemContent is ' + (itemContent?.__typename || 'absent'));
      return null;
    }
    const result = unwrapTweet(itemContent?.tweet_results?.result);
    if (!result?.legacy) {
      reject(entryId, 'no legacy on tweet_results.result');
      return null;
    }
    if (!expectedUserId || String(result.legacy.user_id_str) !== String(expectedUserId)) {
      // Inside a conversation module this is the common case, not an anomaly:
      // the person being replied to is in the thread by definition.
      reject(entryId, 'FOREIGN AUTHOR');
      return null;
    }
    return result;
  };

  /** Flat entry: must be a TimelineTimelineItem before the gate even applies. */
  const acceptTweet = (entry) => {
    if (entry?.content?.entryType !== 'TimelineTimelineItem') {
      reject(entry?.entryId, 'not a TimelineTimelineItem');
      return null;
    }
    return acceptItemContent(entry.content.itemContent, entry?.entryId);
  };

  /**
   * A conversation module, and ONLY a conversation module.
   *
   * Scoped three ways on purpose - entryType, displayType and the entryId
   * prefix - because "walk into modules" as a general rule would also walk into
   * the `who-to-follow-` module, which is a TimelineTimelineModule too and is
   * full of suggested accounts and their pinned tweet ids. That module must
   * keep being rejected whole. Broadening this predicate is how the safety
   * property gets lost quietly.
   */
  const isConversationModule = (entry) => {
    const c = entry?.content;
    return c?.entryType === 'TimelineTimelineModule' &&
      c?.displayType === 'VerticalConversation' &&
      String(entry?.entryId || '').startsWith('profile-conversation');
  };

  /**
   * `dispensable` correlated perfectly with authorship in the captured page -
   * every one of my 20 items was dispensable:false, every one of the 19 foreign
   * items was dispensable:true.
   *
   * It is NOT the gate and must never become one. It is an independent
   * CROSS-CHECK: a divergence means the model of these modules is wrong, and
   * that is worth a warning. A defect detector, not access control - keying on
   * it would mean trusting a display hint with the question of whose posts we
   * are about to enumerate.
   */
  const crossCheckDispensable = (item, mine) => {
    const d = item?.dispensable;
    if (typeof d !== 'boolean') return;
    if (mine === d) {
      dispensableAnomalies.push({ entryId: item?.entryId, mine, dispensable: d });
    }
  };

  for (const ins of instructions) {
    const type = ins?.type || ins?.__typename;

    if (type === 'TimelineAddEntries') {
      for (const entry of ins.entries || []) {
        entryCount += 1;
        const content = entry?.content;

        // Cursors stay at the TOP LEVEL of entries - confirmed live, none
        // inside modules - so pagination is untouched by module walking.
        if (content?.__typename === 'TimelineTimelineCursor' ||
            content?.entryType === 'TimelineTimelineCursor') {
          if (content.cursorType === 'Bottom') bottomCursor = content.value;
          continue;
        }

        if (isConversationModule(entry)) {
          for (const item of content.items || []) {
            const result = acceptItemContent(item?.item?.itemContent, item?.entryId);
            crossCheckDispensable(item, Boolean(result));
            if (result) {
              tweets.push({
                result,
                isPinned: pinnedIds.has(String(result.legacy.id_str)),
              });
            }
          }
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
    // appears in the added entries.
    if (type === 'TimelinePinEntry' && ins.entry) {
      const result = acceptTweet(ins.entry);
      if (result?.legacy?.id_str) pinnedIds.add(String(result.legacy.id_str));
      continue;
    }

    // TimelineClearCache and anything else: no entries, nothing to do.
  }

  return {
    tweets, bottomCursor, accepted: tweets.length, entryCount, rejected,
    dispensableAnomalies,
  };
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
  onRateLimit = () => {},
  pageSize = 100,
}) {
  let cursor = startCursor;
  const seen = new Set(seenCursors);
  let total = 0;
  let pages = 0;
  let endReason = null;
  const rejectedTotals = {};
  let anomalyTotal = 0;
  // What X says the account holds. A denominator for the completeness check,
  // not a target: it counts differently from what this walk can reach (the
  // ~3,200 ceiling), so a shortfall is a fact to report, not an error.
  let reportedTotal = null;
  let reportedTotalSource = null;

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
      onRateLimit,
    });

    const instructions = instructionsOf(body);
    // expectedUserId is the safety gate - see collectEntries. It is the id
    // resolved through UserByScreenName, not anything read off an entry.
    const { tweets, bottomCursor, entryCount, rejected, dispensableAnomalies } =
      collectEntries(instructions, { expectedUserId: userId });

    // `dispensable` is a CROSS-CHECK, never the gate. It correlated perfectly
    // with authorship on the captured page, so a divergence means the model of
    // these modules is wrong and is worth saying out loud.
    if (dispensableAnomalies.length > 0) {
      onLog('warn',
        'DISPENSABLE MISMATCH on ' + dispensableAnomalies.length + ' item(s) in ' +
        operationName + ': ' +
        dispensableAnomalies.slice(0, 5).map(
          (a) => a.entryId + ' (' + (a.mine ? 'mine' : 'foreign') +
                 ' but dispensable=' + a.dispensable + ')').join(', ') +
        '. Authorship still decided the outcome - this is a model warning, not a ' +
        'gate failure.');
      anomalyTotal += dispensableAnomalies.length;
    }

    // PRIMARY source for the account total: the author object embedded in the
    // first accepted entry. Accepted means the gate passed, so it is our author
    // and our count.
    if (reportedTotal === null) {
      for (const t of tweets) {
        const n = accountTotalFromTweet(t.result);
        if (n !== null) {
          reportedTotal = n;
          reportedTotalSource = 'timeline-entry';
          onLog('info', 'account total ' + n + ' read from an entry author in ' +
            operationName);
          break;
        }
      }
    }

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
      reportedTotalSource,
      dispensableAnomalies: anomalyTotal,
    });

    if (pages >= MAX_PAGES_PER_STREAM) {
      endReason = 'page-limit';
      onLog('error', operationName + ' hit the ' + MAX_PAGES_PER_STREAM + '-page bound ' +
        'without the cursor ending. That is past anything a real account should need, ' +
        'so treat it as a cursor that is not terminating rather than a large account.');
      break;
    }

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
    rejected: rejectedTotals, reportedTotal, reportedTotalSource,
    dispensableAnomalies: anomalyTotal,
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
