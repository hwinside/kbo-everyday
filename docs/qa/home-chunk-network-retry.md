# Home chunk recovery follow-up (#1596)

## Confirmed runtime behavior

Next 16.1.6 production runtime (`turbopack-2936a073a1662566.js`, captured
2026-11-02 from keubo.fan) caches a resolver by URL. `loadingStarted` returns
that same promise on subsequent loads; `reject` does not evict it. A second
`import()` therefore does not retry the network. Re-inserting a script AFTER
rejection cannot settle an already-rejected promise either.

The fix listens only while home imports are active. On the first same-origin
Next JS resource error, capture prevents the original loader from rejecting.
After 1s it appends one cloned script, retaining the deployment query and adding
`__kbo_chunk_retry=1`. Successful registration resolves the original loader;
second failure or 10s timeout forwards an error to the original script. It does
not edit private runtime maps. Non-resource application errors are untouched.
One retry per URL per document, shared across concurrent sections. SSR no-op.
Existing exhausted-import isolation and guarded reload remain in effect.

## Module mapping (captured production build, NOT stable across new builds)

HomeClientShell (`f1716a06f224b498.js`) calls these import loader modules:

- NewsCarousel → 731465 → `29c17e375270a4d0.js`, `cf81d4bee11993f4.js`, `95fc92001e859799.js`
- HomeHighlights → 682790 → `349fab4756a72c55.js`
- CommunityLatestPosts → 815089 → `95fc92001e859799.js`, `9075ad3c30b3ba04.js`, `fd5c06396c1d67f0.js`

`ed689d389c14888b.js` is an INITIAL shared chunk referenced by the home HTML,
not just the community lazy section. It includes the above import-loader
modules, home section preference labels, block hooks, icons, player helpers,
AIAnalysis and onboarding code. Its failure can prevent HomeClientShell from
initializing at all, before HomeSectionBoundary can catch a lazy rejection.
ClientErrorMount installs non-capture `window.error` in a React effect; a
non-bubbling script resource error before mount is not covered by that listener.
This explains a reporting gap, not proof of a successfully mounted home with
only its community section missing. Initial bootstrap recovery remains outside
this narrowly scoped change.

## QA evidence interpretation and next run

Reviewer `ab2.json` has target `ed689d389c14888b.js` for ALL failure scenarios;
body text length is 65 vs 975 normally, with no pageerror. That file does not
measure the three lazy imports above. The accompanying `qa-pr1596-ab2.mjs`
selects chunks by community strings and checks `body.slice(0,0)` for exclusions
(always empty); it does not use `lazySet` to select the target.
Do not repeat that selector unchanged. Use the preview build's exact import
mapping and assert the score/home shell actually hydrated before injection.

Independent reviewer QA should compare baseline and preview:

1. A displayed section's first script request fails, retry succeeds: two actual
   browser requests (same pathname, preserved dpl, retry query), section renders,
   no boundary report or reload. Route counting must ignore query differences.
2. Persistent failure: exactly one retry, isolated section, existing bounded
   reload fallback; normal home content remains usable.
3. Concurrent sections sharing a failed chunk: one retry, both recover.
4. Ordinary render error: no script retry. External resource: no interception.
5. Actual iOS app background/foreground and offline/online: separately record
   real-device status; jsdom runtime regression is NOT iOS/end-user QA.

## Remaining limitations

- Initial shell/bootstrap chunks (including ed689d) are not rescued by a helper
  installed only when lazy home imports start.
- Existing 60s reload guard is unchanged; repeated reload risk remains.
- Runtime fixture tests prove request/registration semantics, not real WebKit
  script scheduling/CSP/network behavior. Preview and iOS QA are required.
- No production deployment or error-rate improvement is claimed by this PR.
