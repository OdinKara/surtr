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
    const [store, filters, streams, execute, killlog, discovery, api, enumerate] =
      await Promise.all([
        import(LIB('store.js')),
        import(LIB('filters.js')),
        import(LIB('streams.js')),
        import(LIB('execute.js')),
        import(LIB('killlog.js')),
        import(LIB('discovery.js')),
        import(LIB('api.js')),
        import(LIB('enumerate.js')),
      ]);
    discovery.provide({ store });
    api.provide({ store });
    enumerate.provide({ api });
    killlog.provide({ store });
    // streams.js, filters.js and execute.js are pure - nothing to inject.
    return { store, discovery, api, enumerate, filters, streams, execute, killlog };
  })();

  /**
   * Minted when this content script loads, i.e. once per page load.
   *
   * This is what makes "a completed scan in THIS session" enforceable. A
   * checkpoint left in storage by a previous page load carries a different id,
   * so it cannot be executed against - it has to be re-scanned. Phase 2 must
   * never act on a result set whose provenance it cannot vouch for.
   */
  const SESSION_ID = 'sess-' + Date.now().toString(36) + '-' +
    Math.random().toString(36).slice(2, 10);

  /** Set by SURTR_STOP, polled by the walk between pages and between requests. */
  let abortRequested = false;
  let running = false;
  let executing = false;

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
    const { store, api, discovery, enumerate, filters, streams, execute } = await ready;

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
      // The account total. SECONDARY source here (the user response); the
      // primary is read off the first accepted entry of the first page, in
      // walkTimeline, and overwrites this if it lands.
      if (job.reportedTotal == null && who.reportedTotal != null) {
        job.reportedTotal = who.reportedTotal;
        job.reportedTotalSource = 'user-response';
      }

      const idOwner = streams.ownerMapFrom(all);
      job.crossStreamDuplicates = job.crossStreamDuplicates || 0;
      job.crossStreamDuplicateIds = job.crossStreamDuplicateIds || [];
      job.crossStreamExpected = job.crossStreamExpected || 0;
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
            // A stream sleeping out a rate limit must be visibly alive. This
            // publishes the window boundary so the panel can count down to it.
            onRateLimit: async (info) => {
              job.rateLimited = info
                ? { ...info, streamKey: st.key, label: st.label }
                : null;
              await store.checkpoint(job, all);
            },
            // THE CHECKPOINT. Every page, without exception, writing the whole
            // streams array so a reload resumes mid-stream.
            onPage: async (posts, state) => {
              const merged = streams.mergePage({ all, idOwner, posts, streamKey: st.key });

              // Expected vs unexpected. posts/replies MAY legitimately overlap -
              // UserOriginalsTimeline returns entries with
              // in_reply_to_status_id_str - so calling that a model error would
              // be crying wolf. Any other pair should be disjoint and a
              // collision there really is a finding.
              if (merged.expected.length > 0) {
                job.crossStreamExpected += merged.expected.length;
                await store.log('info',
                  merged.expected.length + ' id(s) seen in both the ' +
                  merged.expected[0].owner + ' and ' + st.label + ' streams. Expected - ' +
                  'those two overlap by design - deduped, not a defect.');
              }
              if (merged.unexpected.length > 0) {
                job.crossStreamDuplicates += merged.unexpected.length;
                job.crossStreamDuplicateIds = job.crossStreamDuplicateIds
                  .concat(merged.unexpected.map((c) => c.id)).slice(0, 200);
                await store.log('warn',
                  'CROSS-STREAM DUPLICATE: ' + merged.unexpected.length + ' id(s) arrived ' +
                  'from ' + st.label + ' that another stream already produced - ' +
                  merged.unexpected.map((c) => c.id).join(', ') + '. These streams should ' +
                  'be disjoint, so this is a finding worth reporting, not noise.');
              }

              st.pages = state.pages;
              st.cursor = state.cursor;
              st.seenCursors = state.seenCursors;
              st.enumerated += merged.added;
              st.rate = state.rate;          // this operation's own numbers only
              st.reportedTotal = state.reportedTotal;
              // Primary source wins. Without a denominator the completeness
              // check cannot fire at all, and a guard that cannot trigger is
              // identical to no guard.
              if (state.reportedTotal != null && job.reportedTotal == null) {
                job.reportedTotal = state.reportedTotal;
                job.reportedTotalSource = state.reportedTotalSource || 'timeline-entry';
              }
              st.rejected = state.rejected;
              st.dispensableAnomalies = state.dispensableAnomalies || 0;
              st.reportedTotalSource = state.reportedTotalSource || null;

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
      job.rateLimited = null;
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
          ' total, between stream pairs that should be disjoint - investigate.');
      }

      // DID THIS RUN ACTUALLY SEE THE ACCOUNT? A clean endReason per stream is
      // not an answer to that question, and treating it as one is how a run
      // that reached a fraction of an account reported success.
      // Provenance for phase 2: which session produced this set, and under
      // which filters. Both are checked before anything can be dispatched.
      job.scanSessionId = SESSION_ID;
      job.scanConfigFingerprint = execute.configFingerprint(config);

      job.completeness = streams.completeness({
        streams: job.streams,
        enumerated: all.length,
        reportedTotal: job.reportedTotal,
      });
      await store.log(
        job.reportedTotal == null ? 'warn' : 'info',
        job.reportedTotal == null
          ? 'ACCOUNT TOTAL UNKNOWN: X reported no item count from either source, so ' +
            'completeness cannot be assessed. These results are a LOWER BOUND.'
          : 'account total ' + job.reportedTotal + ' (source: ' +
            (job.reportedTotalSource || 'unknown') + ')');
      await store.checkpoint(job, all);
      const banner = streams.shortfallBanner(job.completeness);
      if (banner) await store.log('warn', banner);

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
      // A DEAD RUN MUST NOT LOOK LIKE A LIVE ONE. Leaving these set left the
      // panel reporting "stream 3 of 3 - replies - running" with a frozen rate
      // snapshot for 45 minutes after the run had actually stopped, while the
      // button correctly read "Resume". Two different truths on one screen.
      job.currentStream = null;
      job.rateLimited = null;
      await store.set(store.KEY.JOB, job);
      await store.log('error', job.error);
      return { ok: false, error: job.error };
    } finally {
      running = false;
    }
  }


  /* ------------------------------------------------------------- execute --- */

  /**
   * PHASE 2. The only code in this project that destroys data.
   *
   * Ordering inside the loop is the safety property, and it is not negotiable:
   *
   *     re-evaluate vetoes -> write the kill log -> FLUSH -> dispatch -> resolve
   *
   * The log is written and awaited BEFORE the request goes out, so a crash
   * mid-request still leaves a record that this item was attempted. A log
   * written after the response only records the deletions that went cleanly,
   * which are the ones nobody needs a record of.
   */
  async function doExecute(request) {
    const { store, api, discovery, filters, execute, killlog } = await ready;

    if (executing) return { ok: false, error: 'An execution run is already in progress.' };
    if (running) return { ok: false, error: 'A scan is running; wait for it to finish.' };

    const job = await store.readJob();
    const results = await store.readResults();
    const config = request.config || (await store.get(store.KEY.CONFIG)) || {};

    // Re-derive the matched set here. The panel's count is a display; this is
    // the number the gate is checked against.
    const { matched } = filters.partition(results, config);
    const testMode = request.testMode === true;
    const candidates = testMode ? execute.selectTestItems(matched) : matched;

    const testVerified = (await store.get(store.KEY.TEST_VERIFIED)) === true;

    const gate = execute.checkArmed({
      armed: request.armed,
      dryRun: request.dryRun,
      confirmCount: request.confirmCount,
      expectedCount: candidates.length,
      scanStatus: job.status,
      scanSessionId: job.scanSessionId,
      currentSessionId: SESSION_ID,
      configFingerprint: execute.configFingerprint(config),
      scanConfigFingerprint: job.scanConfigFingerprint,
      testMode,
      testVerified,
    });
    if (!gate.ok) {
      await store.log('error', 'EXECUTION REFUSED: ' + gate.refusals.join('; '));
      return { ok: false, error: gate.refusals.join('; '), refusals: gate.refusals };
    }

    const record = await doDiscover({ force: false });
    const missingWrites = execute.WRITE_OPERATIONS
      ? Object.keys(execute.WRITE_OPERATIONS).filter(
          (op) => !(record.writes && record.writes[op] && record.writes[op].queryId))
      : [];
    if (missingWrites.length > 0) {
      const msg = 'EXECUTION REFUSED: no queryId discovered for ' + missingWrites.join(', ');
      await store.log('error', msg);
      return { ok: false, error: msg };
    }

    // Vetoes re-evaluated HERE, from the live config, never trusted from the scan.
    const { dispatch, skipped } = execute.buildPlan({
      items: candidates, config, evaluate: filters.evaluate,
    });

    const runId = 'run-' + Date.now().toString(36);
    const priorLog = await killlog.read();
    const settled = killlog.settledTargets(priorLog, request.resumeRunId || runId);
    const activeRunId = request.resumeRunId || runId;

    executing = true;
    abortRequested = false;

    const exec = {
      runId: activeRunId,
      testMode,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: 'running',
      total: dispatch.length,
      done: 0,
      counts: null,
      skipped: skipped.map((s) => ({ id: s.item.id, kind: s.item.kind, reason: s.reason })),
      stoppedReason: null,
      successShapeConfirmed: false,
    };
    await store.set(store.KEY.EXEC, exec);

    await store.log('warn', 'EXECUTION STARTING' + (testMode ? ' (TEST RUN, 5 items)' : '') +
      ': ' + dispatch.length + ' item(s) to act on, ' + skipped.length + ' skipped.');
    for (const s of skipped) {
      await store.log('info', 'skipped ' + s.item.id + ' (' + s.item.kind + '): ' + s.reason);
    }

    let fatal = null;
    let dispatched = 0;
    // Per run, in memory, never persisted - see createBreaker for why this is
    // the opposite of the kill-log offer flag.
    const breaker = execute.createBreaker();
    try {
      for (const plan of dispatch) {
        if (abortRequested) { exec.stoppedReason = 'stopped by you'; break; }
        if (settled.has(plan.op + ':' + plan.targetId)) {
          exec.done += 1;
          continue;                       // already settled in the run being resumed
        }

        // 1. LOG FIRST, AND FLUSH.
        const index = await killlog.append(killlog.entryFor({
          item: plan.item, op: plan.op, targetId: plan.targetId,
          runId: activeRunId, testMode,
        }));

        // 2. Only now does anything irreversible happen.
        let res;
        try {
          res = await api.gqlPost({
            queryId: record.writes[plan.op].queryId,
            operationName: plan.op,
            // Per-operation, never a shared builder: DeleteTweet takes
            // tweet_id, DeleteRetweet takes source_tweet_id, and a single
            // builder sending one to the other is what caused the 422.
            variables: execute.variablesFor(plan.op, plan.targetId),
            bearer: record.bearer,
            onLog: (level, message) => { store.log(level, message); },
            shouldAbort,
            onRateLimit: async (info) => {
              exec.rateLimited = info ? { ...info } : null;
              await store.set(store.KEY.EXEC, exec);
            },
          });
        } catch (e) {
          await killlog.resolve(index, {
            outcome: execute.OUTCOME.FAILED,
            detail: 'request threw: ' + String(e && e.message ? e.message : e),
          });
          if (e && e.name === 'AbortedError') { exec.stoppedReason = 'stopped by you'; break; }
          throw e;
        }

        const verdict = execute.classifyOutcome({
          status: res.status, body: res.body, operationName: plan.op,
        });

        // Retain the raw body for ANY non-success outcome, wherever it occurs,
        // plus the first few of a run for confirming shapes. Keeping only the
        // first three would drop exactly the response worth having when item
        // 300 fails in a way nobody predicted.
        const keepRaw = execute.shouldRetainRaw({
          outcome: verdict.outcome, indexInRun: dispatched,
        });
        dispatched += 1;
        await killlog.resolve(index, {
          outcome: verdict.outcome,
          detail: verdict.detail,
          status: res.status,
          raw: keepRaw ? execute.truncateRaw(res.raw) : undefined,
        });

        if (verdict.outcome === execute.OUTCOME.FAILED && exec.done === 0) {
          // FIRST CALL FAILED. Log everything and stop - do not iterate blind
          // against a write endpoint.
          await store.log('error',
            'FIRST WRITE FAILED - STOPPING. Request: ' + JSON.stringify(res.request) +
            '  Response status ' + res.status + ': ' + String(res.raw).slice(0, 1500));
          exec.stoppedReason = 'first write failed; stopped rather than iterating blind';
          fatal = new Error(exec.stoppedReason);
          break;
        }
        if (verdict.fatal) {
          await store.log('error', 'ABORTING RUN: ' + verdict.detail);
          exec.stoppedReason = verdict.detail;
          fatal = new Error(verdict.detail);
          break;
        }

        if (verdict.outcome !== execute.OUTCOME.FAILED) {
          await discovery.markWriteConfirmedLive(plan.op);
        }

        // THE CIRCUIT BREAKER. The first-item guard above only catches a run
        // that is broken from the start; this catches one that breaks partway,
        // which on a large set is the difference between losing one item to a
        // bug and losing hundreds.
        execute.recordOutcome(breaker, {
          outcome: verdict.outcome,
          status: res.status,
          body: res.body,
          detail: verdict.detail,
          targetId: plan.targetId,
          op: plan.op,
        });
        if (breaker.tripped) {
          exec.abortedByBreaker = true;
          exec.breaker = {
            reason: breaker.reason,
            immediate: breaker.immediate,
            consecutive: breaker.consecutive,
            limit: breaker.limit,
            failures: breaker.failures,
          };
          exec.stoppedReason = breaker.reason;
          await store.log('error',
            (breaker.immediate
              ? 'ABORTING IMMEDIATELY: ' + breaker.reason + '. Retrying cannot fix this, ' +
                'and every further dispatch would be a wasted write.'
              : 'ABORTING: ' + breaker.reason + '.') +
            ' Raw failure bodies: ' +
            breaker.failures.map((f) => '[' + f.op + ' ' + f.targetId + ' HTTP ' +
              f.status + '] ' + (f.raw || f.detail || '')).join('  |  '));
          exec.done += 1;
          break;
        }

        exec.done += 1;
        // 3. CHECKPOINT AFTER EVERY ITEM.
        exec.counts = execute.tally(killlog.forRun(await killlog.read(), activeRunId));
        await store.set(store.KEY.EXEC, exec);

        // Conservative pacing. The write limits are UNKNOWN; this is not a
        // guess at the ceiling, it is a refusal to find it at speed.
        if (!abortRequested) await sleep(WRITE_DELAY_MS);
      }
    } finally {
      const finalLog = await killlog.read();
      exec.counts = execute.tally(killlog.forRun(finalLog, activeRunId));
      exec.finishedAt = new Date().toISOString();
      // An aborted run is never 'done'. runStatusFor checks the breaker first.
      exec.status = execute.runStatusFor({
        abortedByBreaker: Boolean(exec.abortedByBreaker),
        fatal: Boolean(fatal),
        stopped: abortRequested,
      });
      exec.rateLimited = null;
      await store.set(store.KEY.EXEC, exec);
      executing = false;
      const abortLine = execute.breakerReport(breaker, exec.counts, dispatched);
      await store.log(fatal || exec.abortedByBreaker ? 'error' : 'ok',
        abortLine ||
        ('EXECUTION ' + exec.status.toUpperCase() + ': ' +
         execute.outcomeSummary(exec.counts) +
         (exec.stoppedReason ? ' - ' + exec.stoppedReason : '')));
      if (exec.counts.unverified > 0) {
        await store.log('warn',
          exec.counts.unverified + ' item(s) are UNVERIFIED rather than deleted: no ' +
          'confirmed success shape yet for ' + execute.unconfirmedOperations().join(', ') +
          '. Check by hand, then send the raw response from the kill log so the shape ' +
          'can be encoded.');
      }
    }

    return { ok: !fatal, counts: exec.counts, runId: activeRunId };
  }

  const WRITE_DELAY_MS = 1500;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
          case 'SURTR_EXECUTE': {
            const res = await doExecute(msg || {});
            sendResponse(res);
            return;
          }
          case 'SURTR_SESSION': {
            // The panel asks which session the executor is in, so it can tell
            // whether the stored scan belongs to this page load.
            const { store } = await ready;
            const job = await store.readJob();
            sendResponse({
              ok: true,
              sessionId: SESSION_ID,
              scanSessionId: job.scanSessionId || null,
              scanConfigFingerprint: job.scanConfigFingerprint || null,
            });
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
