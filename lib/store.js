/**
 * chrome.storage.local wrapper + checkpointing.
 *
 * Everything durable lives here and NOWHERE else. The service worker is killed
 * whenever Chrome feels like it, and a tab reload wipes the executor's memory,
 * so any state that must survive either event has to be written here first.
 *
 * Keys are namespaced so a future phase can add its own without collisions.
 *
 * There is NO "unlimitedStorage" permission, deliberately. X's timeline stops
 * serving your own history somewhere around 3,200 entries, and a result set
 * that size with text previews sits comfortably inside the default 5 MB quota.
 * If a future phase ever needs more room, the honest fix is to trim what is
 * stored per post, not to ask for a broader permission.
 */

const NS = 'surtr:';

export const KEY = {
  CONFIG: NS + 'config',       // filter settings from the panel
  JOB: NS + 'job',             // current scan: status, counters, cursor, error
  RESULTS: NS + 'results',     // enumerated + normalized posts (the checkpoint)
  DISCOVERY: NS + 'discovery', // bearer token + queryIds, keyed by bundle URL
  FEATURES: NS + 'features',   // negotiated GraphQL feature set, per operation
  RATE: NS + 'rate',           // last observed rate-limit headers
  LOG: NS + 'log',             // human-readable event log shown in the panel
};

/** Read one key. Returns `fallback` when absent. */
export async function get(key, fallback = null) {
  const bag = await chrome.storage.local.get(key);
  return Object.prototype.hasOwnProperty.call(bag, key) ? bag[key] : fallback;
}

/** Write one key. */
export async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

/** Merge fields into an object-valued key. Read-modify-write, not atomic. */
export async function patch(key, fields) {
  const cur = (await get(key)) || {};
  const next = { ...cur, ...fields };
  await set(key, next);
  return next;
}

export async function remove(key) {
  await chrome.storage.local.remove(key);
}

/* ------------------------------------------------------------------ job --- */

export const JOB_IDLE = 'idle';
export const JOB_RUNNING = 'running';
export const JOB_STOPPING = 'stopping';
export const JOB_DONE = 'done';
export const JOB_ERROR = 'error';

export function emptyJob() {
  return {
    status: JOB_IDLE,
    startedAt: null,
    finishedAt: null,
    // counters the panel renders live
    enumerated: 0,
    matched: 0,
    excluded: 0,
    pages: 0,
    // pagination state, so a reload resumes instead of restarting
    cursor: null,
    seenCursors: [],
    // why enumeration stopped: 'cursor-exhausted' | 'ceiling' | 'stopped' | 'error'
    endReason: null,
    error: null,
  };
}

export async function readJob() {
  return (await get(KEY.JOB)) || emptyJob();
}

/**
 * The checkpoint. Called after EVERY page of results, never less often: the
 * whole point is that closing the tab mid-scan costs you one page, not the run.
 */
export async function checkpoint(job, results) {
  await chrome.storage.local.set({ [KEY.JOB]: job, [KEY.RESULTS]: results });
}

export async function readResults() {
  return (await get(KEY.RESULTS)) || [];
}

/* ------------------------------------------------------------------ log --- */

const LOG_MAX = 300;

/**
 * Append a line to the panel-visible log. This is where "what the tool
 * observed" is recorded - rate-limit ceilings, negotiated features, the reason
 * enumeration stopped - so that behaviour we did not hardcode is still legible
 * after the fact.
 */
export async function log(level, message) {
  const lines = (await get(KEY.LOG)) || [];
  lines.push({ t: new Date().toISOString(), level, message: String(message) });
  await set(KEY.LOG, lines.slice(-LOG_MAX));
}

export async function clearLog() {
  await set(KEY.LOG, []);
}

/* ------------------------------------------------------------- discovery --- */

/**
 * Discovery is cached against the bundle URL it came from. When X ships a new
 * bundle the URL changes, the cache misses, and we rediscover. That is the
 * invalidation rule - there is deliberately no TTL and no fallback to a stale
 * value, because a silently stale queryId fails as a confusing 404 rather than
 * as "the bundle moved".
 */
export async function readDiscovery(bundleUrl) {
  const cached = await get(KEY.DISCOVERY);
  if (!cached || cached.bundleUrl !== bundleUrl) return null;
  return cached;
}

export async function writeDiscovery(record) {
  await set(KEY.DISCOVERY, record);
}

export async function clearDiscovery() {
  await remove(KEY.DISCOVERY);
}

/* -------------------------------------------------------------- features --- */

export async function readFeatures(operationName) {
  const all = (await get(KEY.FEATURES)) || {};
  return all[operationName] || null;
}

export async function writeFeatures(operationName, features) {
  const all = (await get(KEY.FEATURES)) || {};
  all[operationName] = features;
  await set(KEY.FEATURES, all);
}
