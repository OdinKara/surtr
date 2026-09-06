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
  //
  // EVERY MODULE UNDER lib/ IS A LEAF, and this is the only place the graph is
  // wired. That is forced, not stylistic: a web-accessible module fetched
  // through a `use_dynamic_url` URL cannot resolve its own static imports. If
  // one of them ever regains an `import './other.js'`, the whole graph fails at
  // load with "Failed to fetch dynamically imported module" naming the ENTRY
  // file rather than the dependency that actually failed, which is a genuinely
  // misleading error to debug. See DEV.md.
  const ready = (async () => {
    const [store, filters, streams, discovery, api, enumerate] = await Promise.all([
      import(LIB('store.js')),
      import(LIB('filters.js')),
      import(LIB('streams.js')),
      import(LIB('discovery.js')),
      import(LIB('api.js')),
      import(LIB('enumerate.js')),
    ]);
    discovery.provide({ store });
    api.provide({ store });
    enumerate.provide({ api });
    // streams.js and filters.js are pure - nothing to inject.
    return { store, discovery, api, enumerate, filters, streams };
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
    const { store, api, discovery, enumerate, filters, streams } = await ready;

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

      // --- plan the run ---------------------------------------------------
      // Sequential, posts first. Sequential so rate-limit behaviour stays
      // attributable to one operation at a time; posts first because it is the
      // larger set and the one whose parse is validated, so an interrupted run
      // keeps the more valuable half.
      const prior = await store.readJob();
      const priorResults = await store.readResults();
      const resuming =
        prior.status === store.JOB_RUNNING &&
        Array.isArray(prior.streams) &&
        prior.streams.some((x) => x.status === streams.STATUS.RUNNING ||
                                  x.status === streams.STATUS.PENDING) &&
        priorResults.length > 0;

      const all = resuming ? priorResults : [];
      const job = resuming
        ? { ...prior, status: store.JOB_RUNNING, error: null }
        : {
            ...store.emptyJob(),
            status: store.JOB_RUNNING,
            startedAt: new Date().toISOString(),
            streams: streams.planStreams({ config, timelines: record.timelines }),
          };

      // Ownership of every id, so a cross-stream collision is detectable.
      // Rebuilt from the results on resume - it has to survive a reload.
      const idOwner = streams.ownerMapFrom(all);
      job.crossStreamDuplicates = job.crossStreamDuplicates || 0;
      job.crossStreamDuplicateIds = job.crossStreamDuplicateIds || [];
      await store.checkpoint(job, all);

      if (resuming) {
        await store.log('info', 'resuming from checkpoint: ' + all.length +
          ' item(s) already enumerated; finished streams are not redone');
      }

      for (const st of job.streams) {
        if (st.status === streams.STATUS.SKIPPED) {
          await store.log('warn',
            st.label.toUpperCase() + ' STREAM SKIPPED: the kind filter excludes it, so it ' +
            'was not walked at all. Nothing from it is in these results.');
        } else if (st.status === streams.STATUS.FAILED) {
          await store.log('error', st.error);
        }
      }

      // --- walk each stream in turn ---------------------------------------
      let fatal = null;

      for (const st of job.streams) {
        if (st.status === streams.STATUS.DONE ||
            st.status === streams.STATUS.SKIPPED ||
            st.status === streams.STATUS.FAILED) {
          continue;                     // already settled, or never runnable
        }
        if (abortRequested) break;

        st.status = streams.STATUS.RUNNING;
        job.currentStream = st.key;
        await store.checkpoint(job, all);
        await store.log('info', 'stream ' + (job.streams.indexOf(st) + 1) + ' of ' +
          job.streams.length + ': ' + st.label + ' (' + st.op + ')');

        try {
          const outcome = await enumerate.walkTimeline({
            userId: who.userId,
            screenName: who.screenName,
            bearer: record.bearer,
            queryIds: record.queryIds,
            operationName: st.op,
            startCursor: st.cursor,
            seenCursors: st.seenCursors || [],
            onLog,
            shouldAbort,
            // THE CHECKPOINT. Every page, without exception, writing the whole
            // streams array so a reload resumes mid-stream.
            onPage: async (posts, state) => {
              const merged = streams.mergePage({ all, idOwner, posts, streamKey: st.key });

              if (merged.crossStream.length > 0) {
                // NOT hygiene. These streams are tab-scoped and should be
                // disjoint, so a collision means our model of the operations is
                // wrong. Deduped for correctness, then reported loudly.
                job.crossStreamDuplicates += merged.crossStream.length;
                job.crossStreamDuplicateIds =
                  job.crossStreamDuplicateIds.concat(merged.crossStream).slice(0, 200);
                await store.log('warn',
                  'CROSS-STREAM DUPLICATE: ' + merged.crossStream.length + ' id(s) arrived ' +
                  'from ' + st.label + ' that another stream already produced - ' +
                  merged.crossStream.join(', ') + '. These streams should be disjoint, so ' +
                  'this is a finding worth reporting, not noise.');
              }

              st.pages = state.pages;
              st.cursor = state.cursor;
              st.seenCursors = state.seenCursors;
              st.enumerated += merged.added;
              st.rate = state.rate;          // this operation's own numbers only
              st.reportedTotal = state.reportedTotal;
              st.rejected = state.rejected;

              const partition = filters.partition(all, config);
              job.enumerated = all.length;
              job.matched = partition.matched.length;
              job.excluded = partition.excluded.length;
              job.pages = streams.pagesBreakdown(job.streams).total;
              await store.checkpoint(job, all);

              if (state.pages === 1) await discovery.markConfirmedLive(st.key, st.op);
            },
          });

          st.endReason = outcome.endReason;
          // Ceiling detection is PER STREAM. A run can hit X's limit on posts
          // and end on genuine cursor exhaustion on reposts; collapsing those
          // into one verdict would be a claim about the other stream that was
          // never measured.
          st.ceilingSuspected = outcome.ceilingSuspected;
          st.status = abortRequested ? streams.STATUS.PENDING : streams.STATUS.DONE;
          if (st.status === streams.STATUS.DONE) st.cursor = null;
        } catch (e) {
          const msg = String(e && e.message ? e.message : e);
          st.status = streams.STATUS.FAILED;
          st.error = msg;
          st.endReason = 'error';
          await store.log('error', st.label + ' stream failed: ' + msg);
          // 401/403 are fatal for the WHOLE run - retrying an auth failure on
          // another stream is how an account gets flagged. Everything already
          // enumerated is still kept.
          if (e && e.name === 'AuthError') { fatal = e; break; }
        }

        st.termination = streams.streamReport(st, enumerate.CEILING_HINT);
        await store.checkpoint(job, all);
      }

      // --- finish ----------------------------------------------------------
      job.currentStream = null;
      for (const st of job.streams) {
        if (!st.termination) st.termination = streams.streamReport(st, enumerate.CEILING_HINT);
      }

      const partition = filters.partition(all, config);
      job.finishedAt = new Date().toISOString();
      job.enumerated = all.length;
      job.matched = partition.matched.length;
      job.excluded = partition.excluded.length;
      job.pages = streams.pagesBreakdown(job.streams).total;
      job.rates = api.allRates();

      if (abortRequested) {
        job.status = store.JOB_IDLE;
      } else {
        const overall = streams.overallStatus(job.streams);
        job.status = overall === 'done' ? store.JOB_DONE
          : overall === 'partial' ? store.JOB_PARTIAL
          : store.JOB_ERROR;
      }
      if (fatal) job.error = fatal.message;
      await store.checkpoint(job, all);

      for (const st of job.streams) {
        await store.log(
          st.status === streams.STATUS.FAILED ? 'error'
            : st.status === streams.STATUS.SKIPPED ? 'warn' : 'ok',
          st.termination);
      }
      if (job.crossStreamDuplicates > 0) {
        await store.log('warn', 'CROSS-STREAM DUPLICATES: ' + job.crossStreamDuplicates +
          ' total. These streams are meant to be disjoint - investigate.');
      }

      // Rate observations are reported PER OPERATION and never combined.
      for (const st of job.streams) {
        if (!st.rate) continue;
        await store.log('info', 'observed rate limits for ' + st.op +
          ': limit=' + (st.rate.limit ?? 'not reported') +
          ', lowest remaining seen=' + (st.rate.observedMinRemaining ?? 'n/a') +
          ', 429s=' + st.rate.observed429s + ', requests=' + st.rate.requests);
      }

      return { ok: true, enumerated: all.length, matched: partition.matched.length };
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
              timelines: record.timelines,
              unusedCandidates: record.unusedCandidates,
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
