/**
 * Next 내부(app-render)는 모듈 로드 시점에 `globalThis.AsyncLocalStorage` 를 **한 번만 캡처**한다
 * (async-local-storage.js 의 `maybeGlobalAsyncLocalStorage` const). Node 스크립트에서 next/server
 * 계열을 import 하기 **전에** 이 shim 이 먼저 실행돼야 한다 — 게이트 파일의 첫 import 로 둘 것.
 * (늦게 주입하면 캡처가 이미 false 라 unstable_doesMiddlewareMatch 로드가 Invariant 로 죽는다 — 실측.)
 */
import { AsyncLocalStorage } from "node:async_hooks";

(globalThis as unknown as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;
