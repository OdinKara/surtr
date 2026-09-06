/**
 * The executor. Runs on x.com, owns ALL network calls and all job state.
 *
 * WHY EVERYTHING NETWORKED LIVES HERE
 * -----------------------------------
 * This script runs in the x.com origin, so `credentials: 'include'` makes the
 * browser attach the HttpOnly `auth_token` cookie by itself. Surtr never reads,
 * stores, forwards or even sees a credential. Move these calls anywhere else -
 * the side panel, the service worker - and you would have to start handling
 * tokens yourself, which is exactly the property this design refuses to give up.
 *
 * The side panel is display and control only; it never fetches x.com.
 * background.js is a dumb relay and holds no state.
 *
 * MODULE LOADING: Chrome does not support "type": "module" for declared content
 * scripts, so this file is a CLASSIC script that dynamically imports lib/ via
 * chrome.runtime.getURL. That is what `web_accessible_resources` in the manifest
 * is for, and it is the only no-build way to share these modules between the
 * content script and the panel.
 *
 * PHASE 1 IS READ ONLY. There is no deletion code in this file, and none
 * anywhere else in this repo - not disabled, not commented out, not behind a
 * flag. Enumerating and reporting is the whole job until the scanner is trusted.
 */

(() => {
  'use strict';

  if (window.__surtrExecutorLoaded) return;
  window.__surtrExecutorLoaded = true;

  const LIB = (f) => chrome.runtime.getURL('lib/' + f);

  // Loaded once, lazily. The listener is registered synchronously below so no
  // message is dropped while these are still in flight.
  const ready = (async () => {
    const [store, discovery, api, enumerate, filters] = await Promise.all([
      import(LIB('store.js')),
      import(LIB('discovery.js')),
      import(LIB('api.js')),
      import(LIB('enumerate.js')),
      import(LIB('filters.js')),
    ]);
    return { store, discovery, api, enumerate, filters };
  })();

  /** Set by SURTR_STOP, polled by the walk between pages and between requests. */
  let abortRequested = false;
  let running = false;

  const shouldAbort = () => abortRequested;

  async function logLine(store, level, message) {
    await store.log(level, message);
  }

  /* ------------------------------------------------------------ discover --- */

  async function doDiscover({ force = false } = {}) {
    const { store, discovery } = await ready;
    const onProgress = (m) => store.log('info', m);
    await store.log('info', force ? 'rediscovering bundle values' : 'discovering bundle values');
    const record = await discovery.discover({ force, onProgress });
    if (record.missing.length > 0) {
      await store.log(
        'error',
        'discovery incomplete - missing: ' + record.missing.join(', ') +
        '. Scanned ' + record.scanned + ' bundle(s). Use the manual override, or ' +
        'reload x.com and try again.'
      );
    } else {
      await store.log(
        'ok',
        'discovery complete: bearer + ' + Object.keys(record.queryIds).length + ' queryIds'
      );
    }
    return record;
  }

  /* ---------------------------------------------------------------- scan --- */

  async function doScan(config) {
    const { store, api, enumerate, filters } = await ready;

    if (running) return { ok: false, error: 'A scan is already running.' };
    running = true;
    abortRequested = false;

    const onLog = (level, message) => { store.log(level, message); };

    try {
      await store.clearLog();
      await store.set(store.KEY.CONFIG, config);
      await store.log('info', 'scan starting');

      const record = await doDiscover({ force: false });
      if (record.missing.length > 0) {
        throw new Error('Cannot scan: discovery is missing ' + record.missing.join(', ') + '.');
      }

      const who = await enumerate.resolveUser({
        bearer: record.bearer,
        queryIds: record.queryIds,
        onLog,
        shouldAbort,
      });

      // Resume from a checkpoint if one is sitting there, otherwise start clean.
      const prior = await store.readJob();
      const resuming =
        prior.status === store.JOB_RUNNING && prior.cursor && (await store.readResults()).length > 0;

      let all = resuming ? await store.readResults() : [];
      const job = resuming
        ? { ...prior, status: store.JOB_RUNNING, error: null, endReason: null }
        : {
            ...store.emptyJob(),
            status: store.JOB_RUNNING,
            startedAt: new Date().toISOString(),
          };
      await store.checkpoint(job, all);

      if (resuming) {
        await store.log(
          'info',
          'resuming from checkpoint: ' + all.length + ' posts already enumerated'
        );
      }

      const seenIds = new Set(all.map((p) => p.id));

      const outcome = await enumerate.walkTimeline({
        userId: who.userId,
        screenName: who.screenName,
        bearer: record.bearer,
        queryIds: record.queryIds,
        startCursor: resuming ? job.cursor : null,
        seenCursors: resuming ? job.seenCursors || [] : [],
        onLog,
        shouldAbort,
        // THE CHECKPOINT. Every page, without exception.
        onPage: async (posts, state) => {
          for (const p of posts) {
            if (seenIds.has(p.id)) continue;
            seenIds.add(p.id);
            all.push(p);
          }
          const { matched, excluded } = filters.partition(all, config);
          job.enumerated = all.length;
          job.matched = matched.length;
          job.excluded = excluded.length;
          job.pages = state.pages;
          job.cursor = state.cursor;
          job.seenCursors = state.seenCursors;
          await store.set(store.KEY.RATE, state.rate);
          await store.checkpoint(job, all);
        },
      });

      const { matched, excluded } = filters.partition(all, config);
      job.status = abortRequested ? store.JOB_IDLE : store.JOB_DONE;
      job.finishedAt = new Date().toISOString();
      job.enumerated = all.length;
      job.matched = matched.length;
      job.excluded = excluded.length;
      job.endReason = outcome.endReason;
      job.ceilingSuspected = outcome.ceilingSuspected;
      job.termination = enumerate.terminationReport({
        total: all.length,
        endReason: outcome.endReason,
        ceilingSuspected: outcome.ceilingSuspected,
      });
      // Do not carry a cursor into a finished run, or the next scan would
      // "resume" from the end and report zero.
      if (!abortRequested) job.cursor = null;
      await store.checkpoint(job, all);

      const r = api.rateSnapshot();
      await store.log(
        'info',
        'observed rate limits: limit=' + (r.limit ?? 'not reported') +
        ', lowest remaining seen=' + (r.observedMinRemaining ?? 'n/a') +
        ', 429s=' + r.observed429s
      );
      await store.log(abortRequested ? 'warn' : 'ok', job.termination);

      return { ok: true, enumerated: all.length, matched: matched.length };
    } catch (e) {
      const { store } = await ready;
      const job = await store.readJob();
      job.status = store.JOB_ERROR;
      job.error = String(e && e.message ? e.message : e);
      job.finishedAt = new Date().toISOString();
      await store.set(store.KEY.JOB, job);
      await store.log('error', job.error);
      return { ok: false, error: job.error };
    } finally {
      running = false;
    }
  }

  /* ------------------------------------------------------------ messages --- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('SURTR_')) return undefined;

    (async () => {
      try {
        switch (msg.type) {
          case 'SURTR_PING': {
            await ready;
            sendResponse({ ok: true, running, url: location.href });
            return;
          }
          case 'SURTR_DISCOVER': {
            const record = await doDiscover({ force: Boolean(msg.force) });
            sendResponse({
              ok: record.missing.length === 0,
              // The bearer itself is never sent to the panel. The panel only
              // needs to know whether we have one.
              hasBearer: Boolean(record.bearer),
              queryIds: record.queryIds,
              missing: record.missing,
              manual: Boolean(record.manual),
              bundle: record.bundleUrl,
            });
            return;
          }
          case 'SURTR_MANUAL': {
            const { discovery } = await ready;
            const record = await discovery.applyManual(msg.values || {});
            sendResponse({ ok: record.missing.length === 0, missing: record.missing });
            return;
          }
          case 'SURTR_START': {
            const res = await doScan(msg.config || {});
            sendResponse(res);
            return;
          }
          case 'SURTR_STOP': {
            abortRequested = true;
            const { store } = await ready;
            await store.patch(store.KEY.JOB, { status: store.JOB_STOPPING });
            await logLine(store, 'warn', 'stop requested');
            sendResponse({ ok: true });
            return;
          }
          case 'SURTR_RESET': {
            const { store } = await ready;
            await store.checkpoint(store.emptyJob(), []);
            await store.clearLog();
            sendResponse({ ok: true });
            return;
          }
          default:
            sendResponse({ ok: false, error: 'unknown message ' + msg.type });
        }
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
      }
    })();

    return true; // async sendResponse
  });
})();
