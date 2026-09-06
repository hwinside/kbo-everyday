# GIPHY request budget

## Goal

Reduce avoidable GIPHY Search API requests while keeping the integration compliant with GIPHY's standard-integration rules.

## Constraints

- Search, Trending, and media requests remain direct browser-to-GIPHY requests.
- Do not add an application proxy, CDN cache, server cache, localStorage cache, service worker cache, or stored index of GIPHY results/media URLs.
- Keep the existing `Powered by GIPHY` attribution.
- A partner-operated cache is out of scope until GIPHY grants written approval and provides the required revalidation contract.

## Request policy

- Each GIF/sticker panel mount may issue one initial Trending request.
- Search starts only for a trimmed query of at least two characters.
- Search debounce is 700 ms.
- A component may have only one active GIPHY request. A new query aborts the prior request.
- An identical request already in flight is not started again.
- Clearing a search does not automatically request Trending a second time.
- Requests use browser `cache: "no-store"`.
- A 429 response starts a client-wide, context-specific cooldown. Use `Retry-After` when valid, otherwise 60 seconds.
- No automatic retries are allowed. Existing visible results remain on request errors.

## Keys

- GIPHY usage is split by platform (`WEB`, `IOS`, `ANDROID`) and section
  (`COMMUNITY`, `GAME_CHAT`, `STICKERS`), for nine keys in total.
- Community comments and GameChat share the `GifPicker` implementation but pass distinct request contexts.
- The nine primary variables follow
  `NEXT_PUBLIC_GIPHY_{WEB|IOS|ANDROID}_{COMMUNITY|GAME_CHAT|STICKERS}_API_KEY`.
- `NEXT_PUBLIC_GIPHY_GIFS_API_KEY`, `NEXT_PUBLIC_GIPHY_STICKERS_API_KEY`, and
  `NEXT_PUBLIC_GIPHY_API_KEY` remain temporary fallbacks so an incomplete rollout does not disable the UI.
- **Deployment prerequisite:** provision and register all nine primary variables in Vercel before production rollout.
  Until that is done, fallback traffic can still share the legacy 100 requests/hour budget, so this change alone
  does not increase production capacity.

## Attribution

- `Powered by GIPHY` remains rendered in both `GifPicker` and the editor `GiphyPanel`.

## Observability

- Record request start/result events with context, endpoint, status, latency, offset, and a SHA-256 query hash.
- Never record the API key or raw query.

## Acceptance

- Initial panel mount: exactly one GIPHY API request.
- One settled search term: exactly one Search request.
- Identical concurrent request: exactly one network request.
- During cooldown after 429: zero additional requests.
- No server proxy or persistent GIPHY response/media cache.
