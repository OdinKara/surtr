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
const ok = (c, m) => { console.log((c ? '[OK]  ' : '[X]   ') + m); if (!c) fails++; };

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

/* ------------------------------------ CONFIRMED SUCCESS SHAPE --- */

{
  // The exact body observed on all three captured responses of the 5-item run.
  const LIVE = { data: { delete_tweet: { tweet_results: {} } } };

  const v = E.classifyOutcome({ status: 200, body: LIVE, operationName: 'DeleteTweet' });
  ok(v.outcome === E.OUTCOME.SUCCEEDED,
     'the confirmed DeleteTweet body grades as SUCCEEDED, not unverified');

  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet(LIVE) === true,
     'the shape matches the live body');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet(
       { data: { delete_tweet: { tweet_results: {}, extra: 1 } } }) === true,
     'extra fields do not break the match');

  // tweet_results is EMPTY on purpose - the tweet no longer exists to be
  // returned. Requiring anything inside it would report a correct deletion as
  // a failure.
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet({ data: { delete_tweet: {} } }) === true,
     'an absent tweet_results still matches - nothing inside it is required');

  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet({ data: {} }) === false,
     'a 200 without delete_tweet does NOT match');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet({ data: { delete_tweet: null } }) === false,
     'a null delete_tweet does not match');
  ok(E.CONFIRMED_SUCCESS_SHAPES.DeleteTweet(
       { data: { delete_tweet: {} }, errors: [] }) === false,
     'an errors key present at all disqualifies, even when empty');

  const nope = E.classifyOutcome({
    status: 200, body: { data: {} }, operationName: 'DeleteTweet' });
  ok(nope.outcome === E.OUTCOME.FAILED,
     'a 200 that does not match the confirmed shape is a FAILURE, not unverified - ' +
     'the shape is known now, so silence is not ambiguity');

  // Errors still take precedence over the shape check.
  const gone = E.classifyOutcome({
    status: 200, body: { errors: [{ message: 'No status found with that ID.' }] },
    operationName: 'DeleteTweet' });
  ok(gone.outcome === E.OUTCOME.ALREADY_GONE,
     'already-gone still wins over the shape check');
}

{
  // DeleteRetweet is NOT confirmed and must not inherit DeleteTweet's shape.
  const v = E.classifyOutcome({
    status: 200,
    body: { data: { unretweet: { source_tweet_results: {} } } },
    operationName: 'DeleteRetweet',
  });
  ok(v.outcome === E.OUTCOME.UNVERIFIED,
     'DeleteRetweet stays UNVERIFIED - no live response has been seen for it');
  ok(/DeleteRetweet/.test(v.detail), 'and the detail names the operation');

  const asIfTweet = E.classifyOutcome({
    status: 200, body: { data: { delete_tweet: {} } }, operationName: 'DeleteRetweet' });
  ok(asIfTweet.outcome === E.OUTCOME.UNVERIFIED,
     'knowledge about DeleteTweet does not leak into a claim about DeleteRetweet');

  ok(E.unconfirmedOperations().join(',') === 'DeleteRetweet',
     'unconfirmedOperations() names exactly what is still unknown: ' +
     E.unconfirmedOperations().join(','));
  ok(!E.CONFIRMED_SUCCESS_SHAPES.DeleteRetweet,
     'there is no DeleteRetweet entry to accidentally match against');
}

/* --------------------------------------- KILL LOG AUTO-OFFER --- */

{
  // The bug: five kill-log files landed in Downloads from OPENING the panel,
  // after a single run. Every one contained the full text of deleted posts.
  // A persisted condition was being read as an event.
  const base = {
    status: 'done', runId: 'run-1',
    dispatchedThisSession: true, alreadyOffered: false,
  };

  ok(E.shouldOfferKillLog(base) === true,
     'a run that finished in THIS session, not yet offered, is offered once');

  ok(E.shouldOfferKillLog({ ...base, dispatchedThisSession: false }) === false,
     'REHYDRATE DOES NOT OFFER: a completed run this session did not dispatch is not ' +
     'a run that just completed');

  ok(E.shouldOfferKillLog({ ...base, alreadyOffered: true }) === false,
     'a run already offered is never offered again - the record is persisted, so a ' +
     'reload cannot resurrect it');

  ok(E.shouldOfferKillLog({ ...base, dispatchedThisSession: false, alreadyOffered: true })
     === false, 'both guards together still refuse');

  ok(E.shouldOfferKillLog({ ...base, status: 'running' }) === false,
     'a run still in progress is not offered');
  ok(E.shouldOfferKillLog({ ...base, status: null }) === false,
     'a run with no status is not offered');
  ok(E.shouldOfferKillLog({ ...base, runId: null }) === false,
     'no runId, no offer');

  for (const status of ['done', 'stopped', 'error']) {
    ok(E.shouldOfferKillLog({ ...base, status }) === true,
       'a ' + status + ' run is offered - a crashed run needs its log MOST');
  }
}

{
  // The persisted record.
  ok(JSON.stringify(E.recordOffered([], 'run-1')) === '["run-1"]',
     'the first offer is recorded');
  ok(JSON.stringify(E.recordOffered(['run-1'], 'run-2')) === '["run-1","run-2"]',
     'a second run is appended without losing the first');
  ok(JSON.stringify(E.recordOffered(['run-1'], 'run-1')) === '["run-1"]',
     'recording the same run twice does not duplicate it');
  ok(JSON.stringify(E.recordOffered(null, 'run-1')) === '["run-1"]',
     'a missing record starts cleanly rather than throwing');
  ok(E.recordOffered(['x'], null).length === 1, 'a null runId records nothing');

  const many = Array.from({ length: 300 }, (_, i) => 'r' + i);
  const capped = E.recordOffered(many, 'r-new');
  ok(capped.length === 200 && capped[capped.length - 1] === 'r-new',
     'the record is bounded but always keeps the newest');

  // The round trip that matters: offered, reloaded, still not re-offered.
  const persisted = E.recordOffered([], 'run-7');
  ok(E.shouldOfferKillLog({
    status: 'done', runId: 'run-7',
    dispatchedThisSession: true,          // even if it HAD been dispatched here
    alreadyOffered: persisted.includes('run-7'),
  }) === false, 'THE ONE-SHOT SURVIVES A RELOAD: a persisted offer suppresses the next one');
}

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

console.log(fails ? `\nFAILED (${fails})` : `\nALL PASS`);
process.exit(fails ? 1 : 0);
