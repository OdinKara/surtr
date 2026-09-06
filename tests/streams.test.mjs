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
const ok = (c, m) => { console.log((c ? '[OK]  ' : '[X]   ') + m); if (!c) fails++; };

const post = (id, kind = 'post') => ({ id, kind, text: 't' + id });
const TIMELINES = {
  posts: { selected: 'UserOriginalsTimeline', found: ['UserOriginalsTimeline'] },
  reposts: { selected: 'UserRepostsTimeline', found: ['UserRepostsTimeline'] },
};

/* ------------------------------------------------------------- planning --- */

let plan = S.planStreams({ config: { includeKinds: ['post', 'reply', 'retweet'] },
                           timelines: TIMELINES });
ok(plan.length === 2 && plan[0].key === 'posts' && plan[1].key === 'reposts',
   'both streams planned, posts FIRST');
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
  ok(c.crossStream.length === 1 && c.crossStream[0] === '1',
     'CROSS-STREAM DUPLICATE COUNTED when the same id arrives from both streams');
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
ok(/complete, 12 item/.test(cleanReport), 'a clean stream reports genuine exhaustion');
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

console.log(fails ? `\nFAILED (${fails})` : `\nALL PASS`);
process.exit(fails ? 1 : 0);
