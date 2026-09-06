/**
 * Cursor-paginated walk of your own timeline, and normalization of what comes
 * back into a flat shape the filters can reason about.
 *
 * READ ONLY. Nothing in this file mutates anything on X. Phase 1 is a scanner.
 */

import * as api from './api.js';
import * as store from './store.js';

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
      onLog('info', 'resolved @' + screenName + ' via UserByScreenName');
      return { userId: String(restId), screenName, via: 'UserByScreenName' };
    }
    onLog('warn', 'UserByScreenName returned no rest_id for @' + screenName);
  } else {
    onLog('warn', 'could not read a handle from the page chrome');
  }

  const cookieId = userIdFromCookie();
  if (cookieId) {
    onLog('info', 'resolved user id from the twid cookie (page scrape failed)');
    return { userId: cookieId, screenName: screenName || null, via: 'twid-cookie' };
  }

  throw new Error(
    'Could not work out which account is logged in. Open https://x.com/home in ' +
    'this tab, make sure you are logged in, and try again.'
  );
}

/* --------------------------------------------- response tree walking ----- */

/** Instructions live under slightly different keys across builds. */
export function instructionsOf(body) {
  const u = body?.data?.user?.result;
  const tl =
    u?.timeline_v2?.timeline ||
    u?.timeline?.timeline ||
    u?.timeline_response?.timeline ||
    null;
  const ins = tl?.instructions;
  return Array.isArray(ins) ? ins : [];
}

/** Unwrap the two tweet result shapes X uses. */
function unwrapTweet(node) {
  if (!node) return null;
  if (node.__typename === 'TweetWithVisibilityResults' && node.tweet) return node.tweet;
  if (node.tweet && !node.legacy) return node.tweet;
  return node;
}

/**
 * Collect every tweet-bearing item plus the cursors, out of one instruction set.
 * Returns { tweets: [{result, isPinned}], bottomCursor, topCursor, entryCount }.
 */
export function collectEntries(instructions) {
  const tweets = [];
  let bottomCursor = null;
  let topCursor = null;
  let entryCount = 0;

  const pushItemContent = (itemContent, isPinned) => {
    if (!itemContent) return;
    if (itemContent.entryType === 'TimelineTimelineCursor' || itemContent.cursorType) {
      if (itemContent.cursorType === 'Bottom') bottomCursor = itemContent.value;
      if (itemContent.cursorType === 'Top') topCursor = itemContent.value;
      return;
    }
    const result = unwrapTweet(itemContent?.tweet_results?.result);
    if (result) tweets.push({ result, isPinned });
  };

  const walkEntry = (entry, isPinned) => {
    entryCount += 1;
    const content = entry?.content;
    if (!content) return;

    if (content.entryType === 'TimelineTimelineCursor' || content.cursorType) {
      if (content.cursorType === 'Bottom') bottomCursor = content.value;
      if (content.cursorType === 'Top') topCursor = content.value;
      return;
    }
    if (content.entryType === 'TimelineTimelineItem' || content.itemContent) {
      pushItemContent(content.itemContent, isPinned);
      return;
    }
    // A conversation module: several tweets under one entry, and it can carry a
    // ShowMore cursor of its own which we deliberately ignore - phase 1 wants
    // your posts, not the full reply tree under them.
    if (content.entryType === 'TimelineTimelineModule' || Array.isArray(content.items)) {
      for (const it of content.items || []) pushItemContent(it?.item?.itemContent, isPinned);
    }
  };

  for (const ins of instructions) {
    const type = ins?.type || ins?.__typename;
    if (type === 'TimelineAddEntries' || Array.isArray(ins?.entries)) {
      for (const e of ins.entries || []) walkEntry(e, false);
    } else if (type === 'TimelinePinEntry' && ins.entry) {
      walkEntry(ins.entry, true);
    } else if (type === 'TimelineReplaceEntry' && ins.entry) {
      walkEntry(ins.entry, false);
    }
  }

  return { tweets, bottomCursor, topCursor, entryCount };
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
 * `sourceTweetId` is populated for retweets even though PHASE 1 NEVER USES IT.
 * It is captured now because phase 2 will undo a retweet with DeleteRetweet
 * against the ORIGINAL post, not DeleteTweet against your copy of it - and
 * re-running a whole scan later just to pick up one field would be silly.
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
    likeCount: Number(shown.favorite_count ?? 0),
    retweetCount: Number(shown.retweet_count ?? 0),
    replyCount: Number(shown.reply_count ?? 0),
    hasMedia: mediaOf(shown),
    isPinned: Boolean(entry?.isPinned),
    sourceTweetId: isRetweet ? String(rt.rest_id || rt.legacy?.id_str || '') : null,
    permalink: 'https://x.com/' + handle + '/status/' + id,
  };
}

/* ----------------------------------------------------------- the walk ---- */

/**
 * Walk UserTweetsAndReplies to exhaustion.
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
      queryId: queryIds.UserTweetsAndReplies,
      operationName: 'UserTweetsAndReplies',
      variables,
      bearer,
      fieldToggles: { withArticlePlainText: false },
      onLog,
      shouldAbort,
    });

    const instructions = instructionsOf(body);
    const { tweets, bottomCursor, entryCount } = collectEntries(instructions);

    const posts = [];
    for (const t of tweets) {
      const n = normalize(t, screenName);
      if (n) posts.push(n);
    }

    pages += 1;
    total += posts.length;

    await onPage(posts, {
      pages,
      total,
      cursor: bottomCursor,
      seenCursors: [...seen],
      rate: api.rateSnapshot(),
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
  return { total, pages, endReason, ceilingSuspected, lastCursor: cursor };
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
