/**
 * The kill log: the only record of what was destroyed.
 *
 * APPEND-ONLY, AND WRITTEN BEFORE THE REQUEST GOES OUT. That ordering is the
 * whole point. A log written after a successful response records only the
 * deletions that completed cleanly - which is exactly the set you do not need a
 * record of. The ones worth having are the request that crashed the tab, the
 * one that timed out, the one whose response never arrived: those leave an
 * entry saying "attempted" and nothing else, and that entry is the only trace
 * that anything happened to that post.
 *
 * So: append, FLUSH, then dispatch. Never the other way round, and never
 * batched - a batch that has not been flushed is a batch you cannot recover.
 *
 * This module is a LEAF; `store` is injected by content/executor.js.
 */

let store = null;

/** Called by content/executor.js immediately after importing this module. */
export function provide(deps) {
  if (!deps || !deps.store) throw new Error('lib/killlog.js: provide() needs { store }.');
  store = deps.store;
}

export const KILLLOG_KEY = 'surtr:killlog';

/**
 * Everything worth having about one item, captured BEFORE it is acted on.
 *
 * The full text is included on purpose. This is the last place that text will
 * exist once the request succeeds, and a log that records only an id is a log
 * that tells you a number was deleted rather than what you lost.
 */
export function entryFor({ item, op, targetId, runId, testMode }) {
  return {
    runId,
    testMode: Boolean(testMode),
    attemptedAt: new Date().toISOString(),
    op,
    targetId,
    id: item.id,
    kind: item.kind,
    sourceTweetId: item.sourceTweetId ?? null,
    createdAt: item.createdAt ?? null,
    text: item.text ?? '',
    permalink: item.permalink ?? null,
    likeCount: item.likeCount ?? null,
    retweetCount: item.retweetCount ?? null,
    replyCount: item.replyCount ?? null,
    stream: item._stream ?? null,
    // Filled in once known. Absent means the request went out and we never
    // learned what happened - which is information, not an error in the log.
    outcome: 'attempted',
    outcomeDetail: null,
    resolvedAt: null,
    responseStatus: null,
    // The first few raw bodies are kept so the success shape can be determined
    // from evidence rather than assumed. See execute.classifyOutcome.
    rawResponse: null,
  };
}

export async function read() {
  return (await store.get(KILLLOG_KEY)) || [];
}

/**
 * Append one entry and FLUSH before returning.
 *
 * The await is load-bearing: the caller must not dispatch until this resolves,
 * or the log is a promise rather than a record.
 */
export async function append(entry) {
  const log = await read();
  log.push(entry);
  await store.set(KILLLOG_KEY, log);
  return log.length - 1;   // the index, so the outcome can be filled in later
}

/** Resolve a previously appended entry. Never rewrites anything else. */
export async function resolve(index, { outcome, detail, status, raw }) {
  const log = await read();
  if (!log[index]) return null;
  log[index].outcome = outcome;
  log[index].outcomeDetail = detail ?? null;
  log[index].responseStatus = status ?? null;
  log[index].resolvedAt = new Date().toISOString();
  if (raw !== undefined) log[index].rawResponse = raw;
  await store.set(KILLLOG_KEY, log);
  return log[index];
}

/**
 * Ids already dealt with in this run, for resume.
 *
 * An entry still marked `attempted` is deliberately NOT included: we do not
 * know whether that request landed. Re-attempting is safe (a second delete of
 * an already-deleted post classifies as already-gone) whereas skipping could
 * silently leave an item undeleted while reporting the run complete. So an
 * unresolved attempt is retried, and the log keeps both entries - the record of
 * what was attempted is not overwritten by the retry.
 */
export function settledTargets(log, runId) {
  const done = new Set();
  for (const e of log || []) {
    if (e.runId !== runId) continue;
    if (e.outcome && e.outcome !== 'attempted') done.add(e.op + ':' + e.targetId);
  }
  return done;
}

/** Every entry for one run, in order. */
export function forRun(log, runId) {
  return (log || []).filter((e) => e.runId === runId);
}

export async function clear() {
  await store.set(KILLLOG_KEY, []);
}

/* ------------------------------------------------------------- export --- */

const CSV_COLUMNS = [
  'attemptedAt', 'runId', 'testMode', 'op', 'targetId', 'id', 'kind', 'sourceTweetId',
  'createdAt', 'outcome', 'outcomeDetail', 'responseStatus', 'resolvedAt',
  'likeCount', 'retweetCount', 'replyCount', 'stream', 'permalink', 'text',
];

export function toCsv(log) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const out = [CSV_COLUMNS.join(',')];
  for (const e of log || []) out.push(CSV_COLUMNS.map((c) => esc(e[c])).join(','));
  return out.join('\r\n');
}
