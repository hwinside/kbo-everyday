# Android OAuth cookie persistence regression

Scope: `OAuthBrowserPlugin.open` flushes the existing WebView cookie store before
launching a Custom Tab. No second verifier store, JS API change, or iOS change.
A new Android binary is required; a web deployment cannot patch installed apps.

## Independent device QA (삼식)

Use an isolated emulator/test profile, no personal provider account. Compare the
main baseline and this PR's exact-head debug APK against the same WebView/provider.
For each run, start a fresh OAuth attempt; inspect only cookie/attempt presence.
Never record cookie contents, verifier, tokens, or full authorization URLs.

1. Control: open Kakao OAuth, return without killing; verifier remains available.
2. While the Custom Tab is foreground, `am kill fan.keubo.app` after 3 seconds,
   then relaunch. Repeat with 10 seconds, plus 40 seconds as a control.
   Expected: verifier survives all three; sessionStorage attempt can disappear.
3. Supply a synthetic callback code after each relaunch. Expected: exchange reaches
   the token server and rejects the fake code, not a local missing-verifier error.
   Do not infer success from `pkce` classification alone: #1593 groups missing
   verifier and server rejection. Inspect the local error kind/network boundary
   without logging request payloads. No real signup success is asserted here.
4. Repeat the short-kill case twice. Include immediate browser close/cancel and a
   second fresh login to detect stale verifier reuse. Check Google/Apple launch
   ordering and the Chrome-unavailable default-browser fallback.
5. Observe launch latency/UI responsiveness: flush is synchronous and can perform
   disk I/O. If it throws, the existing rejection path must prevent browser launch;
   don't silently continue with unpersisted cookies.

The baseline reproduced loss at 3/10 seconds but not 20/40 seconds. This is a
reproduced failure mechanism, not proof that historical user failures used it.
Kill before the flush finishes, device-wide storage failures, iOS, and real-account
end-to-end authentication are outside this regression's completion claim.

Rollback: revert the native change and distribute a replacement Android binary.
