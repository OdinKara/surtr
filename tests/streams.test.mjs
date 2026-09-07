/**
 * Tests for lib/streams.js - the two-stream planning and merge logic.
 *
 *     node tests/streams.test.mjs
 *
 * Loaded through a data: URL for the same reason as the parser tests: a plain
 * `.js` file imports as ESM without a package.json that would look like the
 * start of a toolchain this project does not have.
 *
 * The assertion that matters most here is the CROSS-STREAM DUPLICATE COUNTER.
 * UserOriginalsTimeline and UserRepostsTimeline are tab-scoped and should be
 * disjoint - a post cannot be a repost. If the same id arrives from both, our
 * model of X's operations is wrong. The merge dedupes (correctness first) but
 * must never do so silently, because a silent dedupe would hide exactly the
 * evidence that something needs looking at.
 *
 * All ids are placeholders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, '..', 'lib', 'streams.js'), 'utf8');
const S = await import(
  'data:text/javascript;base64,' + Buffer.from(SRC, 'utf8').toString('base64')
);

let fails = 0;
let passes = 0;
const ok = (c, m) => { console.log((c ? '[OK]  ' : '[X]   ') + m); if (c) passes++; else fails++; };

const post = (id, kind = 'post') => ({ id, kind, text: 't' + id });
const TIMELINES = {
  posts: { selected: 'UserOriginalsTimeline', found: ['UserOriginalsTimeline'] },
  reposts: { selected: 'UserRepostsTimeline', found: ['UserRepostsTimeline'] },
  replies: { selected: 'UserRepliesTimeline', found: ['UserRepliesTimeline'] },
};

/* ------------------------------------------------------------- planning --- */

let plan = S.planStreams({ config: { includeKinds: ['post', 'reply', 'retweet'] },
                           timelines: TIMELINES });
ok(plan.length === 3 && plan[0].key === 'posts' && plan[1].key === 'reposts',
   'all streams planned, posts FIRST');
ok(plan.every((s) => s.status === 'pending'), 'both start pending');
ok(plan[0].op === 'UserOriginalsTimeline' && plan[1].op === 'UserRepostsTimeline',
   'each stream carries its own operation name');

plan = S.planStreams({ config: { includeKinds: ['post', 'reply'] }, timelines: TIMELINES });
ok(plan[1].status === 'skipped' && plan[1].endReason === 'skipped-by-filter',
   'reposts is SKIPPED with endReason skipped-by-filter when retweets are excluded');
ok(plan[0].status === 'pending', 'posts still runs when retweets are excluded');

// The skip rule is symmetric, and deliberately so: walking a stream whose every
// entry is about to be filtered out is pure waste of rate budget, whichever
// stream it is. the maintainer approved this for reposts; it falls out of one rule
// rather than a special case, and a skipped stream is equally visible either
// way (banner + streams block).
plan = S.planStreams({ config: { includeKinds: ['retweet'] }, timelines: TIMELINES });
ok(plan[0].status === 'skipped' && plan[0].endReason === 'skipped-by-filter',
   'posts is skipped when ONLY retweets are wanted - the rule is symmetric');
ok(plan[1].status === 'pending', 'reposts still runs when only retweets are wanted');

plan = S.planStreams({ config: { includeKinds: ['reply'] }, timelines: TIMELINES });
ok(plan[0].status === 'pending',
   'posts runs when replies are wanted - UserOriginalsTimeline carries them too');

plan = S.planStreams({ config: { includeKinds: [] }, timelines: TIMELINES });
ok(plan.every((s) => s.status === 'pending'),
   'an empty kind list means no filter, so nothing is skipped');

plan = S.planStreams({
  config: { includeKinds: ['post', 'retweet'] },
  timelines: { posts: { selected: 'UserOriginalsTimeline' }, reposts: { selected: null } },
});
ok(plan[1].status === 'failed' && plan[1].endReason === 'no-operation',
   'an unresolved operation is FAILED/no-operation, not skipped - different problems');
ok(plan[0].status === 'pending' && plan[0].op === 'UserOriginalsTimeline',
   'one stream failing to resolve does not stop the other');

/* --------------------------------------------------- the replies stream --- */

plan = S.planStreams({ config: { includeKinds: ['post', 'reply', 'retweet'] },
                       timelines: TIMELINES });
ok(plan.length === 3 && plan.map((s) => s.key).join(',') === 'posts,reposts,replies',
   'three streams planned, in order: posts, reposts, replies');
ok(plan[2].op === 'UserRepliesTimeline', 'replies uses UserRepliesTimeline');

plan = S.planStreams({ config: { includeKinds: ['retweet'] }, timelines: TIMELINES });
ok(plan[2].status === 'skipped' && plan[2].endReason === 'skipped-by-filter',
   'replies is skipped by the same rule when replies are not wanted');

plan = S.planStreams({ config: { includeKinds: ['reply'] }, timelines: TIMELINES });
ok(plan[0].status === 'pending' && plan[2].status === 'pending',
   'wanting replies runs BOTH posts and replies - UserOriginalsTimeline carries them too');

plan = S.planStreams({
  config: { includeKinds: [] },
  timelines: { ...TIMELINES, replies: { selected: null } },
});
ok(plan[2].status === 'failed' && plan[2].endReason === 'no-operation',
   'an unresolved replies operation fails by name without stopping the others');

/* --------------------------------------- expected vs unexpected overlap --- */

ok(S.isExpectedOverlap('posts', 'replies') && S.isExpectedOverlap('replies', 'posts'),
   'posts/replies overlap is EXPECTED, in either order');
ok(!S.isExpectedOverlap('posts', 'reposts'), 'posts/reposts overlap is NOT expected');
ok(!S.isExpectedOverlap('reposts', 'replies'), 'reposts/replies overlap is NOT expected');

{
  // A self-reply in a thread genuinely appears in both posts and replies.
  const all = [];
  const idOwner = new Map();
  S.mergePage({ all, idOwner, posts: [post('50', 'reply'), post('51')], streamKey: 'posts' });
  const r = S.mergePage({ all, idOwner, posts: [post('50', 'reply')], streamKey: 'replies' });

  ok(r.added === 0, 'a self-reply already seen in posts is NOT added twice');
  ok(all.filter((p) => p.id === '50').length === 1,
     'the self-reply appears exactly once in the union - not double counted');
  ok(r.expected.length === 1 && r.unexpected.length === 0,
     'the posts/replies collision is classified EXPECTED, not a defect signal');

  // The same collision between disjoint streams IS a defect signal.
  const r2 = S.mergePage({ all, idOwner, posts: [post('51')], streamKey: 'reposts' });
  ok(r2.unexpected.length === 1 && r2.expected.length === 0,
     'a posts/reposts collision is classified UNEXPECTED - those should be disjoint');
  ok(r2.unexpected[0].from === 'reposts' && r2.unexpected[0].owner === 'posts',
     'the collision records which stream it came from and which owns the id');
}

/* ---------------------------------------------------------- completeness --- */

{
  const done = (key, n) => ({ key, label: key, status: 'done', enumerated: n });

  let c = S.completeness({
    streams: [done('posts', 480), done('reposts', 124)],
    enumerated: 604, reportedTotal: 2616,
  });
  ok(c.complete === false, 'every stream done but 604 of 2616 seen is NOT complete');
  ok(c.materialShortfall === true && c.shortfall === 2012 && c.percent === 23,
     'the shortfall is quantified: 2012 missing, 23% seen');
  ok(/unaccounted for/.test(c.reason || ''), 'the reason names the shortfall');

  c = S.completeness({
    streams: [done('posts', 480), done('reposts', 124), done('replies', 2000)],
    enumerated: 2604, reportedTotal: 2616,
  });
  ok(c.complete === true,
     'all three streams done and within tolerance IS complete');

  c = S.completeness({
    streams: [done('posts', 480), { key: 'replies', label: 'replies', status: 'skipped' }],
    enumerated: 480, reportedTotal: 2616,
  });
  // THIS ASSERTION USED TO SAY complete === false BECAUSE A STREAM WAS SKIPPED,
  // and that was the defect written down as a test - the second time a test in
  // this file has encoded the bug it was meant to catch. A stream the USER
  // excluded is scope, not shortfall. Compare what was walked, not the account.
  ok(c.complete === true,
     'a stream SKIPPED BY THE FILTER is scope, not incompleteness - the walked stream ' +
     'ran clean, so the scan is complete for what it covered');
  ok(c.scopeFiltered === true && c.skippedStreams.join() === 'replies' &&
     c.scopeStreams.join() === 'posts',
     'and the run says plainly which streams were in scope and which were left out');

  c = S.completeness({
    streams: [done('posts', 480), { key: 'replies', label: 'replies', status: 'failed',
                                    enumerated: 3 }],
    enumerated: 483, reportedTotal: 2616,
  });
  ok(c.complete === false && /failed/.test(c.reason || ''),
     'a failed stream blocks complete and is named as the reason');

  // THIS ASSERTION USED TO SAY complete === true, and that was the bug in
  // miniature: with no denominator the check cannot run, and a check that
  // cannot run must never answer "yes". Absence of evidence is not evidence of
  // a clean sweep.
  c = S.completeness({
    streams: [done('posts', 10)], enumerated: 10, reportedTotal: null,
  });
  ok(c.complete === false,
     'with NO reported total the run is NOT complete - the check cannot assess it');
  ok(c.unknownTotal === true,
     'unknownTotal distinguishes "cannot tell" from "came up short"');
  ok(c.materialShortfall === false,
     'and it is not reported as a shortfall either - we do not know that');
  ok(c.reportedTotal === null, 'the missing total is reported as null, not guessed');
  ok(/LOWER BOUND/.test(S.shortfallBanner(c) || ''),
     'the banner for an unknown total says LOWER BOUND, not complete');

  // Everything done, nothing skipped, still short: the honest answer is "unknown".
  c = S.completeness({
    streams: [done('posts', 100), done('reposts', 10), done('replies', 20)],
    enumerated: 130, reportedTotal: 2616,
  });
  ok(/cause unknown/.test(c.reason || ''),
     'a shortfall with every stream complete says the cause is UNKNOWN rather than inventing one');

  /* -------------------------------------------- filtered scope, in detail --- */

  // The live defect: a deliberate posts-only scan reported "23 of 2035 (1%),
  // 2012 unaccounted for" in red. Every one of those 2,012 was excluded by the
  // user's own filter.
  const postsOnly = S.completeness({
    streams: [
      done('posts', 23),
      { key: 'reposts', label: 'reposts', status: 'skipped' },
      { key: 'replies', label: 'replies', status: 'skipped' },
    ],
    enumerated: 23, reportedTotal: 2035,
  });
  ok(postsOnly.complete === true && postsOnly.materialShortfall === false,
     'a posts-only scan that walked posts to a clean end is COMPLETE FOR ITS SCOPE');
  ok(postsOnly.percent === null && postsOnly.shortfall === null,
     'NO PERCENTAGE AND NO SHORTFALL: there is no in-scope denominator, so any number ' +
     'here would be arithmetic against the wrong total');
  ok(postsOnly.reportedTotal === 2035,
     'the account total is still reported unchanged - it is shown, just not used as a ' +
     'denominator');
  ok(S.shortfallBanner(postsOnly) === null,
     'AND IT RAISES NO RED BANNER. Severity has to mean something: a routine, correct, ' +
     'complete-for-its-scope scan that shows red teaches the user to ignore red');
  ok(postsOnly.reason === null, 'nothing is offered as a reason, because nothing is wrong');

  // THE WEAKER CLAIM MUST SOUND WEAKER. This is the whole point of the split:
  // a filtered scan must never borrow the confidence of the full comparison.
  ok(typeof postsOnly.claim === 'string' && postsOnly.claim.length > 0,
     'a filtered scan carries its caveat in `claim`, so the UI renders the one wording ' +
     'rather than deriving a second copy of the rule');
  ok(!/%/.test(postsOnly.claim),
     'the filtered claim states NO percentage - it cannot, and must not imply it can');
  ok(/no per-stream totals/.test(postsOnly.claim) &&
     /NOT a claim that your account holds nothing else/.test(postsOnly.claim),
     'the claim says out loud why there is no number to check against, and refuses the ' +
     'stronger reading explicitly');
  ok(/reposts and replies/.test(postsOnly.claim) && /not included/.test(postsOnly.claim),
     'and it names the streams that were left out, as SCOPE');

  const fullScope = S.completeness({
    streams: [done('posts', 480), done('reposts', 124), done('replies', 2000)],
    enumerated: 2604, reportedTotal: 2616,
  });
  ok(fullScope.scopeFiltered === false && fullScope.claim === null &&
     fullScope.percent === 100,
     'THE FULL-SCOPE PATH IS UNTOUCHED: it still computes the percentage and makes the ' +
     'stronger claim, so the two cases read differently');

  // A stream that WAS walked and came up short still warns, filtered or not.
  const filteredCeiling = S.completeness({
    streams: [
      { key: 'posts', label: 'posts', status: 'done', enumerated: 3200,
        ceilingSuspected: true },
      { key: 'replies', label: 'replies', status: 'skipped' },
    ],
    enumerated: 3200, reportedTotal: 9000,
  });
  ok(filteredCeiling.complete === false,
     'a WALKED stream that hit the ceiling is still incomplete, filter or no filter');
  ok(/INCOMPLETE FOR WHAT WAS SCANNED/.test(S.shortfallBanner(filteredCeiling) || ''),
     'and it does raise a banner - the red is kept for the case that earns it');
  ok(filteredCeiling.percent === null,
     'but still without a percentage, because the denominator is still wrong');

  const filteredFail = S.completeness({
    streams: [
      done('posts', 10),
      { key: 'reposts', label: 'reposts', status: 'failed', enumerated: 2 },
      { key: 'replies', label: 'replies', status: 'skipped' },
    ],
    enumerated: 12, reportedTotal: 500,
  });
  ok(filteredFail.complete === false && /failed/.test(filteredFail.reason || ''),
     'a FAILED in-scope stream blocks complete under a filter too, and is named');

  const filteredNoTotal = S.completeness({
    streams: [done('posts', 7), { key: 'replies', label: 'replies', status: 'skipped' }],
    enumerated: 7, reportedTotal: null,
  });
  ok(filteredNoTotal.complete === true && filteredNoTotal.unknownTotal === true,
     'a filtered scan does not rest on the account total, so an absent total neither ' +
     'weakens nor strengthens it - the claim was never about the account');
  ok(S.shortfallBanner(filteredNoTotal) === null,
     'and the LOWER BOUND banner does not fire either, because nothing here was ' +
     'measured against that total');

  const nothingScanned = S.completeness({
    streams: [
      { key: 'posts', label: 'posts', status: 'skipped' },
      { key: 'replies', label: 'replies', status: 'skipped' },
    ],
    enumerated: 0, reportedTotal: 100,
  });
  ok(nothingScanned.complete === false,
     'if EVERY stream was filtered out, nothing was scanned and nothing is complete');
  ok(/say nothing about your account/.test(nothingScanned.claim || ''),
     'and it says so rather than reporting a clean empty sweep');

  /* --------------------------------------------------- streamRanClean --- */

  ok(S.streamRanClean({ status: 'done' }) === true,
     'a done stream with no qualifying end reason ran clean');
  ok(S.streamRanClean({ status: 'done', ceilingSuspected: true }) === false &&
     S.streamRanClean({ status: 'done', endReason: 'page-limit' }) === false &&
     S.streamRanClean({ status: 'done', endReason: 'cursor-repeat' }) === false &&
     S.streamRanClean({ status: 'done', endReason: 'stopped' }) === false,
     'ceiling, page bound, repeated cursor and a user stop each make the count a FLOOR');
  ok(S.streamRanClean({ status: 'failed' }) === false &&
     S.streamRanClean(null) === false,
     'a failed stream and a missing stream are both not-clean');

  ok(S.shortfallBanner({ materialShortfall: false }) === null,
     'no banner when there is no material shortfall');
  ok(/INCOMPLETE/.test(S.shortfallBanner(
      S.completeness({ streams: [done('posts', 1)], enumerated: 1, reportedTotal: 100 })) || ''),
     'the banner leads with INCOMPLETE');
}

/* ---------------------------------------------------------------- merge --- */

{
  const all = [];
  const idOwner = new Map();
  const a = S.mergePage({ all, idOwner, posts: [post('1'), post('2')], streamKey: 'posts' });
  ok(a.added === 2 && a.crossStream.length === 0, 'first stream adds both, no collisions');

  const b = S.mergePage({ all, idOwner, posts: [post('3', 'retweet')], streamKey: 'reposts' });
  ok(b.added === 1 && b.crossStream.length === 0, 'second stream adds a disjoint id cleanly');
  ok(all.length === 3, 'union holds 3 items');
  ok(all[0]._stream === 'posts' && all[2]._stream === 'reposts',
     'each item records which stream produced it');

  // THE ONE THAT MATTERS.
  const c = S.mergePage({ all, idOwner, posts: [post('1'), post('4')], streamKey: 'reposts' });
  ok(c.crossStream.length === 1 && c.crossStream[0].id === '1',
     'CROSS-STREAM DUPLICATE COUNTED when the same id arrives from both streams');
  ok(c.unexpected.length === 1,
     'a posts/reposts collision is classified as UNEXPECTED - a defect signal');
  ok(c.added === 1, 'the genuinely new id is still added alongside the collision');
  ok(all.filter((p) => p.id === '1').length === 1,
     'the duplicate is deduped - it appears exactly once in the results');
  ok(all.find((p) => p.id === '1')._stream === 'posts',
     'the FIRST stream to produce an id keeps ownership of it');

  // A within-stream repeat is ordinary and must NOT be reported as cross-stream.
  const d = S.mergePage({ all, idOwner, posts: [post('2')], streamKey: 'posts' });
  ok(d.crossStream.length === 0 && d.withinStream.length === 1 && d.added === 0,
     'a within-stream repeat is counted separately and is not a defect signal');
}

/* --------------------------------------------------------------- resume --- */

{
  const all = [
    { id: '1', _stream: 'posts' },
    { id: '9', _stream: 'reposts' },
  ];
  const owner = S.ownerMapFrom(all);
  ok(owner.get('1') === 'posts' && owner.get('9') === 'reposts',
     'ownership is rebuilt from the results, so it survives a reload');

  const again = S.mergePage({ all, idOwner: owner, posts: [{ id: '1' }], streamKey: 'reposts' });
  ok(again.crossStream.length === 1,
     'a collision is still detected after a resume rebuilt the owner map');
}

/* ------------------------------------------------------- per-stream report */

const ceilingReport = S.streamReport({
  key: 'posts', label: 'posts', op: 'UserOriginalsTimeline', status: 'done',
  enumerated: 3100, pages: 32, ceilingSuspected: true, endReason: 'cursor-exhausted',
}, 3200);
ok(/timeline limit at 3100/.test(ceilingReport) && /data archive/.test(ceilingReport),
   'a ceiling-suspected stream says so plainly and points at the archive');

const cleanReport = S.streamReport({
  key: 'reposts', label: 'reposts', op: 'UserRepostsTimeline', status: 'done',
  enumerated: 12, pages: 1, ceilingSuspected: false, endReason: 'cursor-exhausted',
}, 3200);
ok(/fully enumerated, 12 item/.test(cleanReport),
   'a clean stream reports genuine exhaustion');
ok(/about this stream only, not about the account/.test(cleanReport),
   'a clean stream scopes its claim to ITSELF and does not imply the account is complete');
ok(!/reached X's timeline limit/.test(cleanReport),
   'the clean stream is NOT tarred with the other stream\'s ceiling verdict');

const failedReport = S.streamReport({
  key: 'reposts', label: 'reposts', op: 'UserRepostsTimeline', status: 'failed',
  enumerated: 38, pages: 2, error: 'HTTP 500',
}, 3200);
ok(/FAILED after 2 page/.test(failedReport) && /38 item\(s\) captured before the failure ARE included/
   .test(failedReport),
   'a failed stream reports what it kept, not just that it failed');

const skippedReport = S.streamReport({
  key: 'reposts', label: 'reposts', op: 'UserRepostsTimeline', status: 'skipped',
  enumerated: 0, pages: 0, endReason: 'skipped-by-filter',
}, 3200);
ok(/SKIPPED/.test(skippedReport) && /not walked at all/.test(skippedReport),
   'a skipped stream says it was never walked, not that it was empty');

/* ------------------------------------------------------------- breakdown --- */

const bd = S.pagesBreakdown([
  { label: 'posts', pages: 4, status: 'done' },
  { label: 'reposts', pages: 3, status: 'done' },
]);
ok(bd.total === 7 && bd.text === 'posts 4, reposts 3',
   'pages are cumulative with a per-stream breakdown');

const bdSkip = S.pagesBreakdown([
  { label: 'posts', pages: 4, status: 'done' },
  { label: 'reposts', pages: 0, status: 'skipped' },
]);
ok(bdSkip.text === 'posts 4', 'a skipped stream is not listed in the page breakdown');

/* ---------------------------------------------------------------- status --- */

ok(S.overallStatus([{ status: 'done', enumerated: 5 }, { status: 'done', enumerated: 5 }]) === 'done',
   'both done -> done');
ok(S.overallStatus([{ status: 'done', enumerated: 5 }, { status: 'skipped' }]) === 'partial',
   'done + skipped -> PARTIAL, because the run did less than a full sweep');
ok(S.overallStatus([{ status: 'done', enumerated: 5 }, { status: 'failed', enumerated: 2 }]) === 'partial',
   'one failed but data was enumerated -> PARTIAL, not error');
ok(S.overallStatus([{ status: 'failed', enumerated: 0 }, { status: 'failed', enumerated: 0 }]) === 'error',
   'everything failed with nothing enumerated -> error');


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
const MIN_ASSERTIONS = 82;
ok(passes + 1 >= MIN_ASSERTIONS,
   'assertion count ' + (passes + 1) + ' is at or above the floor of ' + MIN_ASSERTIONS +
   ' - if this fails, tests were deleted rather than fixed');

console.log(fails ? `\nFAILED (${fails})` : `\nALL PASS`);
process.exit(fails ? 1 : 0);
