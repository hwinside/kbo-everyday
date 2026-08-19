/**
 * 클라이언트 요청 dedupe 공용 모듈 (PR #1253).
 *
 * Observability 실측(8/19) 기준 register-start/register-device//api/me가 매 부팅·
 * 이벤트마다 동일 요청을 반복 발사해 Edge Requests·Fluid CPU를 소모하는 것을 막는다.
 * 순수 로직만 두어 게이트(scripts/qa/client-dedupe-gate.ts)에서 storage·clock 주입으로
 * 검증 가능하게 한다. React/Capacitor/supabase 의존 금지.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

// ── TTL signature 캐시 ─────────────────────────────────────────────
// "이 signature로 TTL 내 성공 등록했다"만 기억. 실패·skip은 기록하지 않아
// 다음 기회에 자연 재시도된다. storage 불가 환경은 dedupe 없이 no-op.
export interface SignatureCache {
  has(sig: string): boolean;
  put(sig: string): void;
}

export function createSignatureCache(
  key: string,
  ttlMs: number,
  deps?: { storage?: () => StorageLike | null; now?: () => number },
): SignatureCache {
  const getStorage = deps?.storage ?? defaultStorage;
  const now = deps?.now ?? Date.now;
  return {
    has(sig: string): boolean {
      try {
        const raw = getStorage()?.getItem(key);
        if (!raw) return false;
        const parsed = JSON.parse(raw) as { sig?: unknown; at?: unknown };
        if (typeof parsed.sig !== "string" || typeof parsed.at !== "number") return false;
        return parsed.sig === sig && now() - parsed.at < ttlMs;
      } catch {
        return false;
      }
    },
    put(sig: string): void {
      try {
        getStorage()?.setItem(key, JSON.stringify({ sig, at: now() }));
      } catch {
        /* storage 불가 — dedupe 없이 기존 동작 */
      }
    },
  };
}

// ── single-flight ──────────────────────────────────────────────────
// 같은 key의 동시 호출을 하나의 promise로 합친다(시작 순간 중복 방어 — 삼순 #1253).
export interface SingleFlight<T> {
  run(key: string, fn: () => Promise<T>): Promise<T>;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  let current: { key: string; promise: Promise<T> } | null = null;
  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      if (current && current.key === key) return current.promise;
      const promise = fn().finally(() => {
        if (current?.promise === promise) current = null;
      });
      current = { key, promise };
      return promise;
    },
  };
}

// ── 등록 응답 캐시 가능 판정 ───────────────────────────────────────
// 삼순 #1253 blocker②: res.ok여도 서버가 "저장/후속처리 미완"을 알린 응답은
// 캐시하면 안 된다(긴급공지 catch-up 실패 시 24h 재시도 봉쇄 방지).
//  - skipped: register-start가 W3c 토글 off로 저장 skip
//  - cacheable === false: register-device가 urgent-notice catch-up 실패를 보고
export function shouldCacheRegisterResponse(resOk: boolean, body: unknown): boolean {
  if (!resOk) return false;
  const b = body as { skipped?: unknown; cacheable?: unknown } | null | undefined;
  if (b && b.skipped) return false;
  if (b && b.cacheable === false) return false;
  return true;
}

// ── 프로필 로드 ledger (generation fencing) ─────────────────────────
// 삼순 #1253 blocker①:
//  - no-session/SIGNED_OUT 시 invalidate() → 같은 UID 재인증이 10분 내여도 재조회.
//  - force는 generation을 올려 기존 in-flight를 supersede — 늦게 도착한 옛 응답은
//    isCurrent()=false라 최신 profile을 덮지 못한다.
//  - fresh 마커는 "성공 + 여전히 현재 세대"일 때만 기록 → force 실패 시 마커가
//    남지 않아 다음 시도가 막히지 않는다.
export interface ProfileLoadLedger {
  /** run(isCurrent)은 프로필 set 성공 시 true. 모든 상태 반영 전에 isCurrent() 확인 필수. */
  load(userId: string, force: boolean, run: (isCurrent: () => boolean) => Promise<boolean>): Promise<void>;
  /** 세션 소실·로그아웃 시 호출 — fresh/in-flight 전부 무효화 + 세대 교체. */
  invalidate(): void;
}

export function createProfileLoadLedger(
  ttlMs: number,
  now: () => number = Date.now,
): ProfileLoadLedger {
  let gen = 0;
  let fresh: { userId: string; at: number } | null = null;
  let inFlight: { userId: string; promise: Promise<void> } | null = null;

  return {
    invalidate(): void {
      gen += 1;
      fresh = null;
      inFlight = null;
    },
    load(userId, force, run): Promise<void> {
      // 다른 유저의 잔존 상태는 즉시 무효화(계정 전환 레이스 방어)
      if (fresh && fresh.userId !== userId) fresh = null;
      if (inFlight && inFlight.userId !== userId) {
        gen += 1; // 옛 유저 in-flight의 늦은 응답이 새 유저 profile을 덮지 못하게
        inFlight = null;
      }
      if (!force && fresh && fresh.userId === userId && now() - fresh.at < ttlMs) {
        return Promise.resolve(); // fresh — 서버 호출 생략
      }
      if (!force && inFlight && inFlight.userId === userId) {
        return inFlight.promise; // 동시 호출 공유
      }
      if (force) {
        gen += 1; // 기존 in-flight supersede — 옛 응답 적용 차단
        fresh = null; // force 실패 시 fresh 마커가 남지 않도록 선제 제거
        inFlight = null;
      }
      const myGen = gen;
      const isCurrent = () => myGen === gen;
      const promise = run(isCurrent)
        .then((ok) => {
          if (ok && isCurrent()) fresh = { userId, at: now() };
        })
        .finally(() => {
          if (inFlight?.promise === promise) inFlight = null;
        });
      inFlight = { userId, promise };
      return promise;
    },
  };
}
