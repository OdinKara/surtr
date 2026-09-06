/**
 * Parser tests for lib/enumerate.js.
 *
 *     node tests/parser.test.mjs
 *
 * No framework, no npm, no build step - consistent with the rest of the repo.
 * The module is loaded through a data: URL so that a plain `.js` file can be
 * imported as ESM without a package.json declaring a module type, which would
 * look like the start of a toolchain this project deliberately does not have.
 *
 * THE POINT OF THIS FILE is the who-to-follow case. A real profile timeline
 * response carries a module of SUGGESTED ACCOUNTS, and each suggested user
 * brings `pinned_items.tweet_ids_str` with it - other people's tweet ids, in
 * the same entries array as yours, shaped exactly like yours. If the parser
 * ever harvests one, a future execution phase would try to delete a stranger's
 * post. That is the failure this test exists to make impossible to reintroduce
 * silently.
 *
 * Every id below is a placeholder. No real account or tweet id appears here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'lib', 'enumerate.js'), 'utf8');
const mod = await import(
  'data:text/javascript;base64,' + Buffer.from(SRC, 'utf8').toString('base64')
);

let fails = 0;
const ok = (c, m) => { console.log((c ? '[OK]  ' : '[X]   ') + m); if (!c) fails++; };

/* ---------------------------------------------------------- placeholders --- */

const ME = '1000000000000000001';           // us
const STRANGER = '2000000000000000002';     // a suggested account
const STRANGER_2 = '2000000000000000003';   // another suggested account
const RT_AUTHOR = '2000000000000000004';    // author of a post we retweeted

const MY_POST = '3000000000000000001';
const MY_REPLY = '3000000000000000002';
const MY_RETWEET = '3000000000000000003';
const MY_SELF_REPLY = '3000000000000000004';

// Ids that must NEVER be enumerated as something of ours.
const FOREIGN_PINNED_A = '4000000000000000001';
const FOREIGN_PINNED_B = '4000000000000000002';
const FOREIGN_TWEET = '4000000000000000009';

// The original behind our retweet. Expected as sourceTweetId, never as an id.
const RT_SOURCE = '5000000000000000001';

const CURSOR = 'DAABCgABTESTCURSORVALUE';

/* -------------------------------------------------------------- fixtures --- */

const tweetResult = (id, userId, extra = {}) => ({
  __typename: 'Tweet',
  rest_id: id,
  core: { user_results: { result: { legacy: { screen_name: 'placeholder' } } } },
  legacy: {
    id_str: id,
    user_id_str: userId,
    full_text: 'placeholder text for ' + id,
    created_at: 'Thu Oct 30 13:34:36 +0000 2025',
    favorite_count: 1,
    retweet_count: 2,
    reply_count: 3,
    quote_count: 4,
    ...extra,
  },
});

const tweetEntry = (entryId, result) => ({
  entryId,
  content: {
    entryType: 'TimelineTimelineItem',
    __typename: 'TimelineTimelineItem',
    itemContent: { __typename: 'TimelineTweet', tweet_results: { result } },
  },
});

/** The dangerous one: suggested accounts carrying other people's tweet ids. */
const whoToFollowEntry = {
  entryId: 'who-to-follow-1955000000000000000-0',
  content: {
    entryType: 'TimelineTimelineModule',
    __typename: 'TimelineTimelineModule',
    items: [
      {
        entryId: 'who-to-follow-1955000000000000000-0-user-' + STRANGER,
        item: {
          itemContent: {
            __typename: 'TimelineUser',
            user_results: {
              result: {
                rest_id: STRANGER,
                legacy: {
                  screen_name: 'suggested_one',
                  pinned_tweet_ids_str: [FOREIGN_PINNED_A],
                },
                pinned_items: { tweet_ids_str: [FOREIGN_PINNED_A] },
              },
            },
          },
        },
      },
      {
        entryId: 'who-to-follow-1955000000000000000-1-user-' + STRANGER_2,
        item: {
          itemContent: {
            __typename: 'TimelineUser',
            user_results: {
              result: {
                rest_id: STRANGER_2,
                legacy: {
                  screen_name: 'suggested_two',
                  pinned_tweet_ids_str: [FOREIGN_PINNED_B],
                },
                pinned_items: { tweet_ids_str: [FOREIGN_PINNED_B] },
              },
            },
          },
        },
      },
    ],
  },
};

const body = {
  data: {
    user: {
      result: {
        __typename: 'User',
        rest_id: ME,
        tweet_counts: { tweets: 1234 },
        timeline: {
          timeline: {
            instructions: [
              // instructions[0] carries no entries. Positional indexing dies here.
              { type: 'TimelineClearCache' },
              {
                type: 'TimelineAddEntries',
                entries: [
                  tweetEntry('tweet-' + MY_POST, tweetResult(MY_POST, ME)),
                  tweetEntry('tweet-' + MY_REPLY, tweetResult(MY_REPLY, ME, {
                    in_reply_to_status_id_str: '3000000000000000000',
                    in_reply_to_screen_name: 'someone',
                  })),
                  tweetEntry('tweet-' + MY_RETWEET, tweetResult(MY_RETWEET, ME, {
                    retweeted_status_result: {
                      result: tweetResult(RT_SOURCE, RT_AUTHOR),
                    },
                  })),
                  // Same shape, different author. Must be refused.
                  tweetEntry('tweet-' + FOREIGN_TWEET, tweetResult(FOREIGN_TWEET, STRANGER)),
                  whoToFollowEntry,
                  // A non-tweet item that still looks like an item.
                  {
                    entryId: 'promoted-tweet-999',
                    content: {
                      entryType: 'TimelineTimelineItem',
                      itemContent: { __typename: 'TimelineUser' },
                    },
                  },
                  {
                    entryId: 'cursor-bottom-' + CURSOR,
                    content: {
                      entryType: 'TimelineTimelineCursor',
                      __typename: 'TimelineTimelineCursor',
                      cursorType: 'Bottom',
                      value: CURSOR,
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  },
};

/* ----------------------------------------------------------------- tests --- */

const instructions = mod.instructionsOf(body);
ok(instructions.length === 2, 'instructionsOf finds the live timeline.timeline path');
ok(instructions[0].type === 'TimelineClearCache',
   'instructions[0] is TimelineClearCache and carries no entries');
ok(mod.tweetCountOf(body) === 1234, 'tweetCountOf reads user.tweet_counts.tweets');

ok(mod.instructionsOf({ data: { user: { result: { timeline_v2: {
  timeline: { instructions: [1] } } } } } }).length === 1,
  'the timeline_v2 fallback still works for older builds');

const res = mod.collectEntries(instructions, { expectedUserId: ME });
const posts = res.tweets.map((t) => mod.normalize(t, 'placeholder'));
const ids = posts.map((p) => p.id);

ok(res.accepted === 3, 'exactly 3 entries accepted, got ' + res.accepted);
ok(JSON.stringify(ids) === JSON.stringify([MY_POST, MY_REPLY, MY_RETWEET]),
   'accepted ids are exactly ours');

// THE SAFETY ASSERTION.
const serialized = JSON.stringify(posts);
for (const [name, id] of [
  ['who-to-follow pinned id A', FOREIGN_PINNED_A],
  ['who-to-follow pinned id B', FOREIGN_PINNED_B],
  ['a foreign-authored tweet entry', FOREIGN_TWEET],
  ['a suggested account id', STRANGER],
  ['another suggested account id', STRANGER_2],
]) {
  ok(!serialized.includes(id), 'NOT enumerated: ' + name);
}

ok(res.bottomCursor === CURSOR, 'bottom cursor read from the confirmed shape');

const rejectedKeys = Object.keys(res.rejected).join(' | ');
ok(/who-to-follow/.test(rejectedKeys), 'who-to-follow module counted as rejected');
ok(/FOREIGN AUTHOR/.test(rejectedKeys), 'the foreign-authored tweet is counted as FOREIGN AUTHOR');
ok(/promoted-tweet/.test(rejectedKeys), 'the non-TimelineTweet item is counted as rejected');
console.log('      rejected: ' + rejectedKeys);

/* kind is classified per entry, not per operation */
const byId = Object.fromEntries(posts.map((p) => [p.id, p]));
ok(byId[MY_POST].kind === 'post', 'a plain post classifies as post');
ok(byId[MY_REPLY].kind === 'reply', 'in_reply_to_status_id_str classifies as reply');
ok(byId[MY_RETWEET].kind === 'retweet', 'retweeted_status_result classifies as retweet');
ok(byId[MY_RETWEET].sourceTweetId === RT_SOURCE,
   'a retweet captures the ORIGINAL id as sourceTweetId');
ok(byId[MY_POST].sourceTweetId === null, 'a non-retweet has no sourceTweetId');

/* confirmed field shapes */
ok(byId[MY_POST].likeCount === 1 && byId[MY_POST].retweetCount === 2 &&
   byId[MY_POST].replyCount === 3 && byId[MY_POST].quoteCount === 4,
   'counts read from legacy: favorite/retweet/reply/quote');
ok(byId[MY_POST].createdAt === '2025-10-30T13:34:36.000Z',
   "legacy.created_at parses ('Thu Oct 30 13:34:36 +0000 2025')");
ok(byId[MY_POST].text === 'placeholder text for ' + MY_POST, 'text read from legacy.full_text');
ok(byId[MY_POST].hasMedia === false, 'hasMedia false when no media entities');

const withMedia = mod.normalize(
  { result: tweetResult(MY_POST, ME, { extended_entities: { media: [{ type: 'photo' }] } }) },
  'placeholder');
ok(withMedia.hasMedia === true, 'hasMedia true from extended_entities.media');

/* FAIL CLOSED: no expectedUserId must mean nothing is accepted, never everything */
const noId = mod.collectEntries(instructions, {});
ok(noId.accepted === 0, 'without expectedUserId the parser accepts NOTHING (fails closed)');
const wrongId = mod.collectEntries(instructions, { expectedUserId: STRANGER });
ok(wrongId.accepted === 1 && wrongId.tweets[0].result.legacy.id_str === FOREIGN_TWEET,
   'the gate keys on the id it is given, not on position');

/* -------------------------------------------------------------------------
 * A RETWEET BY ME OF A FOREIGN-AUTHORED POST.
 *
 * The gate must key on the OUTER entry's author. For a retweet the outer tweet
 * is authored by ME; `retweeted_status_result` holds ANOTHER USER'S tweet, with
 * their user id on it. Two ways to get this wrong, and this asserts against
 * both:
 *
 *   - rejecting a legitimate retweet because the EMBEDDED original has a
 *     foreign author (we would silently lose every retweet, and phase 2 would
 *     never be able to undo them)
 *   - accepting the embedded original as an enumerable item in its own right
 *     (we would try to delete a stranger's post - the thing the whole gate
 *     exists to prevent)
 *
 * The correct outcome is exactly ONE enumerated item: mine, kind "retweet",
 * with sourceTweetId pointing at the foreign original.
 * ------------------------------------------------------------------------- */

const repostsInstructions = [
  { type: 'TimelineClearCache' },
  {
    type: 'TimelineAddEntries',
    entries: [
      tweetEntry('tweet-' + MY_RETWEET, tweetResult(MY_RETWEET, ME, {
        retweeted_status_result: { result: tweetResult(RT_SOURCE, RT_AUTHOR) },
      })),
      {
        entryId: 'cursor-bottom-' + CURSOR,
        content: {
          entryType: 'TimelineTimelineCursor',
          __typename: 'TimelineTimelineCursor',
          cursorType: 'Bottom',
          value: CURSOR,
        },
      },
    ],
  },
];

const rp = mod.collectEntries(repostsInstructions, { expectedUserId: ME });
ok(rp.accepted === 1, 'a retweet of a foreign post enumerates as exactly ONE item');

const rpPosts = rp.tweets.map((t) => mod.normalize(t, 'placeholder'));
ok(rpPosts.length === 1 && rpPosts[0].id === MY_RETWEET,
   'the enumerated id is MINE (the outer retweet), not the original');
ok(rpPosts[0].kind === 'retweet', 'classified as retweet on its own evidence');
ok(rpPosts[0].sourceTweetId === RT_SOURCE,
   'sourceTweetId is the FOREIGN original id, captured for phase 2');
ok(!rpPosts.some((x) => x.id === RT_SOURCE),
   'the embedded original is NOT enumerated as an item in its own right');
ok(Object.keys(rp.rejected).length === 0,
   'the retweet is not rejected for having a foreign author on the embedded original');

// And the mirror case: a retweet BY A STRANGER must still be refused outright.
const foreignRepost = mod.collectEntries([{
  type: 'TimelineAddEntries',
  entries: [tweetEntry('tweet-' + FOREIGN_TWEET, tweetResult(FOREIGN_TWEET, STRANGER, {
    retweeted_status_result: { result: tweetResult(RT_SOURCE, RT_AUTHOR) },
  }))],
}], { expectedUserId: ME });
ok(foreignRepost.accepted === 0,
   "someone else's retweet is refused on the OUTER author, embedded original irrelevant");

// A non-retweet arriving in the reposts stream must be classified honestly.
const oddOne = mod.collectEntries([{
  type: 'TimelineAddEntries',
  entries: [tweetEntry('tweet-' + MY_POST, tweetResult(MY_POST, ME))],
}], { expectedUserId: ME });
const oddPost = mod.normalize(oddOne.tweets[0], 'placeholder');
ok(oddPost.kind === 'post',
   'a non-retweet in the reposts stream classifies as post, not assumed retweet');

/* -------------------------------------------------------------------------
 * A REPLY FROM THE REPLIES STREAM.
 *
 * Kind is decided by the ENTRY, never by which stream it arrived in, so a reply
 * out of UserRepliesTimeline must classify as "reply" for the same reason one
 * out of UserOriginalsTimeline does: in_reply_to_status_id_str is present.
 * ------------------------------------------------------------------------- */

const repliesInstructions = [
  { type: 'TimelineClearCache' },
  {
    type: 'TimelineAddEntries',
    entries: [
      tweetEntry('tweet-' + MY_REPLY, tweetResult(MY_REPLY, ME, {
        in_reply_to_status_id_str: '3000000000000000000',
        in_reply_to_screen_name: 'someone',
      })),
      // A self-reply: replying to my own post, which is what makes a thread and
      // what makes posts/replies overlap.
      tweetEntry('tweet-' + MY_SELF_REPLY, tweetResult(MY_SELF_REPLY, ME, {
        in_reply_to_status_id_str: MY_POST,
        in_reply_to_user_id_str: ME,
        in_reply_to_screen_name: 'placeholder',
      })),
      // A stranger's reply in the same thread must still be refused.
      tweetEntry('tweet-' + FOREIGN_TWEET, tweetResult(FOREIGN_TWEET, STRANGER, {
        in_reply_to_status_id_str: MY_POST,
      })),
    ],
  },
];

const rep = mod.collectEntries(repliesInstructions, { expectedUserId: ME });
ok(rep.accepted === 2, 'replies stream: my reply and my self-reply accepted, stranger refused');

const repPosts = rep.tweets.map((t) => mod.normalize(t, 'placeholder'));
ok(repPosts.every((p) => p.kind === 'reply'),
   'both classify as kind "reply" from the entry, not from the stream');
ok(!JSON.stringify(repPosts).includes(FOREIGN_TWEET),
   "a stranger's reply in my thread is not enumerated");
ok(/FOREIGN AUTHOR/.test(Object.keys(rep.rejected).join(' ')),
   'the stranger reply is counted as FOREIGN AUTHOR');

const selfReply = repPosts.find((p) => p.id === MY_SELF_REPLY);
ok(selfReply.sourceTweetId === null,
   'a self-reply is not a retweet, so it carries no sourceTweetId');

/* positional indexing would have found nothing */
ok(mod.collectEntries([instructions[0]], { expectedUserId: ME }).accepted === 0,
   'a TimelineClearCache-only instruction set yields no entries and does not throw');

console.log(fails ? `\nFAILED (${fails})` : `\nALL PASS`);
process.exit(fails ? 1 : 0);
