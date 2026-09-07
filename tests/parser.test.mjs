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

/* -------------------------------------------------------------------------
 * THE ACCOUNT TOTAL, from where it actually lives.
 *
 * Not on the timeline root and not (reliably) on the user response: it is on
 * the AUTHOR OBJECT embedded in every tweet entry. Captured live as
 * {"media_tweets": 86, "tweets": 2616}. Two previous attempts to read this
 * from guessed paths returned null on a live run, which left the completeness
 * guard with no denominator - a guard that cannot fire being identical to no
 * guard at all.
 * ------------------------------------------------------------------------- */

{
  const withCount = tweetResult(MY_POST, ME);
  withCount.core = {
    user_results: { result: { legacy: { screen_name: 'placeholder' },
                              tweet_counts: { media_tweets: 86, tweets: 2616 } } },
  };
  ok(mod.accountTotalFromTweet(withCount) === 2616,
     'account total read from the author object embedded in a tweet entry');

  ok(mod.accountTotalFromTweet(tweetResult(MY_POST, ME)) === null,
     'an entry without the count returns null rather than a guess');
  ok(mod.accountTotalFromTweet(null) === null, 'a missing result does not throw');

  ok(mod.tweetCountOf({ data: { user: { result: { tweet_counts: { tweets: 99 } } } } }) === 99,
     'the secondary source still reads the user response');
  ok(mod.tweetCountOf({ data: { user: { result: {} } } }) === null,
     'the secondary source returns null when absent, with no speculative fallbacks');
}

/* -------------------------------------------------------------------------
 * CONVERSATION MODULES - the highest-risk parsing in the project.
 *
 * UserRepliesTimeline returns no flat entries at all. Replies arrive wrapped in
 * `profile-conversation-` modules whose items[] hold the whole thread, which
 * means the module CONTAINS OTHER PEOPLE'S TWEETS BY DEFINITION - the person
 * being replied to is right there next to my reply, in the same array, in the
 * same shape.
 *
 * Measured on a live page: 20 modules, 39 items, 20 mine and 19 foreign across
 * 18 distinct foreign authors. So the walk must pick out exactly my 20 and
 * leave the other 19 alone, using nothing but the author check.
 * ------------------------------------------------------------------------- */

const convItem = (entryId, result, dispensable) => ({
  entryId,
  dispensable,
  item: {
    itemContent: {
      __typename: 'TimelineTweet',
      itemType: 'TimelineTweet',
      tweetDisplayType: 'Tweet',
      tweet_results: { result },
    },
  },
});

const conversationModule = (entryId, items) => ({
  entryId,
  content: {
    __typename: 'TimelineTimelineModule',
    entryType: 'TimelineTimelineModule',
    displayType: 'VerticalConversation',
    items,
  },
});

const reply = (id, author, inReplyTo) =>
  tweetResult(id, author, { in_reply_to_status_id_str: inReplyTo,
                            in_reply_to_screen_name: 'someone' });

{
  // One of my replies plus two foreign tweets, exactly as a real thread arrives.
  const mod2 = conversationModule('profile-conversation-9001', [
    convItem('profile-conversation-9001-tweet-' + FOREIGN_TWEET,
             reply(FOREIGN_TWEET, STRANGER, '7000000000000000000'), true),
    convItem('profile-conversation-9001-tweet-' + MY_REPLY,
             reply(MY_REPLY, ME, FOREIGN_TWEET), false),
    convItem('profile-conversation-9001-tweet-' + FOREIGN_PINNED_B,
             reply(FOREIGN_PINNED_B, STRANGER_2, MY_REPLY), true),
  ]);

  const r = mod.collectEntries(
    [{ type: 'TimelineClearCache' }, { type: 'TimelineAddEntries', entries: [mod2] }],
    { expectedUserId: ME });

  ok(r.accepted === 1, 'a 3-item conversation module enumerates EXACTLY ONE item (mine)');
  const got = r.tweets.map((t) => mod.normalize(t, 'placeholder'));
  ok(got[0].id === MY_REPLY, 'the enumerated item is mine');
  ok(got[0].kind === 'reply', 'it classifies as kind "reply" from the entry');
  const blob = JSON.stringify(got);
  ok(!blob.includes(FOREIGN_TWEET) && !blob.includes(FOREIGN_PINNED_B),
     "neither foreign tweet in the thread is enumerated");
  ok(!blob.includes(STRANGER) && !blob.includes(STRANGER_2),
     'no foreign author id reaches the output');
  const foreignCount = Object.entries(r.rejected)
    .filter(([k]) => /FOREIGN AUTHOR/.test(k))
    .reduce((a, [, n]) => a + n, 0);
  ok(foreignCount === 2, 'both foreign items are COUNTED as rejections, got ' + foreignCount);
  ok(/profile-conversation/.test(Object.keys(r.rejected).join(' ')),
     'rejections are attributed to the profile-conversation prefix');
  ok(r.dispensableAnomalies.length === 0,
     'dispensable agrees with authorship, so no cross-check warning');
}

{
  // A module with no item of mine must enumerate nothing.
  const foreignOnly = conversationModule('profile-conversation-9002', [
    convItem('profile-conversation-9002-tweet-' + FOREIGN_TWEET,
             reply(FOREIGN_TWEET, STRANGER, '7000000000000000000'), true),
  ]);
  const r = mod.collectEntries(
    [{ type: 'TimelineAddEntries', entries: [foreignOnly] }], { expectedUserId: ME });
  ok(r.accepted === 0, 'a module whose only item is foreign enumerates NOTHING');
  ok(Object.values(r.rejected).reduce((a, b) => a + b, 0) === 1,
     'and the foreign item is still counted');
}

{
  // THE ONE THAT MUST NOT REGRESS: who-to-follow is a module too.
  const r = mod.collectEntries(
    [{ type: 'TimelineAddEntries', entries: [whoToFollowEntry] }], { expectedUserId: ME });
  ok(r.accepted === 0,
     'the who-to-follow module is STILL rejected whole after modules became walkable');
  ok(/who-to-follow/.test(Object.keys(r.rejected).join(' ')),
     'and it is counted under its own prefix');

  // Same module, relabelled as a conversation: the entryId prefix must not be
  // enough on its own to open it up.
  const disguised = JSON.parse(JSON.stringify(whoToFollowEntry));
  disguised.entryId = 'profile-conversation-9003';
  const r2 = mod.collectEntries(
    [{ type: 'TimelineAddEntries', entries: [disguised] }], { expectedUserId: ME });
  ok(r2.accepted === 0,
     'a who-to-follow module renamed to profile-conversation is still not walked ' +
     '(displayType is not VerticalConversation)');
}

{
  // A non-TimelineTweet item inside a conversation module.
  const withStub = conversationModule('profile-conversation-9004', [
    { entryId: 'profile-conversation-9004-tweet-stub', dispensable: false,
      item: { itemContent: { __typename: 'TimelineTimelineCursor', cursorType: 'ShowMore' } } },
    convItem('profile-conversation-9004-tweet-' + MY_REPLY,
             reply(MY_REPLY, ME, FOREIGN_TWEET), false),
  ]);
  const r = mod.collectEntries(
    [{ type: 'TimelineAddEntries', entries: [withStub] }], { expectedUserId: ME });
  ok(r.accepted === 1, 'a non-TimelineTweet item is skipped and the real reply still lands');
  ok(/itemContent is TimelineTimelineCursor/.test(Object.keys(r.rejected).join(' ')),
     'the non-tweet item is rejected and counted by what it actually was');
}

{
  // dispensable is a CROSS-CHECK, never the gate.
  const inverted = conversationModule('profile-conversation-9005', [
    // Mine, but flagged dispensable - the gate must still accept it.
    convItem('profile-conversation-9005-tweet-' + MY_REPLY,
             reply(MY_REPLY, ME, FOREIGN_TWEET), true),
    // Foreign, but NOT flagged dispensable - the gate must still refuse it.
    convItem('profile-conversation-9005-tweet-' + FOREIGN_TWEET,
             reply(FOREIGN_TWEET, STRANGER, MY_REPLY), false),
  ]);
  const r = mod.collectEntries(
    [{ type: 'TimelineAddEntries', entries: [inverted] }], { expectedUserId: ME });

  ok(r.accepted === 1 && r.tweets[0].result.legacy.id_str === MY_REPLY,
     'AUTHORSHIP decides: my item is accepted even when dispensable says otherwise');
  ok(/FOREIGN AUTHOR/.test(Object.keys(r.rejected).join(' ')),
     'and the foreign item is refused even though dispensable said to keep it');
  ok(r.dispensableAnomalies.length === 2,
     'both divergences are recorded as cross-check anomalies, got ' +
     r.dispensableAnomalies.length);
  ok(r.dispensableAnomalies.every((a) => typeof a.mine === 'boolean'),
     'each anomaly records which side it was');
}

{
  // THE HAZARD THE CAPTURE EXPOSED: every author object carries its own
  // tweet_counts, including the foreign ones. The live page held 19 different
  // totals. Reading the account total off an ungated item would hand the
  // completeness check a stranger's denominator.
  const mine = reply(MY_REPLY, ME, FOREIGN_TWEET);
  mine.core = { user_results: { result: { legacy: { screen_name: 'placeholder' },
                                          tweet_counts: { tweets: 2616 } } } };
  const theirs = reply(FOREIGN_TWEET, STRANGER, '7000000000000000000');
  theirs.core = { user_results: { result: { legacy: { screen_name: 'stranger' },
                                            tweet_counts: { tweets: 359228 } } } };

  const m = conversationModule('profile-conversation-9006', [
    convItem('profile-conversation-9006-tweet-' + FOREIGN_TWEET, theirs, true),
    convItem('profile-conversation-9006-tweet-' + MY_REPLY, mine, false),
  ]);
  const r = mod.collectEntries(
    [{ type: 'TimelineAddEntries', entries: [m] }], { expectedUserId: ME });

  ok(r.accepted === 1, 'only my item is accepted out of the mixed-author module');
  const totals = r.tweets.map((t) => mod.accountTotalFromTweet(t.result));
  ok(totals.length === 1 && totals[0] === 2616,
     'the account total comes from MY author object (2616), never the stranger\'s (359228)');
  ok(mod.accountTotalFromTweet(theirs) === 359228,
     "the stranger's own count is readable in isolation - which is exactly why the " +
     'total must only ever be taken from an ACCEPTED entry');
}

/* positional indexing would have found nothing */
ok(mod.collectEntries([instructions[0]], { expectedUserId: ME }).accepted === 0,
   'a TimelineClearCache-only instruction set yields no entries and does not throw');

console.log(fails ? `\nFAILED (${fails})` : `\nALL PASS`);
process.exit(fails ? 1 : 0);
