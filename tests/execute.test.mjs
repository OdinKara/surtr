/**
 * Tests for lib/execute.js - the decisions that destroy data.
 *
 *     node tests/execute.test.mjs
 *
 * Every other test in this repo protects a report. These protect an account.
 * The one that matters most is verb selection: a retweet must be undone via
 * DeleteRetweet against the ORIGINAL post's id, while a post must be deleted
 * via DeleteTweet against its OWN id. Swapping those does not throw - it sends
 * a well-formed request naming the wrong tweet, and for a retweet the wrong
 * tweet belongs to somebody else.
 *
 * Placeholder ids only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const load = async (rel) => import(
  'data:text/javascript;base64,' +
  Buffer.from(fs.readFileSync(path.join(HERE, '..', rel), 'utf8'), 'utf8').toString('base64')
);

const E = await load('lib/execute.js');
const F = await load('lib/filters.js');

let fails = 0;
let passes = 0;
const ok = (c, m) => { console.log((c ? '[OK]  ' : '[X]   ') + m); if (c) passes++; else fails++; };

const MY_POST = '3000000000000000001';
const MY_REPLY = '3000000000000000002';
const MY_RETWEET = '3000000000000000003';
const FOREIGN_ORIGINAL = '5000000000000000001';

const item = (o) => ({
  id: MY_POST, kind: 'post', createdAt: '2024-01-02T03:04:05.000Z', text: 't',
  likeCount: 0, retweetCount: 0, replyCount: 0, quoteCount: 0,
  hasMedia: false, isPinned: false, sourceTweetId: null,
  permalink: 'https://x.com/i/status/' + MY_POST, ...o,
});

/* ---------------------------------------------------- VERB SELECTION --- */

{
  const p = E.planItem(item({ id: MY_POST, kind: 'post' }));
  ok(p.op === 'DeleteTweet' && p.targetId === MY_POST,
     'a post -> DeleteTweet on its OWN id');

  const r = E.planItem(item({ id: MY_REPLY, kind: 'reply' }));
  ok(r.op === 'DeleteTweet' && r.targetId === MY_REPLY,
     'a reply -> DeleteTweet on its OWN id');

  const rt = E.planItem(item({
    id: MY_RETWEET, kind: 'retweet', sourceTweetId: FOREIGN_ORIGINAL }));
  ok(rt.op === 'DeleteRetweet', 'a retweet -> DeleteRetweet');
  ok(rt.targetId === FOREIGN_ORIGINAL,
     'and it targets the ORIGINAL post id, not our copy');
  ok(rt.targetId !== MY_RETWEET,
     'THE CRITICAL ONE: a retweet never targets its own id');
}

{
  // The dangerous shape: a retweet whose source was never captured.
  const rt = E.planItem(item({ id: MY_RETWEET, kind: 'retweet', sourceTweetId: null }));
  ok(rt.skip === true && rt.reason === E.SKIP.RETWEET_WITHOUT_SOURCE,
     'a retweet with NO sourceTweetId is SKIPPED, never fallen back to its own id');

  for (const bad of ['', undefined]) {
    const s = E.planItem(item({ id: MY_RETWEET, kind: 'retweet', sourceTweetId: bad }));
    ok(s.skip === true, 'a retweet with sourceTweetId=' + JSON.stringify(bad) + ' is skipped');
  }

  const junk = E.planItem(item({
    id: MY_RETWEET, kind: 'retweet', sourceTweetId: 'not-an-id' }));
  ok(junk.skip === true && junk.reason === E.SKIP.MALFORMED_ID,
     'a malformed source id is skipped rather than sent');

  const badOwn = E.planItem(item({ id: 'nope', kind: 'post' }));
  ok(badOwn.skip === true && badOwn.reason === E.SKIP.MALFORMED_ID,
     'a malformed own id is skipped rather than sent');

  for (const kind of ['like', 'quote', undefined, null, '']) {
    const u = E.planItem(item({ kind }));
    ok(u.skip === true && u.reason === E.SKIP.UNKNOWN_KIND,
       'an unrecognised kind ' + JSON.stringify(kind) + ' is SKIPPED, never guessed at');
  }
}

ok(E.isPlausibleId('1234567890') && !E.isPlausibleId('12') &&
   !E.isPlausibleId('12a4567890') && !E.isPlausibleId(1234567890),
   'id plausibility rejects short, non-numeric and non-string values');

/* -------------------------------------------- REQUEST VARIABLES --- */

{
  // The 422 that produced this test:
  //   {"errors":[{"code":"GRAPHQL_VALIDATION_FAILED","message":"must be defined",
  //               "path":["variable","source_tweet_id"]}]}
  // Verb selection and target were both correct; a shared builder sent
  // DeleteTweet's key name on a DeleteRetweet request.

  const dt = E.variablesFor('DeleteTweet', MY_POST);
  ok(dt.tweet_id === MY_POST, 'DeleteTweet sends tweet_id');
  ok(dt.dark_request === false, 'DeleteTweet still sends dark_request - proven shape, untouched');
  ok(!('source_tweet_id' in dt), 'DeleteTweet does NOT send source_tweet_id');
  ok(Object.keys(dt).sort().join(',') === 'dark_request,tweet_id',
     'DeleteTweet sends exactly the two keys that are known to work: ' +
     Object.keys(dt).sort().join(','));

  const dr = E.variablesFor('DeleteRetweet', FOREIGN_ORIGINAL);
  ok(dr.source_tweet_id === FOREIGN_ORIGINAL,
     'DeleteRetweet sends source_tweet_id, the key X named in its own error');
  ok(!('tweet_id' in dr),
     'THE BUG: DeleteRetweet must NOT send tweet_id - that inheritance caused the 422');
  ok(Object.keys(dr).join(',') === 'source_tweet_id',
     'DeleteRetweet sends ONLY source_tweet_id - dark_request is not assumed from ' +
     'DeleteTweet, because the bundle could not confirm it and the next 422 will ' +
     'name it if it is needed: ' + Object.keys(dr).join(','));

  // The shapes must not be the same function, or they can drift into each other.
  ok(E.WRITE_VARIABLES.DeleteTweet !== E.WRITE_VARIABLES.DeleteRetweet,
     'the two operations have SEPARATE builders - there is nothing to inherit from');

  const keysA = Object.keys(E.variablesFor('DeleteTweet', '1'));
  const keysB = Object.keys(E.variablesFor('DeleteRetweet', '1'));
  ok(keysA.every((k) => !keysB.includes(k)),
     'and their key sets do not overlap at all');

  // An operation with no shape must not be dispatched with a guessed one.
  let threw = false;
  try { E.variablesFor('SomeNewDeleteOperation', '1'); } catch { threw = true; }
  ok(threw, 'an unknown operation THROWS rather than returning a plausible shape - a ' +
     'write with guessed variables is worse than a write that does not happen');

  threw = false;
  try { E.variablesFor(undefined, '1'); } catch { threw = true; }
  ok(threw, 'and so does a missing operation name');

  // Every operation planItem can emit must have a shape.
  for (const op of Object.values(E.WRITE_OPERATIONS)) {
    ok(typeof E.WRITE_VARIABLES[op] === 'function',
       'every write operation has its own variables shape: ' + op);
  }

  // The target flows through untouched.
  ok(E.variablesFor('DeleteRetweet', '669425844394270721').source_tweet_id ===
     '669425844394270721', 'the target id is passed through verbatim');
}

/* ------------------------------------------- VETOES AT DISPATCH TIME --- */

{
  const items = [
    item({ id: MY_POST }),
    item({ id: MY_REPLY, kind: 'reply' }),
    item({ id: MY_RETWEET, kind: 'retweet', sourceTweetId: FOREIGN_ORIGINAL }),
  ];

  const all = E.buildPlan({ items, config: F.defaultConfig(), evaluate: F.evaluate });
  ok(all.dispatch.length === 3 && all.skipped.length === 0, 'a clean plan dispatches all three');

  // The user added a keep-id AFTER the scan. It must be honoured.
  const keep = E.buildPlan({
    items,
    config: { ...F.defaultConfig(), keepIdList: [MY_REPLY] },
    evaluate: F.evaluate,
  });
  ok(keep.dispatch.length === 2, 'a keep-list id added after the scan is not dispatched');
  ok(keep.skipped.some((s) => s.item.id === MY_REPLY && s.reason === E.SKIP.VETOED_KEEP_LIST),
     'and it is reported as vetoed by the keep list, by name');

  // Keeping the ORIGINAL must also keep our retweet of it.
  const keepSource = E.buildPlan({
    items,
    config: { ...F.defaultConfig(), keepIdList: [FOREIGN_ORIGINAL] },
    evaluate: F.evaluate,
  });
  ok(!keepSource.dispatch.some((d) => d.targetId === FOREIGN_ORIGINAL),
     'keeping the original id also stops the DeleteRetweet against it');

  const pinned = E.buildPlan({
    items: [item({ id: MY_POST, isPinned: true })],
    config: F.defaultConfig(),
    evaluate: F.evaluate,
  });
  ok(pinned.dispatch.length === 0 &&
     pinned.skipped[0].reason === E.SKIP.VETOED_PINNED,
     'the pinned veto is re-applied at dispatch time');

  // An item that no longer matches the current filters.
  const narrowed = E.buildPlan({
    items,
    config: { ...F.defaultConfig(), includeKinds: ['retweet'] },
    evaluate: F.evaluate,
  });
  ok(narrowed.dispatch.length === 1 && narrowed.dispatch[0].op === 'DeleteRetweet',
     'only items matching the CURRENT filters are dispatched');
  ok(narrowed.skipped.filter((s) => s.reason === E.SKIP.NO_LONGER_MATCHED).length === 2,
     'the rest are reported as no-longer-matched rather than silently dropped');
}

/* -------------------------------------------------------- ARM GATE --- */

{
  const base = {
    armed: true, dryRun: false, confirmCount: 5, expectedCount: 5,
    scanStatus: 'done', scanSessionId: 'S1', currentSessionId: 'S1',
    configFingerprint: 'FP', scanConfigFingerprint: 'FP',
    testMode: true, testVerified: false,
  };
  ok(E.checkArmed(base).ok === true, 'a fully satisfied gate opens');

  const refuse = (over, needle, label) => {
    const r = E.checkArmed({ ...base, ...over });
    ok(r.ok === false && r.refusals.join(' ').includes(needle), label);
  };

  refuse({ dryRun: true }, 'dry-run', 'dry-run refuses');
  refuse({ dryRun: undefined }, 'dry-run', 'dry-run must be EXPLICITLY false, not merely absent');
  refuse({ armed: false }, 'not armed', 'unarmed refuses');
  refuse({ armed: 'yes' }, 'not armed', 'armed must be exactly true, not truthy');
  refuse({ scanStatus: 'running' }, 'no completed scan', 'a running scan refuses');
  refuse({ scanStatus: null }, 'no completed scan', 'no scan refuses');
  refuse({ scanSessionId: 'OTHER' }, 'not completed in this session',
          'a scan from another session refuses');
  refuse({ scanSessionId: null }, 'not completed in this session',
          'a scan with no session refuses');
  refuse({ scanConfigFingerprint: 'DIFFERENT' }, 'filters changed',
          'filters changed since the scan refuses');
  refuse({ confirmCount: 4 }, 'does not equal', 'a wrong confirmation count refuses');
  refuse({ confirmCount: 6 }, 'does not equal', 'a higher confirmation count also refuses');
  refuse({ expectedCount: 0, confirmCount: 0 }, 'nothing to act on', 'an empty set refuses');
  refuse({ testMode: false }, 'test run has not been verified',
          'a FULL run refuses until the 5-item test is verified');

  const full = E.checkArmed({ ...base, testMode: false, testVerified: true });
  ok(full.ok === true, 'a full run opens once the test has been attested');

  const many = E.checkArmed({ ...base, dryRun: true, armed: false, confirmCount: 1 });
  ok(many.refusals.length >= 3, 'every failing condition is reported, not just the first');
}

ok(E.configFingerprint({ includeKinds: ['a', 'b'], keepIdList: ['2', '1'] }) ===
   E.configFingerprint({ keepIdList: ['1', '2'], includeKinds: ['b', 'a'] }),
   'the config fingerprint ignores key and array order');
ok(E.configFingerprint({ maxLikes: 5 }) !== E.configFingerprint({ maxLikes: 6 }),
   'but it changes when a filter value changes');
ok(E.configFingerprint({ keepIdList: ['1'] }) !== E.configFingerprint({ keepIdList: [] }),
   'and when the keep list changes');

/* ------------------------------------------------ TEST-RUN SELECTION --- */

{
  const mk = (id, eng, date) => item({
    id: '30000000000000000' + id, likeCount: eng, createdAt: date });
  const pool = [
    mk('01', 100, '2020-01-01T00:00:00.000Z'),
    mk('02', 0, '2024-01-01T00:00:00.000Z'),
    mk('03', 0, '2019-01-01T00:00:00.000Z'),
    mk('04', 1, '2018-01-01T00:00:00.000Z'),
    mk('05', 0, '2021-01-01T00:00:00.000Z'),
    mk('06', 0, '2017-01-01T00:00:00.000Z'),
    mk('07', 50, '2016-01-01T00:00:00.000Z'),
  ];
  const picked = E.selectTestItems(pool);
  ok(picked.length === 5, 'the test run picks exactly 5');
  ok(picked.every((p) => E.engagementOf(p) <= 1),
     'it picks the LOWEST-engagement items, not merely the oldest');
  ok(!picked.some((p) => p.id.endsWith('01') || p.id.endsWith('07')),
     'the high-engagement items are not selected even though one is the oldest');
  const zeros = picked.filter((p) => E.engagementOf(p) === 0).map((p) => p.createdAt);
  ok(zeros[0] < zeros[1] && zeros[1] < zeros[2],
     'within equal engagement the OLDEST come first');

  ok(E.selectTestItems(pool.slice(0, 2)).length === 2,
     'a pool smaller than 5 yields what there is');
  ok(E.selectTestItems([]).length === 0, 'an empty pool yields nothing');

  const undated = E.selectTestItems([mk('08', 0, 'nonsense'), mk('09', 0, '2015-01-01')]);
  ok(undated[0].id.endsWith('09'),
     'an unparseable date sorts LAST - missing data is not evidence of age');
}

/* ------------------------------------------------- OUTCOME GRADING --- */

{
  const c = (status, body) => E.classifyOutcome({ status, body });

  ok(c(200, { data: {} }).outcome === E.OUTCOME.UNVERIFIED,
     'a bare 200 is UNVERIFIED, not succeeded - the success shape is not confirmed yet');
  ok(/not been confirmed/.test(c(200, {}).detail),
     'and it says why in the detail');

  ok(c(401, {}).outcome === E.OUTCOME.FAILED && c(401, {}).fatal === true,
     '401 is a fatal failure');
  ok(c(403, {}).fatal === true, '403 is a fatal failure');
  ok(c(429, {}).retryable === true, '429 is retryable, not a permanent failure');
  ok(c(500, {}).outcome === E.OUTCOME.FAILED, 'a 5xx is a failure');

  ok(c(200, { errors: [{ message: 'Something broke' }] }).outcome === E.OUTCOME.FAILED,
     'a 200 carrying a GraphQL errors array is a FAILURE, not a success');
  ok(c(200, { errors: [{ message: 'No status found with that ID.' }] }).outcome ===
     E.OUTCOME.ALREADY_GONE,
     'an already-deleted tweet is ALREADY-GONE - benign, but not something we did');

  // Once the shape is confirmed from a live response it can be applied.
  const shape = (b) => Boolean(b && b.data && b.data.delete_tweet);
  ok(E.classifyOutcome({ status: 200, body: { data: { delete_tweet: {} } },
                         confirmedSuccessShape: shape }).outcome === E.OUTCOME.SUCCEEDED,
     'with a confirmed shape, a matching 200 is a success');
  ok(E.classifyOutcome({ status: 200, body: { data: {} },
                         confirmedSuccessShape: shape }).outcome === E.OUTCOME.FAILED,
     'and a 200 that does NOT match the confirmed shape is a failure, not a success');
}

{
  const counts = E.tally([
    { outcome: E.OUTCOME.SUCCEEDED }, { outcome: E.OUTCOME.SUCCEEDED },
    { outcome: E.OUTCOME.UNVERIFIED },
    { outcome: E.OUTCOME.ALREADY_GONE },
    { outcome: E.OUTCOME.FAILED },
    { outcome: E.OUTCOME.SKIPPED },
    { outcome: 'attempted' },
  ]);
  ok(counts.succeeded === 2 && counts.unverified === 1 && counts.alreadyGone === 1 &&
     counts.failed === 1 && counts.skipped === 1 && counts.attempted === 1,
     'every outcome is counted in its own category');

  const s = E.outcomeSummary(counts);
  ok(/2 deleted/.test(s), 'the summary states only the confirmed deletions as deleted');
  ok(/1 sent, outcome UNVERIFIED/.test(s), 'unverified items are named as unverified');
  ok(/1 ATTEMPTED, outcome unknown/.test(s),
     'an unresolved attempt is reported as unknown, not folded into success or failure');
  ok(!/7 deleted|4 deleted/.test(s),
     'no total is stated that would imply more was deleted than was');
  ok(E.outcomeSummary(E.tally([])) === 'nothing dispatched', 'an empty run says so plainly');
}

/* ------------------------------------ CONFIRMED SUCCESS SHAPES --- */

{
  // DeleteTweet, from the 5-item live run. Nothing to verify against: the
  // response returns an EMPTY tweet_results because the tweet is gone.
  const LIVE = { data: { delete_tweet: { tweet_results: {} } } };

  ok(E.classifyOutcome({ status: 200, body: LIVE, operationName: 'DeleteTweet' })
       .outcome === E.OUTCOME.SUCCEEDED,
     'the confirmed DeleteTweet body grades as SUCCEEDED');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet(LIVE).ok === true, 'the shape matches');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet(
       { data: { delete_tweet: { tweet_results: {}, extra: 1 } } }).ok === true,
     'extra fields do not break the match');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet({ data: { delete_tweet: {} } }).ok === true,
     'an absent tweet_results still matches - nothing inside it is required');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet({ data: {} }).ok === false,
     'a 200 without delete_tweet does NOT match');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet({ data: { delete_tweet: null } }).ok === false,
     'a null delete_tweet does not match');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet(
       { data: { delete_tweet: {} }, errors: [] }).ok === false,
     'an errors key present at all disqualifies, even when empty');

  ok(E.classifyOutcome({ status: 200, body: { data: {} }, operationName: 'DeleteTweet' })
       .outcome === E.OUTCOME.FAILED,
     'a 200 that does not match the confirmed shape is a FAILURE, not unverified');
  ok(E.classifyOutcome({
       status: 200, body: { errors: [{ message: 'No status found with that ID.' }] },
       operationName: 'DeleteTweet' }).outcome === E.OUTCOME.ALREADY_GONE,
     'already-gone still wins over the shape check');
}

{
  // DeleteRetweet, from 10 identical live responses. The response key is
  // `unretweet`, NOT `delete_retweet` - not derivable from the operation name.
  const SRC = '669425844394270721';
  const live = (id = SRC) =>
    ({ data: { unretweet: { source_tweet_results: { result: { rest_id: id } } } } });

  const good = E.classifyOutcome({
    status: 200, body: live(), operationName: 'DeleteRetweet', targetId: SRC });
  ok(good.outcome === E.OUTCOME.SUCCEEDED,
     'the confirmed DeleteRetweet body grades as SUCCEEDED when the echoed id matches');

  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteRetweet(live(), { targetId: SRC }).ok === true,
     'the shape matches on the echoed id');
  // A tweet id CANNOT survive Number(): 669425844394270721 is past 2^53 and
  // becomes ...700. The comparison is string-based and correctly rejects it,
  // which is the behaviour we want - a silently mangled id must never verify.
  // planItem() always produces a String, so this is a guard, not a live path.
  ok(String(Number(SRC)) !== SRC, 'a tweet id does not survive Number() - it loses precision');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteRetweet(live(), { targetId: Number(SRC) }).ok === false,
     'a numerically-mangled target does NOT verify - a mangled id must never pass');

  // THE ONE THAT MATTERS. A response about a different tweet is a FAILURE.
  const wrong = E.classifyOutcome({
    status: 200, body: live('1111111111111111111'),
    operationName: 'DeleteRetweet', targetId: SRC });
  ok(wrong.outcome === E.OUTCOME.FAILED,
     'ECHOED ID MISMATCH is a FAILURE, never a success - the single worst thing this ' +
     'tool could quietly accept');
  ok(wrong.mismatch === true, 'and it is flagged as a mismatch so it can be logged loudly');
  ok(/669425844394270721/.test(wrong.detail) && /1111111111111111111/.test(wrong.detail),
     'and the detail names BOTH ids: ' + wrong.detail.slice(0, 110));

  // The strictness is real: shapes that would pass a laxer check must not pass.
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteRetweet(
       { data: { unretweet: {} } }, { targetId: SRC }).ok === false,
     'data.unretweet with no echoed id does not match - there is nothing to verify');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteRetweet({ data: {} }, { targetId: SRC }).ok === false,
     'a 200 without data.unretweet does not match');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteRetweet(
       { data: { delete_retweet: { source_tweet_results: { result: { rest_id: SRC } } } } },
       { targetId: SRC }).ok === false,
     'the key is `unretweet` - a `delete_retweet` key does NOT match, because the ' +
     'response key was read off a live body and never inferred from the operation name');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteRetweet(
       { ...live(), errors: [] }, { targetId: SRC }).ok === false,
     'an errors key disqualifies here too');

  // The asymmetry between the two shapes is deliberate.
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet(
       { data: { delete_tweet: {} } }, { targetId: 'anything' }).ok === true,
     'DeleteTweet is NOT made stricter to match - its response has nothing to verify ' +
     'against, and inventing a check against an always-empty field would be theatre');

  ok(E.unconfirmedOperations().length === 0,
     'both write operations now have confirmed shapes: ' +
     JSON.stringify(E.unconfirmedOperations()));
}

{
  // A mismatch aborts the run at once rather than counting toward a streak.
  const b = E.createBreaker();
  E.recordOutcome(b, {
    outcome: E.OUTCOME.FAILED, status: 200, body: { data: { unretweet: {} } },
    mismatch: true, targetId: '1', op: 'DeleteRetweet',
  });
  ok(b.tripped === true && b.immediate === true,
     'an ECHOED ID MISMATCH aborts immediately - continuing would dispatch every ' +
     'remaining write on a broken assumption');
  ok(/ECHOED ID MISMATCH/.test(b.reason), 'and says so: ' + b.reason.slice(0, 60));
}

/* --------------------------------------- ONE TARGET, ONE WRITE --- */

{
  // Two distinct items resolving to the SAME delete target must produce one
  // write, not two. Results are deduplicated by item id, but two retweet
  // entries could in principle carry the same sourceTweetId.
  const items = [
    item({ id: '3000000000000000011', kind: 'retweet', sourceTweetId: FOREIGN_ORIGINAL }),
    item({ id: '3000000000000000012', kind: 'retweet', sourceTweetId: FOREIGN_ORIGINAL }),
  ];
  const plan = E.buildPlan({ items, config: F.defaultConfig(), evaluate: F.evaluate });
  ok(plan.dispatch.length === 1,
     'the same delete target is dispatched ONCE even from two different items');
  ok(plan.skipped.length === 1 && plan.skipped[0].reason === E.SKIP.DUPLICATE_TARGET,
     'and the duplicate is reported rather than silently dropped');

  // Different targets are untouched by the dedupe.
  const two = E.buildPlan({
    items: [item({ id: MY_POST }), item({ id: MY_REPLY, kind: 'reply' })],
    config: F.defaultConfig(), evaluate: F.evaluate,
  });
  ok(two.dispatch.length === 2, 'distinct targets are both dispatched');
}

/* --------------------------------- A 429 IS NEVER A FAILURE --- */

const fail = (b = { errors: [{ message: 'boom' }] }, status = 500) =>
  ({ outcome: E.OUTCOME.FAILED, status, body: b, targetId: '1', op: 'DeleteTweet' });
const win = () => ({ outcome: E.OUTCOME.SUCCEEDED, status: 200, body: { data: {} } });

{
  // The defect: two items were graded "failed" on a 429 and burned, while still
  // live on the account. The backoff ran; the retry never did. Same value, two
  // code paths - the breaker treated 429 as neutral, the classifier did not.
  const v = E.classifyOutcome({ status: 429, body: null, operationName: 'DeleteTweet' });

  ok(v.outcome !== E.OUTCOME.FAILED,
     'a 429 is NOT graded as failed - it means try again later');
  ok(v.outcome === E.OUTCOME.DEFERRED,
     'it is DEFERRED: not attempted successfully, and the item still exists');
  ok(v.retryable === true, 'and it is marked retryable so the caller re-dispatches');
  ok(/still exists/.test(v.detail),
     'the detail says the item still exists rather than reading as an error');

  ok(E.shouldRetry({ outcome: E.OUTCOME.DEFERRED, retryable: true, attempt: 1 }) === true,
     'attempt 1 of a rate-limited item RETRIES rather than terminating');
  ok(E.shouldRetry({ outcome: E.OUTCOME.DEFERRED, retryable: true, attempt: 2 }) === true,
     'attempt 2 retries');
  ok(E.shouldRetry({ outcome: E.OUTCOME.DEFERRED, retryable: true, attempt: 3 }) === false,
     'attempt 3 is the last - retries are bounded, not infinite');
  ok(E.MAX_WRITE_ATTEMPTS === 3, 'the bound is 3 attempts');

  ok(E.shouldRetry({ outcome: E.OUTCOME.FAILED, retryable: false, attempt: 1 }) === false,
     'a real failure is NOT retried - only a rate limit is');
  ok(E.shouldRetry({ outcome: E.OUTCOME.SUCCEEDED, retryable: false, attempt: 1 }) === false,
     'a success is not retried');
  ok(E.shouldRetry({ outcome: E.OUTCOME.ALREADY_GONE, retryable: false, attempt: 1 }) === false,
     'already-gone is not retried');
}

{
  const counts = E.tally([
    { outcome: E.OUTCOME.SUCCEEDED }, { outcome: E.OUTCOME.SUCCEEDED },
    { outcome: E.OUTCOME.DEFERRED }, { outcome: E.OUTCOME.DEFERRED },
    { outcome: E.OUTCOME.FAILED },
  ]);
  ok(counts.deferred === 2, 'deferred items are counted in their own category');
  ok(counts.failed === 1, 'and are NOT added to the failed count');
  ok(counts.succeeded === 2, 'nor to the deleted count');

  const s = E.outcomeSummary(counts);
  ok(/2 DEFERRED/.test(s), 'the summary names them');
  ok(/still exist/.test(s), 'and says they still exist');
  ok(/re-scan/.test(s), 'and that a re-scan will find them');
  ok(/1 failed/.test(s) && !/3 failed/.test(s),
     'the failed count does not absorb the deferred ones');
}

/* ------------------------------------------ CIRCUIT BREAKER --- */

{
  // 5 consecutive failures aborts.
  const b = E.createBreaker();
  for (let i = 1; i <= 4; i += 1) {
    E.recordOutcome(b, fail());
    ok(b.tripped === false, 'failure ' + i + ' of 5 does not trip yet');
  }
  E.recordOutcome(b, fail());
  ok(b.tripped === true, 'the FIFTH consecutive failure trips the breaker');
  ok(/5 consecutive failures/.test(b.reason), 'and says why');
  ok(b.immediate === false, 'it is a streak abort, not an immediate one');
  ok(b.failures.length === 5, 'the raw failure bodies are retained for the report');

  const before = b.consecutive;
  E.recordOutcome(b, win());
  ok(b.tripped === true && b.consecutive === before,
     'a tripped breaker is not un-tripped by a later success');
}

{
  // 4 failures, a success, 4 more: NOT an abort.
  const b = E.createBreaker();
  for (let i = 0; i < 4; i += 1) E.recordOutcome(b, fail());
  ok(b.consecutive === 4, 'four failures counted');
  E.recordOutcome(b, win());
  ok(b.consecutive === 0 && b.tripped === false, 'a SUCCESS resets the counter');
  for (let i = 0; i < 4; i += 1) E.recordOutcome(b, fail());
  ok(b.tripped === false,
     '4 failures, a success, then 4 more does NOT abort');

  const b2 = E.createBreaker();
  for (let i = 0; i < 4; i += 1) E.recordOutcome(b2, fail());
  E.recordOutcome(b2, { outcome: E.OUTCOME.ALREADY_GONE, status: 200, body: {} });
  ok(b2.consecutive === 0, 'ALREADY-GONE resets the counter too');
}

{
  // A single validation error aborts immediately.
  const b = E.createBreaker();
  E.recordOutcome(b, fail({
    errors: [{ code: 'GRAPHQL_VALIDATION_FAILED',
               extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
               message: 'must be defined', path: ['variable', 'source_tweet_id'] }],
  }, 422));
  ok(b.tripped === true && b.immediate === true,
     'ONE GRAPHQL_VALIDATION_FAILED aborts immediately');
  ok(b.consecutive === 1, 'after a single failure, not five');
  ok(/retrying cannot fix/.test(b.reason),
     'the reason explains that retrying cannot fix a wrong request shape');

  const b2 = E.createBreaker();
  E.recordOutcome(b2, fail({ errors: [{ extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] },
                            422));
  ok(b2.tripped === true, 'the code is found in extensions as well as at the top level');

  for (const status of [400, 404, 409, 422]) {
    const bn = E.createBreaker();
    E.recordOutcome(bn, fail({ errors: [{ message: 'nope' }] }, status));
    ok(bn.tripped === true && bn.immediate === true,
       'a single HTTP ' + status + ' aborts immediately - refused, not deferred');
  }

  const b5 = E.createBreaker();
  E.recordOutcome(b5, fail({ errors: [{ message: 'oops' }] }, 503));
  ok(b5.tripped === false && b5.consecutive === 1,
     'a 5xx counts toward the streak rather than aborting on its own');
}

{
  // 429 does not count toward the breaker at all.
  const b = E.createBreaker();
  for (let i = 0; i < 20; i += 1) {
    E.recordOutcome(b, { outcome: E.OUTCOME.FAILED, status: 429, body: null,
                         targetId: '1', op: 'DeleteTweet' });
  }
  ok(b.tripped === false && b.consecutive === 0,
     'TWENTY 429s do not trip the breaker - a rate limit is a "later", not a "no"');
  ok(b.failures.length === 0, 'and they are not recorded as failures');

  const b2 = E.createBreaker();
  for (let i = 0; i < 4; i += 1) E.recordOutcome(b2, fail());
  E.recordOutcome(b2, { outcome: E.OUTCOME.FAILED, status: 429, body: null });
  ok(b2.consecutive === 4,
     'a 429 mid-streak neither counts nor RESETS - it cannot launder a failure streak');
  E.recordOutcome(b2, fail());
  ok(b2.tripped === true, 'so the next real failure still trips it');

  // And the same holds for the DEFERRED grade a 429 now produces.
  const b3 = E.createBreaker();
  for (let i = 0; i < 4; i += 1) E.recordOutcome(b3, fail());
  E.recordOutcome(b3, {
    outcome: E.OUTCOME.DEFERRED, status: 429, body: null, targetId: '1', op: 'DeleteTweet' });
  ok(b3.consecutive === 4 && b3.tripped === false,
     'a DEFERRED item is neutral for the breaker, exactly as the raw 429 is');
}

{
  const b = E.createBreaker();
  for (let i = 0; i < 4; i += 1) E.recordOutcome(b, fail());
  E.recordOutcome(b, { outcome: E.OUTCOME.UNVERIFIED, status: 200, body: {} });
  ok(b.consecutive === 4,
     'UNVERIFIED does not reset the streak - it is not evidence of success');
  ok(b.tripped === false, 'and does not count toward it either');
}

{
  // An echoed-id mismatch aborts at once.
  const b = E.createBreaker();
  E.recordOutcome(b, {
    outcome: E.OUTCOME.FAILED, status: 200, body: { data: { unretweet: {} } },
    mismatch: true, targetId: '1', op: 'DeleteRetweet',
  });
  ok(b.tripped === true && b.immediate === true,
     'an ECHOED ID MISMATCH aborts immediately');
  ok(/ECHOED ID MISMATCH/.test(b.reason), 'and says so');
}

{
  // An aborted run never reports as complete.
  ok(E.runStatusFor({ abortedByBreaker: true }) === 'aborted',
     'a breaker abort produces status "aborted"');
  ok(E.runStatusFor({ abortedByBreaker: true, fatal: true, stopped: true }) === 'aborted',
     'and it wins over every other status');
  ok(E.runStatusFor({ fatal: true }) === 'error', 'a fatal error is still an error');
  ok(E.runStatusFor({ stopped: true }) === 'stopped', 'a user stop is still stopped');
  ok(E.runStatusFor({}) === 'done', 'an untroubled run is done');

  ok(E.runIsComplete('done') === true, 'only "done" counts as complete');
  for (const s of ['aborted', 'error', 'stopped', 'running', null]) {
    ok(E.runIsComplete(s) === false, JSON.stringify(s) + ' is NOT complete');
  }

  const b = E.createBreaker();
  for (let i = 0; i < 5; i += 1) E.recordOutcome(b, fail());
  const report = E.breakerReport(b, { succeeded: 3, failed: 5, alreadyGone: 0, unverified: 0 }, 8);
  ok(/RUN ABORTED BY THE CIRCUIT BREAKER/.test(report), 'the report leads with the abort');
  ok(/8 dispatched/.test(report) && /3 succeeded/.test(report),
     'it states how many were dispatched and how they turned out');
  ok(/were NOT dispatched/.test(report), 'it says the remaining items were not attempted');
  ok(/not complete and must not be read as one/.test(report),
     'and it refuses to be read as a completed run');
  ok(E.breakerReport(E.createBreaker(), {}, 0) === null,
     'an untripped breaker produces no abort report');
}

/* ------------------------------------ NO AUTOMATIC DOWNLOADS --- */

// The kill-log auto-download was REMOVED, not gated. There is no decision left
// to make: the only way the log reaches disk is a button the user clicks. This
// assertion exists so that re-introducing one fails a test rather than passing
// review.
ok(!('shouldOfferKillLog' in E) && !('recordOffered' in E),
   'the auto-offer helpers are DELETED, not merely unused - there is no flag left ' +
   'that could re-enable an automatic write of deleted-post text to disk');

/* ------------------------------------------- RAW BODY RETENTION --- */

{
  // Position alone was the wrong criterion: it keeps the responses you already
  // understand and drops the one that matters.
  ok(E.shouldRetainRaw({ outcome: E.OUTCOME.SUCCEEDED, indexInRun: 0 }) === true,
     'the first successes are kept, for shape confirmation');
  ok(E.shouldRetainRaw({ outcome: E.OUTCOME.SUCCEEDED, indexInRun: 2 }) === true,
     'up to the head count');
  ok(E.shouldRetainRaw({ outcome: E.OUTCOME.SUCCEEDED, indexInRun: 3 }) === false,
     'later SUCCESSES are dropped - a confirmed success shape is already known');

  for (const outcome of [E.OUTCOME.FAILED, E.OUTCOME.UNVERIFIED,
                         E.OUTCOME.ALREADY_GONE, 'attempted']) {
    ok(E.shouldRetainRaw({ outcome, indexInRun: 299 }) === true,
       'a ' + outcome + ' body is retained at ANY position - item 300 failing ' +
       'unexpectedly is exactly when the raw body is the whole diagnosis');
  }
}

{
  const short = 'x'.repeat(100);
  ok(E.truncateRaw(short) === short, 'a short body is kept whole');

  const huge = 'y'.repeat(E.RAW_MAX + 5000);
  const cut = E.truncateRaw(huge);
  ok(cut.length < huge.length, 'an enormous body is capped so the log cannot blow up');
  ok(cut.length <= E.RAW_MAX + 60, 'the cap is honoured, got ' + cut.length);
  ok(/truncated 5000 more characters/.test(cut),
     'and the truncation is marked, so a cut body is never mistaken for the whole one');
  ok(E.truncateRaw(null) === '', 'a missing body truncates to empty rather than "null"');
}

/* ------------------------------------------------------- SUMMARY --- */

{
  const s = E.summarise([
    item({ id: MY_POST, kind: 'post', createdAt: '2020-05-05T00:00:00.000Z' }),
    item({ id: MY_REPLY, kind: 'reply', createdAt: '2018-01-01T00:00:00.000Z' }),
    item({ id: MY_RETWEET, kind: 'retweet', createdAt: '2023-09-09T00:00:00.000Z' }),
  ]);
  ok(s.total === 3, 'the summary counts the set');
  ok(s.byKind.post === 1 && s.byKind.reply === 1 && s.byKind.retweet === 1,
     'and breaks it down by kind');
  ok(s.oldest === '2018-01-01T00:00:00.000Z' && s.newest === '2023-09-09T00:00:00.000Z',
     'and reports the oldest and newest dates for the confirmation screen');
}


/* ------------------------------------------------------- coverage floor --- */

/**
 * MINIMUM ASSERTION COUNT.
 *
 * An edit to the execute suite once deleted ~50 assertions - an entire section -
 * and it still printed ALL PASS, because fewer passing tests is
 * indistinguishable from all tests passing. A green signal that means less than
 * it appears is the exact failure class this project keeps meeting.
 *
 * Raise this when adding tests. If it fails after a refactor, tests were lost.
 */
const MIN_ASSERTIONS = 187;
ok(passes + 1 >= MIN_ASSERTIONS,
   'assertion count ' + (passes + 1) + ' is at or above the floor of ' + MIN_ASSERTIONS +
   ' - if this fails, tests were deleted rather than fixed');

console.log(fails ? `\nFAILED (${fails})` : `\nALL PASS`);
process.exit(fails ? 1 : 0);
