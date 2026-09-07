# Surtr — DEV

Handoff file. Read this first; it should be enough to resume without asking.

> **This file is COMMITTED and the repo is destined to go public.** No absolute
> machine paths, no LAN addresses, no handles, no numeric user ids. Where a
> local path matters it is written relative to the repo root. That is why this
> file looks less specific than the DEV.md in a private project — the
> constraint is deliberate, not an oversight.

---

## CURRENT STATE (resume here)

**PHASE 1 IS VALIDATED.** Live three-stream run on build `9c00d06286a0`:
2,600 of the 2,616 items X reports (99%), `complete: true`, shortfall 16;
0 cross-stream duplicates; 0 foreign permalinks across 898 matched; 2 rate
limits on the replies stream, both recovered, all items retrieved.

**PHASE 2 IS BUILT AND VALIDATED ON TEST RUNS.** Deletion is possible in this
build. Both write operations have success shapes confirmed against live
responses. Two 5-item test runs have been executed and verified by hand; full
runs remain locked behind the attestation. See "Phase 2" below before touching
it.

**Phase 1 scaffold complete and committed.** Repo is **private** on GitHub as
`OdinKara/surtr`, and stays private until the scanner is validated.

What exists and is believed correct:

- `manifest.json` — MV3, side panel, content script on `https://x.com/*`.
- `background.js` — relay + `setPanelBehavior`. Stateless by design.
- `content/executor.js` — owns every network call and all job state.
- `lib/discovery.js` — scrapes bearer + `queryId`s from the live bundle.
- `lib/api.js` — headers, rate-limit accounting, feature negotiation.
- `lib/enumerate.js` — cursor walk, normalization, ceiling detection.
- `lib/filters.js` — pure predicates. Testable with plain node, no browser.
- `lib/store.js` — `chrome.storage.local` + checkpointing.
- `ui/panel.{html,css,js}` — display and control only.

**Not yet done:** nobody has run this against a live logged-in account. The
response-shape assumptions in `lib/enumerate.js` are written from X's known
GraphQL structure but have **not been confirmed against a live response**. That
is the first job — see WHAT'S NEXT.

**There is no deletion code anywhere in this repo.** Keep it that way until the
scanner is validated. That is the whole point of the phase split.

---

## WHAT'S NEXT

1. **Load unpacked and run a real dry-run scan.** Confirm, in order:
   - Discovery finds a bearer and both `queryId`s on the first try.
   - `resolveUser` gets a `rest_id` from `UserByScreenName`.
   - The first `UserTweetsAndReplies` page returns entries and a bottom cursor.
2. **Verify the parse against a real response.** In the x.com tab's DevTools
   console, snapshot one raw GraphQL response and check
   `instructionsOf` / `collectEntries` / `normalize` against it. The likely
   points of drift are listed under KEY FACTS → "Response shapes to re-check".
3. **Confirm feature negotiation actually converges.** The seed set in
   `api.seedFeatures()` is short on purpose; the log will show every feature it
   had to add. Record what the live build demanded.
4. **Record the observed rate ceiling.** The activity log prints
   `limit`, lowest `remaining` seen, and the 429 count at the end of a run.
   Write the real numbers into KEY FACTS below once they are known — do not turn
   them into constants in the code.
5. **Establish whether the account actually hits the ~3,200 ceiling.** The
   `endReason` and `ceilingSuspected` fields on the finished job say which.
6. **Answer the retweet question** before touching `enumerate.js` parsing:
   does `UserOriginalsTimeline` include retweets, is there a retweet-specific
   operation, and is `UserRepliesTimeline` needed at all given replies are out
   of scope. Needs a bundle dump from a logged-in session — see KEY FACTS.
7. Only then: consider phase 2.

---

## KEY FACTS

### Layout

```
manifest.json
background.js            service worker: relay + side panel opener
content/executor.js      ALL network calls + job orchestration
lib/discovery.js         bearer + queryId scraping
lib/api.js               headers, rate limits, feature negotiation
lib/enumerate.js         timeline walk + normalization
lib/filters.js           pure predicates
lib/store.js             storage + checkpointing
ui/panel.{html,css,js}   side panel
```

### Non-negotiable design rules

- **No build step.** No npm, no bundler, no TypeScript. The security argument is
  "read the source yourself", so shipped code and repo code must be identical.
- **All network calls in the content script.** It runs in the x.com origin, so
  `credentials: 'include'` lets the browser attach the HttpOnly `auth_token`
  cookie. Surtr therefore never handles a credential. Moving a fetch into the
  panel or the worker breaks that property and is not an acceptable refactor.
- **Every module under `lib/` is a LEAF.** They do not import each other;
  `content/executor.js` imports all five and injects dependencies via each
  module's `provide()`. This is forced by `use_dynamic_url` — see the
  web-accessible-resources section below. Adding `import './other.js'` to a
  `lib/` module breaks the extension at load, with an error naming the wrong
  file.
- **The service worker holds no state.** MV3 kills it whenever it likes. If a
  module-scope variable in `background.js` starts to matter, it belongs in
  `lib/store.js`.
- **Checkpoint after every page.** Not every N pages. A tab reload must cost one
  page, not the run.
- **Nothing X can rotate is hardcoded.** No bearer, no `queryId`, no
  requests-per-window number. All three are discovered or observed.
- **`ct0` is read fresh on every request.** It rotates. A cached one starts
  returning 403 mid-run and looks exactly like a revoked session.
- **Two permissions, and adding a third needs an argument.** `storage` and
  `sidePanel`, plus the one host permission. `downloads` and `unlimitedStorage`
  were both dropped: exports use a blob URL and an anchor click from the panel,
  which needs no permission at all, and the ~3,200 timeline ceiling keeps the
  result set inside the default storage quota. Do not reach for
  `chrome.downloads` again to save a file the user just clicked a button to
  save.

### The one deviation from the original spec, and why

The spec gave `manifest.json` verbatim, without `web_accessible_resources`.
**It was added.** Chrome does not support `"type": "module"` on *declared*
content scripts, so `content/executor.js` is a classic script that pulls the
shared modules in with `import(chrome.runtime.getURL('lib/...'))` — and a
dynamic import of an extension file from a content script requires the file to
be web-accessible. Without it the executor throws on load and nothing runs.

The addition is scoped as tightly as it can be:

```json
"web_accessible_resources": [
  {
    "resources": ["lib/*.js"],
    "matches": ["https://x.com/*"],
    "use_dynamic_url": true
  }
]
```

Only `lib/*.js`, and only readable from x.com. It grants no permission, loosens
no CSP, and exposes no secret — those files are already published in a repo
that is going public. The alternatives were worse: bundling (breaks the "no
build step" security argument) or moving orchestration into the service worker
(breaks "the worker holds no state", which is the whole MV3 survival story).

**`use_dynamic_url: true` is the important half of that entry.** A
web-accessible resource under a stable extension id is a fingerprinting oracle:
any x.com page could `fetch('chrome-extension://<id>/lib/api.js')` and learn
that Surtr is installed. X has an active interest in knowing that. The dynamic
URL swaps the id for a per-session random token, so there is no stable string to
probe for.

**The flag costs something, and it broke the extension once. Read this before
touching lib/.**

A module fetched through a `use_dynamic_url` URL **cannot resolve its own
static imports.** `chrome.runtime.getURL()` returns the dynamic form, the
module itself fetches fine (a plain `fetch()` of the same URL returns 200), but
the module loader fails to fetch the dependency — and reports it against the
ENTRY file, not the dependency that actually failed:

```
Failed to fetch dynamically imported module:
chrome-extension://<uuid>/lib/discovery.js
```

Nothing in that message mentions `store.js`, which is the file that could not
be resolved. It is a genuinely misleading error.

Measured, both variants loaded headless and driven from the content script's
isolated world:

| module | dependencies | no flag | `use_dynamic_url` |
|---|---|---|---|
| `store.js` | leaf | OK | OK |
| `filters.js` | leaf | OK | OK |
| `discovery.js` | `./store.js` | OK | **FAIL** |
| `api.js` | `./store.js` | OK | **FAIL** |
| `enumerate.js` | `./api.js` | OK | **FAIL** |

The split is exactly on "has a static import", not on file, path, casing or
pattern.

**Consequence, and it is now a design rule: every module under `lib/` is a
LEAF.** None of them import each other. `content/executor.js` imports all five
and injects the dependencies through each module's `provide()`. If a module
under `lib/` ever regains an `import './other.js'`, the extension breaks at
load with the misleading error above.

`ui/panel.js` still imports `../lib/store.js` and `../lib/filters.js`
statically, and that is fine: the panel is an extension page loading from the
extension's own static origin, so web-accessible-resource rules and the dynamic
URL do not apply to it. Both of those modules are leaves anyway.

### How the earlier "verified working" was wrong

The first verification of this flag ran a control and reported green, and the
build it green-lit was broken at load. It only ever imported `lib/store.js` and
`lib/filters.js` — **both leaves**. The failing case, a module with a static
dependency, was never exercised, and `lib/discovery.js` is the first module the
executor loads that has one.

Worth keeping as a method note rather than just a bug: the control run answered
"did the flag change the URL?" (yes) and was mistaken for an answer to "does
everything still load?" A control proves the test is meaningful; it says
nothing about coverage. Pick the sample that can fail, not the one that is
convenient — the leaf modules were chosen because they were easy to assert on.

### README accuracy note

The spec asked the README to state that `connect-src` makes Surtr
"structurally incapable of sending your data anywhere". That is true of the
**extension pages and the service worker**, which `extension_pages` CSP governs.
It is **not** true of the content script: MV3's `extension_pages` policy does
not cover content scripts, and any script in any page can fire a `no-cors`
request whose response it cannot read. The README therefore makes the narrower,
true claim plus the check that actually settles it — two `fetch` call sites,
one building only `https://x.com/i/api/graphql/...` URLs and one re-reading an
already-loaded `abs.twimg.com` bundle, both verifiable by grep. Overclaiming in
a security README is worse than the nuance.

### X split the profile timeline. UserTweetsAndReplies is dead.

A live capture of a logged-in profile page (364 requests, all 200) showed:

| operation | seen | note |
|---|---|---|
| `UserByScreenName` | yes, 1.3 kB | our discovered queryId works; auth stack proven |
| `UserOriginalsTimeline` | yes, 8.9 kB on load then ~5 kB per scroll | Posts tab + pagination |
| `UserRepliesTimeline` | yes, 21.9 kB | Replies tab |
| `UserTweetsAndReplies` | **ABSENT in all 364** | dead operation name |

So the single profile timeline is now at least two tab-scoped operations.
`lib/discovery.js` resolves a prioritised candidate list —
`UserOriginalsTimeline`, `UserRepliesTimeline`, `UserTweets`,
`UserTweetsAndReplies`, `UserMedia` — selects the first present, and reports
both the selection and every other candidate found. The operation name is
passed into `walkTimeline()`; nothing hardcodes it.

**PRESENCE IN THE BUNDLE IS NOT PROOF THE SITE SERVES IT.** That is the real
lesson here, and it now shapes the UI: `UserTweetsAndReplies` kept working as a
*discovery* result long after X stopped serving it, because its query id was
still sitting in the JavaScript. The panel therefore shows an operation as
**"in bundle"** until a request against it actually returns, and only then
**"confirmed live"** — set by the executor after the first successful page. A
row that says "discovered" off a bundle hit is lying by omission.

### RESOLVED: retweets live in UserRepostsTimeline

Three tab-scoped operations, all confirmed live and all 200:

| operation | tab | size | contents |
|---|---|---|---|
| `UserOriginalsTimeline` | Posts | 8.9 kB | **posts only, no retweets** (`scribeConfig.page` = `"profileOriginals"`, zero `retweeted_status_result` in the full response) |
| `UserRepostsTimeline` | Reposts | 20.2 kB | **where retweets live** |
| `UserRepliesTimeline` | Replies | 21.9 kB | out of scope - replies are not enumerated |

Scope is posts + retweets, so enumeration needs **two** streams. Discovery
therefore resolves two operations independently:

```
posts    UserOriginalsTimeline, UserTweets, UserTweetsAndReplies
reposts  UserRepostsTimeline, UserRetweetsTimeline
```

Each is selected, reported and confirmed-live **separately**, because they fail
separately: "posts resolved, reposts did not" is a completely different problem
from the reverse, and one collapsed "discovery failed" would say nothing about
which half X renamed. `missing` names the stream (`reposts timeline operation`),
it does not just say a timeline is absent.

Note the naming trap again: **"Originals" means not-retweets, NOT not-replies.**
UserOriginalsTimeline does return replies. Kind is classified per entry.

Multi-stream enumeration is BUILT - see below.

### Three streams: replies added after the first live run

The first dry run validated the scanner and immediately showed the scope was
too narrow. Live results, both streams clean, no 429s:

| stream | operation | pages | enumerated | endReason |
|---|---|---|---|---|
| posts | `UserOriginalsTimeline` | 25 | 480 | empty-page |
| reposts | `UserRepostsTimeline` | 8 | 124 | empty-page |

Cross-stream duplicates: 0. Every permalink the account's own, zero foreign
authors — the safety gate held on real data. Retweets: 22/22 classified
correctly, 22/22 with `sourceTweetId`.

**And 604 items against an account reporting 2,616.** Replies are the majority
of a normal account, and a tool that cannot see 77% of one is not fit for
purpose, so `UserRepliesTimeline` is now a third stream: posts, then reposts,
then replies. Same skip-by-filter rule, same per-stream endReason, same
per-operation rate accounting, same three-part safety gate.

**posts and replies may legitimately overlap.** UserOriginalsTimeline returned
entries carrying `in_reply_to_status_id_str` in the live capture, so a
self-reply can appear in both streams. That pair is on an EXPECTED_OVERLAP list:
the collision is still deduped and counted, but reported as expected rather than
as a model error. Every other pair stays a defect signal. Flagging X's own model
as our bug would be crying wolf, and a warning that cries wolf gets ignored
exactly when it matters.

### A clean endReason is NOT a completeness claim

This was the worst bug in the first live run, and it was a wording bug with
teeth. Both streams reported

> X ran out of cursor before the ~3200 timeline limit, so this is the full
> reachable history for this stream.

Every word of that was true per stream. The run had seen 23% of the account.

A clean `endReason` means THIS STREAM exhausted its cursor. It says nothing
about whether the account was enumerated. The two are now separated:

- Per-stream reports say "this stream is fully enumerated ... a statement about
  this stream only, not about the account."
- `streams.completeness()` compares the union against `reportedTotal` and, below
  95%, marks the run materially short, names the shortfall and the likely cause
  (which streams did not finish), and — when every stream DID finish and it is
  still short — says the cause is unknown rather than inventing one.
- The panel shows an `INCOMPLETE: 604 of 2616 (23%)` banner at the same
  prominence as the skipped-stream banner.
- The export's `complete` is true only when **both** every stream is done **and**
  there is no material shortfall. Otherwise it emits `complete: false` with
  `incompleteReason`.

### reportedTotal: wrong diagnosis, wrong fix, twice

Worth recording as a method failure, not just a bug.

The count came back null on the first live run. The diagnosis was that the
timeline response does not carry it and it lives on the user response, so the
read moved to `resolveUser()` — **and it was reported fixed on the strength of
code that had never been exercised.** The second live run returned null again on
all three streams, so `accountTotalReportedByX`, `shortfall` and
`percentOfAccount` were all null and the INCOMPLETE banner could not fire.

**A guard that cannot trigger is identical to no guard.** That failure class —
a safety net that reports success because it never actually ran — has come up
repeatedly across this studio's tooling, and every earlier instance was caught
by inspecting the artifact rather than trusting the exit code. This one was
caught only because a live export was read.

The timeline response *does* carry the count. It is on the author object
embedded in every tweet entry:

```
entry.content.itemContent.tweet_results.result.core.user_results.result.tweet_counts.tweets
        -> {"media_tweets": 86, "tweets": 2616}
```

It is now read from the **first accepted entry of the first page** — accepted
meaning the three-part gate passed, so the author is us and the count is ours —
with the `resolveUser()` user-response path kept as a secondary. The four
speculative paths added during the second attempt are **removed**: guessing more
paths was what made the failure look like a fix.

`job.reportedTotalSource` records which source answered, and it is logged, so
the next live run reports whether this worked rather than anyone taking my word
for it.

And the silent degradation is closed: `completeness()` used to return
`complete: true` when the total was unknown. Absence of evidence was reading as
evidence of a clean sweep. It now returns `complete: false` with
`unknownTotal: true`, and the panel says **LOWER BOUND … completeness cannot be
assessed**. A test asserting the old behaviour was corrected — it had encoded
the bug.

### Phase 2: the executor

The first code here that destroys data. Everything in it is shaped by one
asymmetry: every other module can be wrong and produce a bad report; this one
can be wrong and delete somebody's posts, possibly somebody else's.

**`lib/execute.js` is pure** — planning, verb selection, the arm gate, outcome
grading — so the irreversible decisions are testable without a browser and
without an account. `tests/execute.test.mjs`, 68 assertions.

**Verb selection is the dangerous part.**

```
post, reply -> DeleteTweet   on the item's OWN id
retweet     -> DeleteRetweet on sourceTweetId, the ORIGINAL post
```

Those are different ids, and for a retweet `sourceTweetId` belongs to somebody
else. Swapping them does not throw — it sends a well-formed request naming the
wrong tweet. So a retweet with no `sourceTweetId` is **skipped and reported**,
never falls back to the item's own id, and there is a test for each direction.

**The gate is enforced in the executor, not the panel.** The panel's controls
are a convenience; a UI cannot guard an irreversible action, because it is the
first thing a bug or an attacker reaches. `checkArmed()` re-derives the matched
set and re-checks every condition: dry-run explicitly off, armed explicitly
true, a completed scan **from this page session** (the content script mints a
session id on load, so a checkpoint from a previous load cannot be executed
against), filters unchanged since the scan, the exact count typed in, and — for
full runs — the 5-item test attested. Every failing condition is reported, not
just the first.

**Vetoes are re-evaluated at dispatch**, from the live config. A `keepIdList`
entry added after the scan is honoured; an item that no longer matches the
current filters is skipped as `no-longer-matched` rather than acted on because
it matched an hour ago.

### The kill log is written BEFORE the request

Append, **flush**, then dispatch. Never the other way round, never batched.

A log written after a successful response records only the deletions that went
cleanly, which are precisely the ones nobody needs a record of. The entries
worth having are the request that crashed the tab or never returned: those leave
an entry marked `attempted` and nothing else, and that entry is the only trace
that anything happened to that post.

Each entry holds id, kind, sourceTweetId, createdAt, **full text**, permalink,
counts, timestamps and the outcome once known. The text is there because once
the request succeeds this is the last place it exists.

### Outcomes: `200` is not proof of deletion

Counted separately: **succeeded, already-gone, failed, skipped, unverified,
attempted**. None absorbs another, and `outcomeSummary()` refuses to state a
"deleted" total that includes anything unconfirmed.

**DeleteTweet's success shape is CONFIRMED.** From the 5-item live run,
identical on all three captured responses and verified by hand afterwards (5
targets gone, 4 controls untouched, account total 2616 -> 2611):

```
HTTP 200
{"data":{"delete_tweet":{"tweet_results":{}}}}
```

`tweet_results` is **empty on purpose** - the tweet no longer exists to be
returned, so the empty object IS the confirmation. Nothing inside it is
required, and requiring anything would report a correct deletion as a failure.
The encoded predicate checks a 2xx, no `errors` key at all, and a non-null
`data.delete_tweet`.

Now that the shape is known, a DeleteTweet 200 that does **not** match grades as
`failed` rather than `unverified`: silence used to be ambiguity, and is not any
more.

**DeleteRetweet's success shape is CONFIRMED**, from 10 identical live
responses:

```
HTTP 200
{"data":{"unretweet":{"source_tweet_results":{"result":{"rest_id":"<source id>"}}}}}
```

**The response key is `unretweet`, not `delete_retweet`.** It is not derivable
from the operation name and was not guessed - it was read off a live body. A
test asserts a `delete_retweet` key does NOT match, so nobody can later "fix"
this into consistency.

`source_tweet_id` alone was sufficient; no `dark_request` was required. The
one-variable-per-iteration discipline ended after exactly one iteration.

**This shape is STRICTER than DeleteTweet's, and the asymmetry is deliberate.**
DeleteRetweet's response echoes back the id it acted on; DeleteTweet's returns
an empty `tweet_results` because the tweet is gone. So DeleteRetweet verifies
the echoed `rest_id` against the `source_tweet_id` we sent, and DeleteTweet
verifies nothing beyond the key's presence.

Verify what the response actually gives you. Normalising the two would mean
either dropping a real check or inventing one against an always-empty field,
and the second is theatre that reads like rigour.

**An echoed id that does not match is a FAILURE and aborts the run at once.**
Not a success, not a streak entry. A response confirming a different tweet than
the one targeted means either our target resolution or X's routing is wrong, and
every further dispatch would rest on a broken assumption. It is logged with BOTH
ids and the raw body.

One hazard found while testing this: **a tweet id cannot survive `Number()`**.
`669425844394270721` is past 2^53 and becomes `...700`. The comparison is
string-based and correctly rejects a mangled id; `planItem()` always produces a
String, so this is a guard rather than a live path, but it is asserted so it
stays one.

### The echo check has THREE outcomes, not two

The echoed `rest_id` is checked against the id we sent, and the result is one of
three things - not two:

| response | grade | why |
|---|---|---|
| echoed id **matches** | `succeeded` | verified |
| echoed id **present and different** | `failed`, aborts the run at once | something is wrong |
| `source_tweet_results` **empty**, no id at all | `unverified-ok` | there was nothing to check |

The third grade came out of a live 119-item repost run. 118 responses echoed the
source id. One returned:

```
HTTP 200
{"data":{"unretweet":{"source_tweet_results":{}}}}
```

and was graded **failed** - while the unretweet had in fact worked. The Reposts
tab emptied and X's own count agreed. The original post was simply gone, deleted
by its author or the account suspended, so X had no source tweet to return.

**An absent answer is not a negative answer.** That is the same error class as
grading a 429 as a failure: a non-answer read as a negative one. Twice now in
this project, which makes it worth naming as a question to ask of any check -
*what does this do when the thing it wants to inspect is simply not there?*

The distinction is kept sharp because the two cases mean opposite things. A
**different** id means our target resolution or X's routing is wrong, and stays
fatal. An **absent** id means there was no check to perform, and must not count
as failure, must not abort, and must not feed the circuit breaker.

### The same emptiness, two meanings - which is why shapes are per operation

`DeleteTweet` returns `tweet_results: {}` and **that empty object IS the success
shape** - the tweet is gone, so there is nothing to return, every time.

`DeleteRetweet` returns `source_tweet_results` **populated** almost always, and
legitimately empty when the original post no longer exists.

Same empty object. In one operation it is the confirmation; in the other it is
the absence of one. No single normalised rule can be right for both, and any
attempt to "tidy" the two shapes into one would have to pick a meaning and be
wrong about the other operation. This is the concrete reason
`CONFIRMED_SUCCESS_SHAPES` is keyed per operation and must stay that way.

### LIMITATION: for retweets, already-gone is indistinguishable from success

Re-issuing DeleteRetweet against a post that is already unretweeted returns the
**same success shape** as a real unretweet - including a matching echoed
`rest_id`. There is nothing in the response to tell the two apart.

So for retweets, the deleted count means **"requests that succeeded"**, not
"retweets that existed and are now gone". A run that re-processes a stale
matched set will report those retweets as deleted a second time, truthfully by
its own definition and misleadingly to a reader.

DeleteTweet does not have this problem: deleting an already-deleted tweet
returns an error that grades as `already-gone`, which is counted separately.

This is a limitation of the endpoint, not something to paper over with a guess.
The honest mitigation is to re-scan before a run so the matched set reflects
what still exists - which the arm gate already requires for a different reason.

**Observed live**: in the 119-item repost run, 5 items had already been
unretweeted by earlier test runs and still returned success. The limitation is
not theoretical.

Shapes are keyed **per operation** for exactly this reason: knowledge about one
must not leak into a claim about another.

### The 5-item test run

Acts on the 5 **lowest-engagement, oldest** matched items and stops, whatever
the set size. Engagement is ranked ahead of age deliberately: the point is to
make the first irreversible action the least consequential one available, and a
forgotten post with no interactions is a cheaper mistake than an old post people
replied to. Age is the tie-break. An item with an unparseable date sorts **last**
— an unknown date is not evidence of age.

The exact 5 are shown in the panel before arming, so they can be checked against
what the run then reports.

Full runs are locked behind an **attestation**, not a check the tool can make:
Surtr cannot verify from here that a post is gone, so the user confirms by hand
and ticks the box. It is labelled as an attestation rather than a verification.

### PRIVACY: the kill log is never written to disk automatically

The auto-download is **gone**, not gated.

The first version wrote it on run completion. That turned out to also fire on
panel *open* - a persisted condition read as an event - and **five
`surtr-killlog-*.json` files landed in Downloads from opening the side panel**
after a single run, each containing the FULL TEXT of deleted posts.

The gating bug was fixed first. Then the feature was removed altogether, which
was the right call and the fix should have gone there directly: **no amount of
gating makes an automatic write the user's decision rather than the tool's.**
The kill log carries the text, ids and permalinks of destroyed posts, and it is
not this tool's call when that reaches a filesystem.

The helpers are **deleted**, not left unused - there is no flag that a future
change could flip back on, and a test asserts they are absent so a
re-introduction fails CI rather than passing review.

**In their place, a reminder.** When a run terminates - complete, stopped, or
aborted - the panel shows a prominent banner directly above the download
buttons:

> THE KILL LOG HAS NOT BEEN SAVED. N entries recording what this run destroyed -
> the full text, ids and permalinks - exist only in this extension's storage.
> This is the ONLY record. Download it now.

Once downloaded in the same session it changes to a quieter confirmation. That
flag is **session-only and conservative**: after a reload the panel cannot know
whether the file was kept, so it warns again. Over-reminding costs a glance;
under-reminding costs the only record of what was destroyed.

A reminder does everything the automatic download did except the part that was
wrong.

### The audit that came with it

Checked every side effect reachable from a render or rehydrate path. One other
instance of the same shape, harmless: `renderDiscovery` forced the manual
override `<details>` open on **every** repaint when discovery was incomplete, so
a user who closed it had it reopen under them at the next storage change. Now
once per session. Everything else - both report downloads, the donate link, the
test attestation write - is behind a user click, which is where an action with a
side effect belongs.

### DeleteRetweet: a shared variables builder sent the wrong key

The first live retweet attempt returned:

```
HTTP 422
{"errors":[{"code":"GRAPHQL_VALIDATION_FAILED",
            "message":"must be defined",
            "path":["variable","source_tweet_id"]}]}
```

**Verb selection and target resolution were both correct.** `sourceTweetId`
resolved to the original post and `targetId` matched it exactly - the part with
the potential to act on somebody else's tweet did its job. The request failed
purely because both operations were dispatched through **one shared variables
builder** sending `{ tweet_id, dark_request }`, which is right for DeleteTweet
and wrong for DeleteRetweet.

That is the instructive part. A shared builder makes this class of mistake
invisible: the call site reads correctly, the target is right, and the wrong
thing goes out anyway. Each operation now has its **own explicit entry** in
`WRITE_VARIABLES` and there is no shared path, so one cannot inherit another's
key names. A test asserts the two builders are different functions and that
their key sets do not overlap at all.

`variablesFor()` throws on an unknown operation rather than returning something
plausible: a write with guessed variables is worse than a write that does not
happen.

**DeleteRetweet sends ONLY `source_tweet_id`.** DeleteTweet also takes
`dark_request` and it would be reasonable to assume this does too - but
reasonable is not the standard for an irreversible call, and the bundle could
not settle it: every JS asset reachable without a logged-in session contains
zero occurrences of `DeleteRetweet`, `source_tweet_id` or `dark_request`
(checked, not assumed). So the rule is one variable per iteration, each one
named by X's own validation error, never blind. If another is required the next
422 will name it exactly as this one did.

**DeleteRetweet's SUCCESS shape is still unknown.** A 422 says what the request
was missing; it says nothing about what a success looks like. It stays out of
`CONFIRMED_SUCCESS_SHAPES` until a live success is captured.

### Two things that worked, worth recording

**The run stopped after one failed item** instead of dispatching all five with
the same broken request. The `exec.done === 0` check treats a first-item failure
as "we do not understand this endpoint yet" and ends the run with the full
request and raw body logged. Four requests that would have failed identically
were never sent.

**The raw-body retention rule paid for itself immediately, on its first live
use.** This failure was at position 6 of the kill log. Under the original
position-based rule - keep the first three of a run - **that body would have
been dropped**, and that body is the entire fix: it named `source_tweet_id`
directly. Without it the next step would have been guessing at key names against
a write endpoint.

That is the clearest possible vindication of the principle behind the change:
position tells you nothing about which response is worth keeping, and the
interesting one is by definition the one you did not predict. Retaining every
non-success outcome at any position is what turned a failed run into a
one-line fix.

### Raw bodies: position was the wrong criterion

The first version kept the raw response for the first three items of a run.
That is what was asked for, and it was wrong in a way worth recording: it
retains exactly the responses you already understand and discards the one that
matters. If item 300 fails in an unexpected way, the raw body IS the diagnosis,
and it would not be there.

The rule is now: **retain the raw body for any non-success outcome, wherever it
occurs**, plus the first three of a run for shape confirmation. Success is the
only outcome cheap enough to discard, because a confirmed success shape is by
definition already known. Bodies are capped at 4,000 characters with the
truncation marked, so a cut body is never mistaken for a whole one and one
enormous response cannot bloat the log.

### Rate limits on writes are UNKNOWN

The reads observed 50 per operation per fixed ~15-minute window. **None of that
is assumed to carry over.** Writes get their own buckets automatically (rate
tracking is keyed by operation name), start at concurrency 1 with a conservative
1.5s delay between items, read `x-rate-limit-*` off every response, and back off
on 429 with the same visible countdown as the reads. 401/403 abort the whole run.

The pacing is not a guess at the ceiling — it is a refusal to find it at speed.

### One target, one write

Two distinct items could in principle resolve to the same delete target - two
retweet entries carrying the same `sourceTweetId`, say. Results are deduplicated
by ITEM id, which would not catch that, so `buildPlan()` now also deduplicates
by `(operation, targetId)` and reports the duplicate as `duplicate-target`
rather than dropping it silently.

This makes "one run dispatches the same item twice" structurally impossible
rather than merely unobserved.

### DEFECT: a 429 was graded as a failure and the item was burned

On a 447-item run, two items came back 429 and were graded **failed**. The
backoff worked - it caught the window ceiling at item 200 and waited ~10 minutes
- but those two individual 429s were classified as terminal, the items were
never re-dispatched, and **both posts are still live on the account** while the
run reported them as failures.

**A 429 is never a failure.** It means try again later.

The shape of the bug is worth more than the fix: **the same value was handled in
two code paths and only one of them was right.** The circuit breaker had always
treated 429 as neutral - explicitly, with a comment explaining why. The
classifier, twenty lines away, returned `FAILED`. Neither was written carelessly;
they were written at different times for different purposes, and nothing tied
them together. Grepping for `429` was what found it, and that is the technique
to reach for whenever a value carries a meaning: find every site that tests it,
and check they agree.

**The fix:**

- a 429 grades as `DEFERRED`, never `FAILED`, and carries `retryable: true`
- the executor **re-dispatches** the item, up to `MAX_WRITE_ATTEMPTS` (3). Each
  retry happens after `gqlPost` has already waited out the window, so three
  attempts is three windows rather than three rapid requests
- if the retries are exhausted the item stays `DEFERRED`, which means **not
  attempted successfully, still exists, a re-scan will pick it up** - not
  `failed`, which reads as an error worth investigating rather than work still
  to do
- `deferred` is counted separately, never folded into deleted or failed, and the
  panel says plainly that those items still exist
- an abort mid-flight also grades `DEFERRED` rather than `FAILED`, for the same
  reason: the item was not rejected, it was interrupted

`DEFERRED` is neutral for the circuit breaker, exactly as the raw 429 always
was - so the two paths now agree by construction rather than by coincidence.

**The same audit found a second one.** On the READ path, a 429 did `continue`
inside the feature-negotiation loop, so every rate limit consumed a negotiation
round. Enough of them would exhaust the loop and throw *"feature negotiation did
not converge"* - an error that is both wrong and the kind that sends someone
looking in entirely the wrong place. Rate-limit waits are now counted
separately, bounded on their own terms.

### Tests can be deleted silently, so there is a floor now

While fixing the above it turned out that an earlier edit had deleted **~50
assertions** - the entire circuit-breaker section - by replacing a range wider
than intended. The suite still printed `ALL PASS`, because **fewer passing tests
is indistinguishable from all tests passing.**

That is the same class as everything else here: a green signal that means less
than it appears. Each test file now asserts a `MIN_ASSERTIONS` floor, so losing
tests fails the suite instead of quietly shrinking it.

### The consecutive-failure circuit breaker

The first-item guard only catches a run that is broken from the very start. A
run where item 1 succeeds and items 2..N fail identically would dispatch every
one of them - on a 452-item run, the difference between losing one item to a bug
and losing four hundred.

**Five consecutive failures aborts the run.** Success and already-gone reset the
counter: the endpoint is evidently working, so whatever caused earlier failures
was not systemic. Four failures, a success, then four more is **not** an abort,
and there is a test for exactly that.

**A single unrecoverable failure aborts immediately**, without waiting for five:

- any `GRAPHQL_VALIDATION_FAILED`, at the top level or in `extensions`
- any 4xx that is not 429 and not the already-gone case

A validation error means the **request shape** is wrong. The hundredth attempt
is rejected exactly like the first, and every one in between is a wasted write
against a real account. The same reasoning covers other 4xx: the server is
saying the request is unacceptable, not that it is busy.

**429 is neutral** - neither counted nor reset. Counting it would abort a run
that is merely being throttled; resetting on it would let a genuinely broken run
launder its failure streak through rate limits. **Unverified is neutral too**,
in the other direction: not a failure, but not evidence of success either, so it
must not clear a streak. **5xx counts toward the streak** rather than aborting
alone, because a server error might genuinely be transient. 401/403 stay fatal
as before.

**An aborted run is never presented as a completed one.** `runStatusFor()`
checks the breaker first and yields `aborted`, which wins over every other
status; `runIsComplete()` is true only for `done`. The status line reads
`ABORTED - INCOMPLETE`, a banner carries the reason, the dispatched/planned
split, how many were never attempted, and the raw failure bodies; and the kill
log export carries `run.complete: false`, `abortedByBreaker`, `notDispatched`
and the failures. "Done" is the word somebody will remember later when deciding
whether the rest of their account was processed.

### Persist what suppresses, reset what triggers

The breaker state is **per run, in memory, deliberately not persisted** - the
exact opposite of the kill-log offer flag, which had to persist. The two rules
look contradictory and are not, and since the state-vs-transition problem now
cuts both ways in this codebase the distinction is worth stating plainly:

| | Flag | A stale value causes |
|---|---|---|
| Kill-log offer | **suppresses** an action | a download that should have happened does not — mildly annoying |
| Failure counter | **triggers** an action | a healthy run is aborted for yesterday's failures — and the user cannot resume without hunting invisible state |

So the offer flag persists (forgetting is worse than remembering) and the
failure counter resets (remembering is worse than forgetting). The general form:
**ask which direction a stale value fails in, not whether staleness is bad.**

A resumed run therefore starts with a clean counter, which is correct - the
failures that stopped the previous attempt may well have been fixed in between,
and that is usually why somebody is resuming.

### If the first write fails, the run STOPS

Not retried, not iterated on. The full request and the raw response body are
logged and the run ends, because iterating blind against a write endpoint is how
a bad request gets sent a hundred times instead of once.

### Checkpoint after every item

Not every batch. `exec.done` and the kill log are written per item, so a stopped
or crashed run resumes without re-attempting settled items. An entry still
marked `attempted` is deliberately **retried**: we do not know whether that
request landed, and re-deleting an already-deleted post classifies as
`already-gone`, whereas skipping it could leave an item undeleted while the run
reports itself complete.

### expectedOverlapDeduped: the prediction was wrong

We predicted posts and replies would overlap, because `UserOriginalsTimeline`
returns entries carrying `in_reply_to_status_id_str`. Across all 2,600 items in
a full live run, **no id appeared in two streams** — the three operations are
fully disjoint. Carrying a reply's metadata is not the same as serving it in the
replies stream.

Harmless, and the counter stays exactly as it is. It was built as a defect
detector, and a detector that has never fired against real data is doing its
job; the `EXPECTED_OVERLAP` allowance for posts/replies stays too, since the
cost of keeping it is nil and X's behaviour here is evidently not something to
predict from field names.

### Which build is loaded: the panel says so

A 45-minute live run was interpreted against the wrong code. The extension had
not been reloaded, so a run that appeared to exercise new parser work was
running the old build, and the result read as a regression in code that never
executed. "Did you reload?" is not a diagnostic.

The panel's Connection block now shows a **build fingerprint** — a SHA-256 over
the 13 files that define behaviour, read back through
`chrome.runtime.getURL()`, i.e. the bytes the browser actually has.
`node tools/build-id.mjs` prints the identical value for a working tree, so the
two can be compared directly. If they differ, the browser is running something
other than that tree.

It is computed rather than written down on purpose. A hand-maintained version
string answers what somebody last remembered to type, which is worthless
precisely when the thing in doubt is whether the code on disk is the code in
memory.

### A NUL byte, and why the fingerprint has a named separator

Building the above surfaced a defect worth recording. The per-file records were
joined with an inline separator containing a space, and **a stray NUL byte had
replaced that space** in the shipped file. The source looked identical in every
editor. Every test passed. The only outward sign was `grep` reporting
`Binary file lib/build.js matches`.

The consequence was two implementations of the same fingerprint disagreeing —
the panel said one thing, the tool said another — for a reason invisible on the
page. Diagnosis took four rounds precisely because the inputs and the digest
both looked correct in isolation, and they were.

Fixed three ways rather than one, because "be careful" is not a fix:

- the separator is a **named constant of printable characters**, `SEPARATOR`
- `tools/build-id.mjs` **reads that constant out of `lib/build.js`** instead of
  restating it, so the two cannot drift apart again
- `tests/build.test.mjs` **fails on any control byte anywhere in the tree**

### The rate-limit window counter

`101 / 50 requests this window` is not merely wrong, it is impossible — and an
impossible number in a status line discredits every number beside it. The
per-window counter was never reset; it accumulated across windows.

The counter now resets at the boundary, detected three ways: X reports a later
reset than the one being tracked, the tracked reset falls into the past, or
`remaining` goes **up** (which only happens on a refill). Run-long totals are
kept separately as `totalRequests`, because "how many requests did this run
make" is a different question from "how much budget is left in this window".

After waiting out a 429 the cached `remaining` is also **invalidated**: the next
response's headers are the only authority on whether the window really refilled,
and treating a pre-sleep snapshot as still true is how a stream waits out its
window and then behaves as though it were still exhausted.

### One source of truth for "is it running"

The panel showed `stream 3 of 3 - replies - running` while the button read
`Resume dry-run scan`. Both were rendering honestly from different inputs:

- the status line's `running` was a **literal string**, emitted whenever a
  `currentStream` existed
- the button derived from `job.status`, which was correct

And the run had in fact **died**: the `catch` block set `JOB_ERROR` but never
cleared `currentStream` or `rateLimited`, so a dead run kept presenting as a
live one, complete with a frozen rate snapshot reading `0 / 50, resets in 0s`.

Now: a single `live` flag derived from `job.status` drives the button, the
status line, and the rate-limit banner, so they cannot disagree; `runState()`
is the only thing that describes what the run is doing; the error path clears
both fields; and a reset timestamp in the past renders as *window elapsed,
budget refilled* rather than the stuck-looking `resets in 0s`.

### A bound on pagination

The replies stream reached **133 pages** without the cursor ending — which was
legitimate (roughly 20 items per page against a ~2,600-item account), not a
loop. `seenCursors` would have caught a genuine repeat.

But nothing bounded the walk except X's own behaviour: cursor exhaustion, a
repeated cursor, or an empty page. If X ever returns a fresh cursor
indefinitely, none of those fire. `MAX_PAGES_PER_STREAM = 500` now bounds it,
with `endReason: 'page-limit'` and a report saying plainly that the result is a
floor and something is wrong. 500 is ~10,000 entries, far past X's own ~3,200
ceiling, so reaching it means a defect rather than a large account.

Worth knowing: `pageSize: 100` is sent as `count` but this operation returns
about 20 conversation modules per page regardless, so page counts are much
higher than the count parameter suggests.

### Conversation modules: how replies are actually reached

`UserRepliesTimeline` returns **no flat entries at all**. Every reply arrives
wrapped in a `profile-conversation-` module, so the three-part gate — which only
ever looked at flat `TimelineTimelineItem` entries — rejected all of them and
the stream enumerated zero. The gate failing closed on an unrecognised shape was
correct behaviour; it just meant replies were unreachable.

Shape, from a captured live page 1 (22 entries: 20 modules + 2 cursors):

```
content.__typename  = "TimelineTimelineModule"
content.entryType   = "TimelineTimelineModule"
content.displayType = "VerticalConversation"        <- the scope
entryId             = "profile-conversation-N"
content.items[]     = [{ dispensable, entryId, item }]
  item.itemContent.__typename       = "TimelineTweet"
  item.itemContent.tweetDisplayType = "Tweet"
  item.itemContent.tweet_results.result = a normal tweet, IDENTICAL to a flat entry
```

Cursors stay at the **top level** of entries (`cursor-bottom-N`), never inside a
module, so pagination is untouched.

**Modules are walked only when all three hold**: `entryType` is
`TimelineTimelineModule`, `displayType` is `VerticalConversation`, and the
entryId starts with `profile-conversation`. That triple scoping is deliberate.
"Walk into modules" as a general rule would also open the `who-to-follow-`
module — which is a module too, and is full of suggested accounts and their
pinned tweet ids. Broadening this predicate is exactly how the safety property
would get lost quietly, so there is a test asserting a who-to-follow module is
still rejected whole, and another asserting one *renamed* to
`profile-conversation` is still not walked.

**The gate is applied per item, unmodified.** A conversation module contains the
other participants by definition — the person being replied to is in the same
array, in the same shape — so this was the highest-risk parsing change in the
project. The author check is not relaxed anywhere.

### `dispensable` is a cross-check, not the gate

On the captured page the correlation was perfect: all 20 of my items were
`dispensable: false`, all 19 foreign items `dispensable: true`.

It is still **not** the gate and must never become one. Keying on it would mean
trusting a display hint with the question of whose posts we are about to
enumerate. It is used only as an independent detector: an item that is mine but
dispensable, or foreign but not, logs a warning naming the entry ids, because a
divergence means the model of these modules is wrong. There are tests asserting
that authorship still decides the outcome when the two disagree in **both**
directions.

### Verified against the live capture, not just fixtures

The real captured body was run through the real parser:

| check | result |
|---|---|
| items enumerated | **20**, all `kind: "reply"` |
| foreign author ids in the output | **0** (18 foreign authors on the page) |
| foreign tweet ids in the output | **0** (19 foreign tweets in the threads) |
| rejections | 19, every one `profile-conversation (FOREIGN AUTHOR)` |
| dispensable anomalies | 0 |
| bottom cursor | found at top level |

Nothing was rejected for an unexpected shape, which means the parser understands
the whole page rather than coincidentally surviving it.

### The account total is only safe from an ACCEPTED entry

The capture exposed a hazard that the fixtures would not have. **Every author
object carries its own `tweet_counts`** — the page held **19 different totals**,
from 14 to 359,228, one per participant in the threads.

Reading the account total off an ungated item would hand the completeness check
a stranger's denominator, and it would look entirely plausible. The total is
therefore taken only from an entry that has already passed the gate. Tested both
ways: the accepted-entry total is single-valued, and the stranger's count is
readable in isolation, which is precisely why the accepted-only rule matters.

### CLOSED: no bundle dump needed

The logged-in app still serves `main.<hash>.js` - the initiator column on the
live GraphQL calls reads `main.ae82e9d02d3328b`. The Vite-style
`entry-client-logged-out-*` naming applies **only to the logged-out shell**,
which carries no GraphQL operation table at all. So `discovery.js`'s
`/(api|main)\.[0-9a-f]+\.js/` priority ordering is still correct for the case
that matters, and the earlier concern about it is closed. No bundle dump is
required.

### Two-stream enumeration (BUILT)

Approved and implemented. `lib/streams.js` holds the planning and merge logic as
pure functions - it is a LEAF like everything under `lib/` - so the part that has
to be right (never enumerating an id twice, and noticing when it happens) is
testable without a browser. `tests/streams.test.mjs`, 33 assertions.

**Order.** Sequential, posts first. Sequential so rate-limit behaviour stays
attributable to one operation at a time; two concurrent streams would make a 429
impossible to attribute, and the observed ceiling is a thing this tool exists to
learn. Posts first because it is the larger set and the one whose parse is
validated against a real body, so an interrupted run keeps the more valuable
half.

**Skipping.** A stream whose kinds are all excluded by the filter is not walked
at all - `status: 'skipped'`, `endReason: 'skipped-by-filter'`. The rule is
symmetric: it applies to posts as well as reposts, because walking a stream
whose every entry is about to be filtered out is the same waste either way.
A skipped stream is surfaced as a PANEL BANNER at the same prominence as any
other reason a run is incomplete, and in the export's streams block. A scan that
quietly did less work than the user assumed is the same failure as an export
that reads as complete and is not.

An unresolved operation is `failed` / `no-operation`, never `skipped`. Those are
different problems and must not read the same.

**Counters.** `enumerated` / `matched` / `excluded` are cumulative across
streams because they describe one result set. `pages` is cumulative too, with
the per-stream breakdown on its own line, so a single number never jumps or
needs explaining:

```
stream 2 of 2 · reposts · UserRepostsTimeline · running   |   pages 7 (posts 4, reposts 3)
```

**Cross-stream duplicates are a DEFECT SIGNAL, not hygiene.** The streams are
tab-scoped and should be disjoint - a post cannot be a repost - so an id
arriving from both means our model of X's operations is wrong. The merge
dedupes (correctness first: the id appears once in the results, and the FIRST
stream to produce it keeps ownership), then counts the collisions, records the
ids, logs them, and shows them in the panel and the export. If that count is
ever non-zero it is a finding worth chasing. A silent dedupe would have hidden
exactly the evidence that something needs looking at.

Ordinary within-stream repeats are counted separately and are not a defect.

**Termination is PER STREAM, never collapsed.** Each stream ends for its own
reason, and the ~3,200 ceiling check runs per stream. A run can hit the ceiling
on posts and end on genuine cursor exhaustion on reposts; picking one of those
to report would be a claim about the other stream that was never measured. The
panel renders one report per stream and the export carries `endReason` and
`ceilingSuspected` per stream.

**Partial, not error.** If one stream fails partway, everything already
enumerated is kept - nothing is ever discarded - the run status becomes
`partial`, and the failed stream's report says how much it kept before failing.
Only a run where every stream failed with nothing enumerated is `error`.
401/403 remain fatal for the whole run: retrying an auth failure on another
stream is how an account gets flagged.

**Resume.** Pagination state lives per stream. On resume, streams marked `done`
are skipped entirely - stream A is never redone - and the first
`pending`/`running` one continues from its own cursor. A finished stream's
cursor is nulled so it can never "resume from the end" and report zero. The id
ownership map is rebuilt from the results, so cross-stream collision detection
survives a reload. Checkpointing stays after every page and writes the whole
streams array.

**Rate limits are per operation and NEVER merged.** `lib/api.js` keys its
observations by operation name. Different endpoints carry different budgets, so
an average or a sum across operations is wrong for both - and since the point of
hardcoding no requests-per-window figure is to learn the real ceilings, a merged
number would destroy the measurement it exists to take. The panel meter shows
the current stream's operation and that operation's own limit/remaining/reset;
the export records each separately.

**The export carries a `streams` block.** It is the pre-deletion record, so it
must say what it does NOT contain: which streams ran, which failed, which were
skipped and never walked, how each terminated, and the cross-stream duplicate
count. `complete` is true only when every stream is `done`. The CSV cannot carry
that block, so every CSV row carries `_stream` instead.

### Confirmed live response shape

Corrections against the phase-1 spec, all measured rather than assumed:

| thing | spec said | live response |
|---|---|---|
| instructions root | `timeline_v2.timeline` | **`timeline.timeline`** - no `timeline_v2` at all |
| instruction order | implicitly positional | `instructions[0]` is `TimelineClearCache`, **no entries** |
| cursor | `content.entryType` | `content.__typename === 'TimelineTimelineCursor'`, `cursorType: 'Bottom'`, opaque `value`, entryId prefix `cursor-bottom-` |
| counts | favorite/retweet/reply | all under `legacy`, plus `quote_count` |
| text / id | full_text / id_str | confirmed; `rest_id` also present and matches |
| created_at | - | `legacy.created_at`, `"Thu Oct 30 13:34:36 +0000 2025"` |
| media | - | `legacy.entities.media` / `extended_entities.media` |
| pinned | `TimelinePinEntry` | did **not** appear; the captured account has no pinned post |
| total | - | `user.tweet_counts.tweets`, usable as a progress denominator |

The root-key error is worth keeping visible: the predicted symptom of getting
it wrong was "page one returns zero posts", which is indistinguishable from an
empty account. It was written into this file as a thing to re-check before any
live run happened, and it was the first thing the live run disproved.

### SAFETY: the entries array contains other people's tweet ids

`collectEntries()` is a safety boundary, not a convenience. A live response
carries a `who-to-follow-` module of SUGGESTED ACCOUNTS, and every suggested
user brings `pinned_items.tweet_ids_str` with it - **other people's tweet ids,
in the same entries array as yours, shaped identically to yours**. A loose walk
that collects anything tweet-shaped harvests them, and a future execution phase
would then try to delete a stranger's post.

An entry is accepted only when all three hold:

1. `entry.content.entryType === 'TimelineTimelineItem'`
2. `entry.content.itemContent.__typename === 'TimelineTweet'`
3. `tweet.legacy.user_id_str === expectedUserId` (resolved via
   `UserByScreenName`, i.e. proven to be us)

Everything else is rejected and counted by entry-id prefix, surfaced in the
panel and the activity log rather than dropped silently. Modules are not walked
into at all. `expectedUserId` is mandatory and **fails closed**: without it the
parser accepts nothing, because a missing id must never come to mean "accept
everything".

`tests/parser.test.mjs` locks this down against a fixture containing a
who-to-follow module, a foreign-authored tweet entry, a `TimelineClearCache`
first instruction and a cursor entry. It asserts that no foreign id reaches the
output, that the gate fails closed, and that kind classification is per entry.
Run it with `node tests/parser.test.mjs` - no framework, no npm; the module is
loaded through a data: URL so a plain `.js` file imports as ESM without a
package.json. All ids in the fixture are placeholders.

### Response shapes to re-check against live data

These are the assumptions in `lib/enumerate.js` most likely to have drifted:

- **Timeline root.** Tried in order: `timeline_v2.timeline`, `timeline.timeline`,
  `timeline_response.timeline`. If a live response nests it elsewhere,
  `instructionsOf()` returns `[]` and the scan reports zero posts on page one —
  that symptom means this, not an empty account.
- **Tweet unwrapping.** `TweetWithVisibilityResults` wraps the real tweet under
  `.tweet`. Handled, but the `__typename` list may have grown.
- **Modules.** Conversation threads arrive as `TimelineTimelineModule` with
  `items[].item.itemContent`. Their internal `ShowMore` cursor is ignored on
  purpose — phase 1 wants your posts, not full reply trees.
- **Pinned.** Comes via a `TimelinePinEntry` instruction. It may not appear in
  `UserTweetsAndReplies` at all; if it does not, `excludePinned` never fires
  there and the pinned post is simply absent from the scan. Verify which.
- **Screen name in a normalized permalink.** Read from
  `core.user_results.result.legacy.screen_name`, falling back to
  `core.user_results.result.core.screen_name` — X moved this field once
  already. Falls back to the resolved handle, then to `i`, which still produces
  a working URL.

### Known risk to confirm on first live run: the bundle fetch and CORS

`lib/discovery.js` re-fetches an `abs.twimg.com` bundle URL harvested from the
page's own `<script>` tags, with `credentials: 'omit'`, to read the bearer and
query ids out of it. The extension holds **no host permission for
abs.twimg.com** - only `https://x.com/*` - so that fetch is an ordinary
cross-origin request and succeeds only because X's CDN serves those assets with
`Access-Control-Allow-Origin: *` (it has to; the page loads them with
`crossorigin`). That is believed true but is **unverified against live traffic**.

If it turns out CORS blocks it, the failure is loud, not silent: `discover()`
catches per-URL fetch errors, logs `skipped <file>: <error>`, and ends with
`missing: [bearer, ...]`, which the panel shows and which unlocks the manual
override.

**The fallback is NOT "add the host permission".** An earlier version of this
note said it was, and that was wrong. **In MV3 a content script follows the
HOST PAGE's CORS policy and does not inherit the extension's host permissions**
- the CORS bypass content scripts had under MV2 was removed in the MV3
transition, precisely so that a compromised page cannot borrow an extension's
reach. Adding `https://abs.twimg.com/*` to `host_permissions` on its own would
change nothing about a fetch issued from `content/executor.js`; it would look
like a fix, ship as a fix, and fail identically.

The actual fallback is two changes together:

1. Add `https://abs.twimg.com/*` to `host_permissions` - a real permission
   widening, so it needs a row in the README's permission table, not a quiet
   edit.
2. **Relocate the bundle fetch out of the content script and into
   `background.js`**, which is an extension context and therefore does get the
   CORS bypass that host permission grants. The executor asks for the bundle
   text over runtime messaging and keeps doing all the parsing itself.

Constraint on doing that, and it is not negotiable: the worker's half is a
**stateless fetch-and-return** - receive a URL, check it is an allowed host,
fetch with `credentials: 'omit'`, return the text. No discovery logic, no
caching, no job state, nothing that has to survive the worker being killed.
`lib/discovery.js` keeps every decision; the worker only holds the one privilege
the content script cannot have. The rule that `background.js` holds no state
still stands after this change, which is the test of whether it was done right.

Not implemented. Do it only if a live run actually shows the fetch blocked.

### Rate limits — the observed model

Measured, not assumed. Two live runs:

| operation | limit | requests | lowest remaining | 429s |
|---|---|---|---|---|
| `UserOriginalsTimeline` | 50 | 26 (25 pages) | **0** | **1** |
| `UserRepostsTimeline` | 50 | 8 | 41 | 0 |

**The model:** 50 requests per operation per **fixed ~15-minute window**,
separate buckets per operation, the counter refilling **at the window boundary
rather than sliding**. `x-rate-limit-reset` is an absolute timestamp for that
boundary, which is what makes a real countdown possible rather than a guess.

Separate buckets is the empirical case for keeping observations per operation:
spending 26 requests on one left the other's budget untouched.

### The 429 path is PROVEN, not assumed

The posts stream took a real 429 — `observed429s: 1`, `lowestRemainingSeen: 0`,
26 requests for 25 pages — **and still completed with all 480 items and
`endReason: empty-page`.** The adaptive backoff waited out the window, resumed,
and did not lose the queue.

That matters well beyond this scan: **it is the same path phase 2 depends on for
a WRITE endpoint.** A deletion run will be long, will certainly hit limits, and
must survive them without losing its place or double-acting. The read side has
now demonstrated that behaviour against a real limit rather than a simulated
one.

It does **not** license assuming the numbers carry over. `DeleteTweet` and
`DeleteRetweet` have their own unknown limits and must be discovered the same
way — read the headers, back off, log what was seen. A write endpoint that gets
this wrong costs more than a throttled scan.

### A rate-limit wait must never look like a hang

A stream sleeping out a 15-minute window used to show "Scanning..." with frozen
counters and stale reports. That is the same defect class as everything else
here: **a UI that looks identical whether it is working or dead.**

Now: the status line reads
`stream 3 of 3 · replies · UserRepliesTimeline · RATE LIMITED, resuming in 13:41`
with a countdown driven by its own timer (storage does not change during the
wait, so the normal repaint never fires — this is the one thing in the panel on
an interval rather than on state), the button reads "Rate limited - waiting",
a pulsing banner shows the window budget, and **the wait is interruptible** so
Stop works during it instead of being ignored for a quarter of an hour.

### Tooling

- **A pre-commit secret-scanning hook is installed** in this repo's
  `.git/hooks/pre-commit`. Git hooks are not pushed, so a fresh clone has to
  reinstall it; it comes from the studio's tooling, which is kept outside every
  repo.
- **It hard-fails, never warns.** Every failure path exits non-zero — including
  the ones where the scanner could not run at all, not just the ones where it
  found something. A safety net that reports success when it did not run is
  worse than no safety net, because it gets trusted.
- **It blocked its own author twice while this repo was being written.** Once on
  a false positive, once correctly. Neither commit landed until the text was
  changed; neither was bypassed, and no exemption was added to get past either.
  That is worth stating plainly rather than tidying away: a scanner that has
  never stopped anyone has not been tested, and this one has now been tested
  against the person most motivated to wave it through.

### Public-safety rules for this repo

Enforced from commit #1, because the repo is destined to go public and history
is not retroactively cleanable in any way that matters:

- No X handle, no numeric user id, no LAN addresses, no machine-specific
  absolute paths, no personal data anywhere in the tree.
- The user id is resolved **at runtime** and never persisted. It is not written
  to storage and does not appear in an exported report.
- `.gitignore` covers `surtr-report-*.json` / `.csv`, since scan output is
  personal data by definition.

---

## STAGE LOG

*Append only. Newest at the bottom.*

### 2026-09-06 — Phase 1 scaffold

- Created the repo **private**. `.gitignore` written and staged **before** any
  source file entered the tree.
- Installed the studio's pre-commit secret-scanning hook into `.git/hooks/`.
- Wrote the full phase-1 tree: manifest, background relay, executor, five lib
  modules, side panel.
- AGPL-3.0 `LICENSE` added.
- **No deletion code written.** No `DeleteTweet`, no `DeleteRetweet`, not
  commented out, not behind a flag.
- Added `web_accessible_resources` to the otherwise-verbatim manifest, for the
  reason recorded under KEY FACTS.
- Narrowed the README's `connect-src` claim to the one that is actually true,
  for the reason recorded under KEY FACTS.
- Not yet run against a live account.

### 2026-09-06 — Hardening pass

Four changes, none of them touching the scanner logic.

- **Corrected the CORS fallback note.** It said the fix for a blocked
  `abs.twimg.com` fetch was to add the host permission. That was wrong: in MV3 a
  content script follows the host page's CORS policy and does NOT inherit the
  extension's host permissions — that bypass was removed in the MV2 transition.
  Adding the permission alone would have looked like a fix and failed
  identically. The note now says the fallback is the host permission **plus**
  relocating the bundle fetch into `background.js` as a stateless
  fetch-and-return. Still not implemented; only do it if a live run shows the
  fetch actually blocked. The same correction was applied to the README's
  "where your data can and cannot go" section, which had inherited the same
  wrong reasoning.
- **`use_dynamic_url: true`** on the web-accessible-resources entry, so a stable
  extension id cannot be probed from an x.com page to fingerprint that Surtr is
  installed. Verified against a control run that the flag both takes effect and
  leaves the dynamic `import()`s working — table under KEY FACTS.
- **Dropped `unlimitedStorage` and `downloads`.** Exports now use a blob URL and
  a synthetic anchor click from the panel. Verified in a headless browser that
  `chrome.downloads` is genuinely gone from the panel's API surface and that
  both files still land, with the CSV correctly quoting a field containing a
  comma and quotes. README permission table is down to two rows.
- The studio's machine-level scanning tooling was hardened alongside this and
  gained a test harness. Details are kept outside this repo; see Tooling
  above for what is relevant here.

Still not run against a live account. That remains job one.

### 2026-09-06 — DEV.md made public-safe

This repo is going public **with its history intact**, which is unusual for the
studio: the normal go-public sequence starts a fresh `git init`, because a
handoff file written for a private project cannot be selectively cleaned out of
old commits afterwards.

The exception is deliberate. The commit trail here — including the pre-commit
hook stopping its own author — is part of the argument for a tool that asks
permission to delete your posts in bulk, and that argument is worth more than a
tidy history. But it only works if this file is public-safe **from here
forward**, not scrubbed at flip time. So the split happened now, at two commits,
while it was still cheap.

- Machine-level tooling detail — anything about the scanning setup beyond the
  fact that it exists and hard-fails — moved out of this file to a location
  outside every git working tree. Nothing was added to `.gitignore` for it: an
  ignore entry naming a private file is itself a pointer to that file.
- This file now keeps only Surtr's own technical state: stack, repo-relative
  paths, the manifest and README departures, the MV3 CORS correction, response
  shapes to re-check, what's next, and this log.
- The hook-blocked-its-author story stays, rewritten to name nothing. It is a
  feature of the project, not an incident to bury.
- Full history was audited first — every blob in every commit and both commit
  messages — for absolute machine paths, lab hostnames, LAN addresses,
  environment-variable names, handles and user ids. Nothing of that kind is
  committed.

Still not run against a live account.

### 2026-09-06 — Broken at load, and fixed: lib/ modules are now leaves

Loading the extension failed immediately with

```
Failed to fetch dynamically imported module:
chrome-extension://<uuid>/lib/discovery.js
```

and all four connection rows stuck on "not discovered".

**Cause: a module fetched through a `use_dynamic_url` URL cannot resolve its own
static imports.** `lib/discovery.js` had `import * as store from './store.js'`.
Ruled out first, in order: every import specifier in the graph is a sibling
directly under `lib/` (no nested paths, no bare specifiers); `lib/*.js` covers
all five flat files; and filename casing on disk matches the code exactly for
every module, checked against the git index rather than Explorer. So it was
neither casing nor a pattern gap.

Reproduced headlessly with a control, and the split is clean: the two LEAF
modules import fine under the flag, all three modules with a static import fail.
Full table under KEY FACTS.

**Fix, taking the option that keeps fingerprint resistance:** `use_dynamic_url`
is KEPT. Every `lib/` module became a leaf instead — `discovery.js`, `api.js`
and `enumerate.js` no longer import anything, and `content/executor.js` imports
all five and injects dependencies through a new `provide()` on each.
`enumerate.js` also lost an `import * as store` that nothing in the file used.

Verified by loading the extension both ways and, in the isolated world:
(a) importing all five modules, (b) running the executor's wiring, and
(c) actually using an injected dependency across a module boundary —
`discovery.applyManual()` writing through the injected store and reading back,
and `enumerate.userIdFromCookie()` calling through the injected api. All pass
under both variants, the guard on a missing dependency throws as intended, and
the dynamic URL is still a UUID, so the flag is still doing its job. The panel
export path was re-run unchanged and still passes.

**The earlier "verified working" for this flag was wrong**, and it is corrected
in place under KEY FACTS rather than quietly dropped: that test only imported
the two leaf modules, so it could not have caught this.

Still not run against a live account.

### 2026-09-06 — Operation rename: timeline candidates, and honest status rows

A live capture proved `UserTweetsAndReplies` is gone and the profile timeline
is now tab-scoped. Discovery resolves a prioritised candidate list, selects the
first one present, reports the rest, and passes the chosen name into
`walkTimeline()`. The panel distinguishes "in bundle" from "confirmed live",
because the whole reason this went unnoticed is that a retired operation's
query id stayed in the JavaScript and discovery kept calling that a success.

`lib/enumerate.js` parsing is untouched, pending the retweet answer. Only its
call site is parameterised. The bundle dump needed to answer that question
cannot be produced without a logged-in session — the logged-out shell carries
no operation table at all.

Still not run against a live account.

### 2026-09-06 — Parser aligned to the live response, plus a safety gate

Four corrections from a parsed live body, and one of them was a safety issue.

- **Root key.** `timeline.timeline`, not `timeline_v2.timeline`. The spec was
  wrong and the symptom would have been "page one returns zero posts".
- **Instructions are not positional.** `instructions[0]` is
  `TimelineClearCache` with no entries; entries are taken only from
  instructions whose `type` is `TimelineAddEntries`.
- **SAFETY: strict acceptance.** The entries array also contains a
  who-to-follow module whose suggested users carry other people's tweet ids.
  Three-part gate, fail-closed on a missing user id, rejects counted and
  surfaced. Locked down by `tests/parser.test.mjs`.
- **Kind per entry, never per operation.** "Originals" means not-retweets, not
  not-replies.

Also aligned: cursor shape, `quote_count`, and `user.tweet_counts.tweets` as a
progress denominator.

Multi-stream merging deliberately NOT implemented - waiting on confirmation of
which operation carries retweets.

Still not run against a live account end to end.

### 2026-09-06 — Third operation confirmed; discovery resolves two streams

`UserRepostsTimeline` is where retweets live - a new name we had not seen.
`UserOriginalsTimeline` is posts-only, `UserRepliesTimeline` is out of scope.

- Discovery now resolves TWO timeline operations from separate candidate lists
  and reports each independently, including which stream is missing by name.
  The panel has a row per stream, each with the same in-bundle / confirmed-live
  distinction.
- The bundle-dump question is CLOSED: the logged-in app still serves
  `main.<hash>.js`, so the existing priority ordering is correct.
- The safety gate is unchanged and applies to both streams. Added tests for the
  retweet case specifically: a retweet by me of a foreign-authored post must
  enumerate as exactly ONE item, mine, with `sourceTweetId` set to the foreign
  original - the gate keys on the OUTER author, never on the embedded original.
  The mirror case (a stranger's retweet) is still refused, and a non-retweet
  arriving in the reposts stream is classified honestly as a post rather than
  assumed to be a retweet.
- Multi-stream enumeration is NOT implemented. The shape is proposed under KEY
  FACTS and awaiting approval. Meanwhile a scan walks the posts stream only and
  logs a loud "RETWEETS NOT INCLUDED" warning, because a result set that looks
  complete and is not is worse than one that says what it is missing.

Still not run against a live account end to end.

### 2026-09-06 — Two-stream enumeration built

Approved shape implemented, with the three corrections.

- `lib/streams.js` (new, pure, leaf) holds planning and merge; 33 assertions in
  `tests/streams.test.mjs`.
- Sequential, posts first. Cumulative counters with a per-stream page
  breakdown. Partial, not error. Nothing enumerated is ever discarded. Resume
  skips finished streams with their cursors nulled. 401/403 fatal for the run.
- **Skipping a stream by filter is surfaced in the PANEL as a banner**, not only
  in the export. The rule is symmetric across both streams.
- **Cross-stream duplicates are counted, logged, panelled and exported.** The
  streams should be disjoint, so a non-zero count is a finding, not noise. The
  dedupe still happens - correctness first - it just is not silent.
- **Ceiling detection is per stream**, and termination is reported per stream
  with no collapsing into a single verdict for the run.
- **Rate observations are per operation and never merged**, in `lib/api.js`, in
  the panel meter, and in the export.

Two test assertions I had written were wrong and were corrected rather than the
code: one assumed the posts stream would not be skipped when only retweets are
wanted (it is, and should be), and one used too loose a regex to prove a clean
stream is not tarred with another stream's ceiling verdict.

Ready for a live two-stream dry run. Still not run against a live account.

### 2026-09-06 — Dry run validated the scanner, and moved the goalposts

Live two-stream run: 480 posts + 124 reposts, both clean, no 429s, zero
cross-stream duplicates, zero foreign authors, 22/22 retweets classified with
sourceTweetId. The scanner works.

It also enumerated 604 items on an account reporting 2,616, and reported that as
complete. Four things came out of that:

- **Real rate limits recorded**: 50 per operation, separate buckets, ~15 minute
  window. Deletion endpoints must NOT be assumed to match.
- **`reportedTotal` fixed.** It was read off the timeline response, which does
  not carry it; it lives on the user response. Null denominator is why nothing
  noticed the shortfall.
- **The completeness claim is fixed.** A clean per-stream endReason is no longer
  allowed to imply the account was enumerated, and `complete` in the export now
  requires no material shortfall as well as every stream finishing.
- **Replies added as a third stream.** posts/replies overlap is expected and is
  classified as such rather than reported as a defect.

The donate heart moved to the header, right-aligned, pointing at the donate
site, and was verified by a real dispatched click opening a tab - not from the
markup.

Suite: parser 41, streams 59, filters 23. Ready for a three-stream live run.

### 2026-09-06 — Three-stream run: rate-limit UI, and the total finally read from the right place

Live three-stream run. posts and reposts clean; replies enumerated nothing.

- **FIXED: a rate-limit wait no longer looks like a hang.** Live countdown to
  the window boundary, distinct button state, window budget, pulsing banner, and
  the wait is now interruptible so Stop works during it. Verified in a loaded
  panel by seeding the state and confirming the countdown MOVES on its own
  (13:41 -> 13:39 with no state change).
- **FIXED: reportedTotal.** Read from the author object embedded in the first
  accepted entry. My previous diagnosis was wrong and the previous fix was
  reported on unexercised code; `reportedTotalSource` is now recorded and logged
  so the next run proves it instead of me claiming it.
- **FIXED: unknown total no longer reads as complete.** `complete: false` with
  `unknownTotal: true`, and a LOWER BOUND banner.
- **RECORDED: the 429 path is proven** against a real 429, and the rate-limit
  model is now observed rather than guessed.
- **BLOCKED: replies.** `profile-conversation` modules; parser change held until
  a live body is captured. The gate failing closed here is correct behaviour.
- **UNPROVEN: the overlap counters.** `crossStreamDuplicates: 0` and
  `expectedOverlapDeduped: 0` mean nothing yet, because the replies stream
  produced nothing to collide with. Re-check both once conversation-module
  parsing lands.

Suite: parser 46, streams 62, filters 23.

### 2026-09-06 — Conversation modules: replies are reachable

`UserRepliesTimeline` wraps every reply in a `profile-conversation` /
`VerticalConversation` module. Those are now walked, with the three-part gate
applied per item unchanged, scoped so `who-to-follow` modules stay rejected
whole.

Verified against the captured live body, not only fixtures: 20 items
enumerated, all replies, **zero** foreign author ids and **zero** foreign tweet
ids in the output, 19 rejections all `FOREIGN AUTHOR`, cursor still top-level.

`dispensable` correlated perfectly with authorship on that page but is used only
as a cross-check; authorship decides, and tests assert that in both directions.

The capture also caught a hazard the fixtures could not: every author object
carries its own `tweet_counts`, 19 different totals on one page. The account
total is only ever read from an entry that passed the gate.

Still to re-check on the next live run (Finding 5): with replies enumerating,
`expectedOverlapDeduped` should become non-zero — UserOriginalsTimeline returns
entries with `in_reply_to_status_id_str`, so self-replies will appear in both
streams — while `crossStreamDuplicates` stays 0. Both were 0 last run only
because the replies stream produced nothing to collide with.

Suite: parser 68, streams 62, filters 23.

### 2026-09-06 — Window counter, a contradictory UI, and a build fingerprint

Two defects from a three-stream live run, plus a third found while fixing them.

- **The per-window request counter never reset**, producing `101 / 50 requests
  this window`. Boundary detection added; run-long totals kept separately;
  cached `remaining` invalidated after a rate-limit wait.
- **The panel showed two different truths about whether it was running.** The
  status line said `running` from a literal string while the button correctly
  said `Resume`. The run had died, and the error path never cleared
  `currentStream`. One `live` flag now drives all of it.
- **A page bound.** 133 pages was legitimate depth, not a loop, but nothing
  bounded the walk at all. `MAX_PAGES_PER_STREAM = 500` with a loud endReason.
- **A build fingerprint in the panel**, because a 45-minute run had been
  interpreted against code that was never loaded.
- **A NUL byte in a string literal**, found while verifying that fingerprint.
  Invisible in an editor, silently changed a hash, and made two implementations
  disagree. Now a named constant, read from one place, with a tree-wide
  control-byte test.

Suite: parser 68, streams 62, build 24, filters 23.

### 2026-09-06 — Phase 2 built, never run

Phase 1 validated live: 2,600 of 2,616 (99%), complete, zero foreign ids, two
rate limits recovered.

- **`expectedOverlapDeduped` came back 0.** The prediction that posts and
  replies would overlap was wrong, harmlessly. Recorded above; the counter
  stays as a defect detector.
- **`reportedTotalSource` fixed.** The value landed and the provenance field was
  never emitted in the export - a verified number is unverifiable again the
  moment nobody can say where it came from.
- **Phase 2 built**: discovery of the write operations, a separate POST path,
  verb selection, the arm gate, the kill log, per-item checkpointing, outcome
  grading that refuses to call an unconfirmed 200 a success, and the 5-item test
  run. 68 assertions in `tests/execute.test.mjs`.
- **The README no longer says this build cannot delete**, because it can. The
  panel's header badge used to promise "no deletion code exists in this build"
  and now reports live state - a stale reassurance is worse than none.

NOT RUN against any account. The 5-item test is the next step and full runs are
locked until it is done and confirmed.

Suite: parser 68, streams 62, execute 68, build 26, filters 23.

### 2026-09-06 — The DeleteTweet success shape, confirmed

The 5-item test ran and was verified by hand: all 5 targets gone, 4 controls
untouched, account total 2616 -> 2611. 5 dispatched, 0 failed, no 429s at ~1.6s
spacing.

- **DeleteTweet's success shape is encoded** from the three captured responses.
  A matching 200 now grades as SUCCEEDED; a non-matching 200 grades as FAILED,
  because the shape is known and silence is no longer ambiguity.
- **DeleteRetweet stays unverified.** Not assumed to mirror DeleteTweet. Shapes
  are keyed per operation so knowledge about one cannot leak into a claim about
  the other, and the panel names which is unconfirmed.
- **Raw-body retention fixed.** Keeping the first three of a run retains the
  responses already understood and drops the one that matters. Now: any
  non-success outcome at any position, plus the first three, capped at 4,000
  characters with the truncation marked.

Suite: parser 68, streams 62, execute 94, build 26, filters 23.

### 2026-09-06 — The kill log auto-downloaded on panel open

A privacy defect, fixed. Five files containing deleted-post text were written to
Downloads by opening the panel, after one run. A module-scope guard reset on
every load, so a rehydrated completed run read as a fresh completion.

The auto-offer now needs a terminal status, a run dispatched by THIS panel
session (tracked in memory, deliberately not persisted), and no persisted record
of a previous offer. Manual downloads unchanged.

Audited every other render-path side effect: one more instance of the same
state-vs-event shape, harmless, in the manual-override auto-open. Everything
else is behind a click.

Third instance of state-mistaken-for-transition in this project, so it is now
written up as a pattern rather than three separate bugs.

Suite: parser 68, streams 62, execute 111, build 26, filters 23.

### 2026-09-06 — DeleteRetweet variable name

A 422 named the problem exactly: `["variable","source_tweet_id"]`. Verb
selection and target were correct; a shared variables builder sent DeleteTweet's
key name.

- **Per-operation variables tables.** No shared builder, no inheritance, key
  sets asserted non-overlapping. DeleteTweet's proven shape untouched.
- **DeleteRetweet sends only `source_tweet_id`.** `dark_request` is NOT assumed
  from DeleteTweet - the reachable bundles contain none of these names, checked
  rather than guessed, so the next 422 names the next variable if there is one.
- **DeleteRetweet's success shape remains unconfirmed.** A 422 tells us nothing
  about success.
- Recorded: the run correctly stopped after one failure, and the raw-body
  retention fix paid for itself on its first live use - the body that named the
  bug sat at position 6 and the old rule would have dropped it.

Suite: parser 68, streams 62, execute 125, build 26, filters 23.

### 2026-09-06 — Consecutive-failure circuit breaker

The first-item guard only caught runs broken from the start. Now:

- **5 consecutive failures aborts**; success or already-gone resets the counter.
- **A single GRAPHQL_VALIDATION_FAILED, or any non-429 4xx, aborts
  immediately** - a wrong request shape does not fix itself by trying again.
- **429 and unverified are neutral**: a rate limit cannot launder a failure
  streak, and an unverified outcome cannot clear one. 5xx counts toward the
  streak rather than aborting alone.
- **An aborted run never reports as complete** in the counters, the banner or
  the export.
- The breaker is per-run and in memory, the deliberate opposite of the kill-log
  offer flag. Written up above as "persist what suppresses, reset what
  triggers".

Suite: parser 68, streams 62, execute 172, build 26, filters 23.

### 2026-09-06 — DeleteRetweet shape confirmed, and made stricter

10 identical live responses. `source_tweet_id` alone was sufficient.

- **The response key is `unretweet`**, not `delete_retweet` - read off a live
  body, never inferred from the operation name, and tested so it stays that way.
- **Stricter than DeleteTweet on purpose**: this response echoes the id it acted
  on, so the echoed `rest_id` is verified against what we sent. DeleteTweet's
  returns an empty tweet_results and has nothing to verify, so it is left alone.
  Verify what the response gives you; do not normalise the two.
- **A mismatched echo is a FAILURE and aborts the run immediately**, logged with
  both ids.
- **Limitation recorded**: for retweets, already-gone is indistinguishable from
  success, so the deleted count means "requests that succeeded".
- **buildPlan deduplicates by (operation, target)**, so one run cannot dispatch
  the same target twice even if two items resolve to it.
- Hazard asserted: a tweet id does not survive `Number()`.

Suite: parser 68, streams 62, execute 121, build 26, filters 23.

### 2026-09-06 — Kill log: reminder instead of automatic download

The auto-download is removed entirely rather than gated. The helpers are
deleted, the persisted flag and its storage key are gone, and a test asserts
they stay gone so a re-introduction fails rather than passing review.

In their place the panel shows a prominent banner when a run terminates, above
the download buttons, saying the log has not been saved and is the only record.
After a deliberate download it becomes a quieter confirmation; after a reload it
warns again, because the panel cannot know the file was kept.

The principle, now stated once rather than re-derived: the user decides when
personal data hits the filesystem, always. Gating an automatic write does not
make it a decision.

**The posts 5-item test passed**: 5 dispatched, **5 DELETED**, 0 unverified, 0
failed. DeleteTweet's encoded success shape grades live responses correctly.
X's reported account total dropped 2611 -> 2606, independently confirming both
test runs landed - which also means the account total is a usable external check
on a run, not just a completeness denominator.

Suite: parser 68, streams 62, execute 122, build 26, filters 23.

### 2026-09-06 — A 429 is never a failure

Final run: 447 dispatched, 445 deleted, 2 "failed" - both 429s, both items still
live. The backoff ran; the retry never did.

- **429 now grades as DEFERRED and the item is re-dispatched**, bounded at 3
  attempts, each after a full window wait. Exhausted retries stay DEFERRED:
  not attempted successfully, still exists, a re-scan finds it.
- **Counted and surfaced separately** - never folded into deleted or failed, and
  the panel says the items still exist and that this is not an error.
- **An interrupted item is DEFERRED too**, not failed.
- **Second instance found by the same audit**: a read-path 429 consumed a
  feature-negotiation round, so enough of them would throw a misleading
  "negotiation did not converge". Now counted separately and bounded.
- **Coverage floors added to every test file**: an earlier edit had silently
  deleted ~50 assertions and the suite still read ALL PASS.

Reconciliation of the log, for the record: 473 entries = 455 succeeded, 15
unverified (the pre-encoding retweet tests), 3 failed (the DeleteRetweet 422 and
these two 429s - the latter two would now be DEFERRED and retried).

Suite: parser 69, streams 63, execute 188, build 27, filters 23.

### 2026-09-06 — The echo check needs a third grade

A 119-item repost run: 119 dispatched, 118 succeeded, 1 graded FAILED on a
response that had actually worked - `source_tweet_results` was empty because the
original post no longer exists.

- **Third grade added.** Matching id -> succeeded; different id -> failed and
  abort (unchanged); absent id -> `unverified-ok`, its own column, not a
  failure, does not abort, does not feed the breaker.
- **An absent answer is not a negative answer** - the same error class as
  grading a 429 as a failure. Second instance, so it is written up as a question
  to ask of any check: what does this do when the thing it inspects is not
  there?
- **The emptiness asymmetry is recorded**: for DeleteTweet an empty result IS
  the success shape; for DeleteRetweet it is a legitimate absence. Same empty
  object, opposite meanings, which is exactly why the shapes are keyed per
  operation and must never be normalised.
- **Observed live**: 5 of the 119 were already unretweeted by earlier tests and
  still returned success - the already-gone limitation, confirmed in practice.

Reposts tab is now empty.

Suite: parser 69, streams 63, execute 206, build 27, filters 23.

### 2026-09-06 — UI pass for public release

Presentation only. `git diff` touched `ui/panel.html`, `ui/panel.css` and
`ui/panel.js` and nothing else: no gate, grade, threshold or check was altered,
and `lib/` and `content/` are byte-identical.

- **Five sections**: Connection, Filters, Scan, Delete, Activity log.
- **Diagnostics collapsed** inside Connection - build fingerprint, query ids,
  "in bundle" / "confirmed live", operation names, manual override, all present
  and unchanged, just not the first thing anybody sees. The visible connection
  line is a plain ready / not-ready state.
- **The header badge is gone.** The armed state is shown on the Delete section
  itself, where it is in context rather than either shouting or lying.
- **The 5-item flow is intact and recast**, not weakened: same button, same
  preview of exactly which five, same attestation checkbox, same lock on the
  full run. It reads as "Start with 5 - the careful way to begin" rather than
  as a test harness.
- **The matches list is a list, not a table.** Six columns could not be read at
  380px; the text was cut off and needed horizontal scrolling. It is a safety
  surface - it is how somebody recognises a post they did not mean to lose - so
  it now shows date, kind, engagement, a link and a wrapped three-line preview
  with no horizontal scroll at all. Same treatment for the five-item preview.
- **Colour means something now**: red for wrong or irreversible, amber for a
  warning that changes what the results mean, green for confirmed good, grey for
  routine. Per-stream reports were amber and are now grey - they are
  information, and everything looking urgent is the same as nothing looking
  urgent.
- **Empty states everywhere**, saying what to do first.
- Every incompleteness banner, the kill-log reminder and all counters
  (deferred and unverified-ok included) are untouched in substance.

The Delete section is now VISIBLE before a scan rather than absent, but its
controls still do not render - the copy explains why instead of the section
silently not existing.

Verified in a loaded panel at 380px: five sections in order, diagnostics
collapsed with all ten rows inside, Delete inert before a scan, the five-item
preview listing exactly five, the full run locked until armed AND counted AND
attested, a wrong count re-locking it, and zero horizontal overflow.

Suite: parser 69, streams 63, execute 206, build 27, filters 23.

### Scope is not shortfall

`completeness()` compares what a run enumerated against what X reports for the
account. That comparison is only valid when every stream was walked. Under a
kind filter whole streams are never read, and comparing against the ACCOUNT
total then reports the user's own filter back to them as a gap: a deliberate
posts-only scan showed

> INCOMPLETE: 23 of 2035 items X reports for this account (1%). 2012
> unaccounted for.

in red. Every one of those 2,012 was a reply or repost the user had asked
Surtr not to look at. The sentence was false, and it was false on a routine,
correct run.

**Severity has to mean something.** A red banner on an ordinary correct scan
does not just annoy - it trains the user to skip red, and then the shortfall
warning that matters, the one that says a stream hit the ceiling and older
posts are unreachable, does not work when it is needed. Spending severity on
the routine case is how you disarm it for the real one.

So the fix is in the arithmetic, not the colour: streams with status
`SKIPPED` are excluded from the comparison. A stream the user excluded is
**scope**, and it is reported as scope - "reposts and replies were not
included" - never as incompleteness.

### The weaker claim has to sound weaker

X publishes ONE account-wide total and no per-stream totals. So a filtered
scan has no in-scope denominator, and cannot be checked against a number at
all. The honest claim is strictly weaker than the full-scope one, and the two
cases are deliberately worded so they cannot be confused:

| scope | claim |
|---|---|
| all three streams | `604 of 2616 reported by X (23%)` - a real comparison |
| filtered | "every stream Surtr walked ran to completion - no ceiling hit, no failure, no cursor exhaustion", explicitly NOT a claim about the account, and no percentage |

`completeness()` returns `scopeFiltered`, and the filtered branch returns
`percent: null` and `shortfall: null` rather than a softened number - any
figure there would be arithmetic against the wrong total. The wording lives in
a `claim` field so the panel renders it rather than deriving a second copy.
The account total is still reported and still shown, in Scan details, with its
provenance; it is simply no longer used as a denominator for something it does
not denominate.

A stream that WAS walked and came up short - ceiling, failure, page bound,
repeated cursor - still warns, filtered or not. That is what `streamRanClean()`
decides, and it is the only thing that can raise red on a filtered scan.

### A second test that encoded the bug

`tests/streams.test.mjs` asserted, in as many words:

```js
ok(c.complete === false && /skipped/.test(c.reason || ''),
   'a skipped stream blocks complete and is named as the reason');
```

That is the defect written down and locked in. It is the **second** assertion
in this one file to do that - the first said `complete === true` when the
account total was unknown. Both were written by the same hand as the code they
were checking, in the same sitting, from the same wrong idea. A test written
alongside its implementation inherits its assumptions; it catches drift later,
but it cannot catch a mistake it shares. Worth remembering the next time a
suite passing feels like evidence the thinking was right.

### One rule, one place

The panel had its own hand-copied transcription of `shortfallBanner()`'s text
inline in `renderJob`. Fixing the wording in `lib/` would have left the UI
still saying the old thing - the same drift that put a NUL byte in a duplicated
separator constant. The panel now calls `streams.shortfallBanner(c)` and the
duplicate is gone. This is also why the in-scope arithmetic went into `lib/`
rather than being re-derived in `ui/panel.js`: a second copy of a rule is a
second thing that can be wrong on its own.

### 2026-09-06 - Scope is not shortfall; the scan panel says one thing

- **`completeness()` gets an in-scope denominator.** SKIPPED streams are out of
  the comparison. Everything in scope walked clean => complete, no red. Only
  `completeness()` changed; `COMPLETENESS_TOLERANCE`, every gate and every
  grade are untouched.
- **The filtered claim is deliberately weaker and worded so**, with no
  percentage and an explicit "this is NOT a claim that your account holds
  nothing else". It is on screen, not just in the code.
- **One summary line** replaces the banner stack: what was scanned, how many
  found, how many match, what was left out. Per-stream reports, ceiling notes,
  operation names, skipped-entry counts and X's account total all moved into a
  collapsed **Scan details** - present and unchanged, one click away.
- **X's account total was nearly lost**: it had only ever reached the screen
  inside the red banner, so suppressing that banner would have taken the number
  with it. It is now rendered in Scan details with its provenance.
- **The panel's duplicated copy of `shortfallBanner()` is deleted.**
- One existing assertion changed because it encoded the defect - flagged, not
  quietly rewritten.

Suite: parser 69, streams 85, execute 206, build 27.
Harnesses: `ui_pass_test.mjs` ALL PASS, new `scan_panel_test.mjs` ALL PASS
(20 assertions across a filtered scan, a genuine shortfall, and a filtered scan
that hit the ceiling).

### The same wrong reading, one function over

`overallStatus()` returned `partial` for done + skipped, so a deliberate
posts-only scan reported **"streams finished (partial)"** - telling the user
something had gone half-done when nothing had. It is the completeness defect
again, in a different function: a stream the user excluded read as a gap.

PARTIAL now means what it says: a stream FAILED, was stopped, or came up short.
A skipped stream is scope and does not affect the verdict.

The judgement is `streamRanClean()`, the same predicate `completeness()` uses,
deliberately shared so the two cannot drift apart on what "finished" means -
which is the whole reason the in-scope rule went into `lib/` rather than being
re-derived per caller.

**One behaviour tightened beyond the ask.** The old rule looked only at
`status`, so a stream that reached X's ~3,200 ceiling was `DONE` and the run
reported `done`. Under `streamRanClean()` that is now `partial`, which is the
strict direction and consistent with what the per-stream report has always
said. No gate moves: `renderExec` accepts `JOB_DONE` and `JOB_PARTIAL`
identically, so nothing becomes armable or unarmable either way.

### 2026-09-07 - overallStatus stops calling a filtered scan half-done

- `overallStatus()`: skipped-by-filter no longer forces `partial`; reuses
  `streamRanClean()` rather than re-deriving the rule.
- A ceiling, page bound, repeated cursor, user stop or failure still means
  `partial`. Every stream filtered out still means `partial` - nothing ran.
- One existing assertion changed because it encoded the old reading. That is
  the **third** in this file, which is why it is now a standing gotcha rather
  than a per-incident note.

Suite: parser 69, streams 91, execute 206, build 27.
