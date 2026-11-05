# Next static assets: bypass Service Worker

`public/sw.js` now returns without respondWith for `/_next/static/`.
The browser/CDN immutable HTTP cache handles these hashed build assets directly.
SW will not clone/cache their response or synthesize an Offline 503. This applies
to JS, CSS and fonts, preserving query strings and browser network behavior.

Cache v20 replaces v19 on activation to release old SW-owned build assets.
Existing skipWaiting/clients.claim, API/auth exclusions, other images/scripts,
and web-push handlers remain unchanged. Already open clients must actually
receive the new worker before the change can have an effect.

Tradeoff: Next assets no longer have SW Cache Storage offline fallback; browser
HTTP caching may help but offline availability is not guaranteed. This app has
no offline page precache. Existing guarded chunk recovery remains necessary.

Author verification: `node --test tests/sw-next-static-bypass.test.cjs` (4 cases),
`node --check public/sw.js`, `git diff --check`. Tests cover bypass with deployment
queries, no SW fetch/cache calls, unaffected non-Next assets and cache activation.

Independent QA: use a SW-enabled browser, wait for v20 activation/controller,
verify Next assets are not fromServiceWorker while icons still are. Check normal
home, online/offline transitions, update from v19, and push-handler regression.
Run route-based chunk injection separately with serviceWorkers:'block'; it does
not validate the live SW path. Actual WKWebView and traffic-normalized production
error reduction remain unverified. This is a plausible risk reduction, NOT proof
that SW caused the observed iOS errors.

Rollback: revert through a new reviewed PR; use a fresh cache version and confirm
worker activation. Do not assume reverting app HTML instantly changes active SWs.
