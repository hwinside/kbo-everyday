/**
 * 직관 라이브 업로드 진행률 XHR 배선 계약 스모크.
 * 실행: npm run qa:venue-upload-progress
 * 배경: PR #795 삼순 NO-GO — ①xhr.upload.onprogress를 open() 뒤에 등록하면
 *       일부 WebView(iOS/Android)에서 진행률 0% 고정 ②토큰/환경 미비 시
 *       supabase-js 폴백 계약. listener 선등록 + 2xx/비2xx/error/progress/fallback 회귀.
 */
// upload.ts 가 supabase browser client 를 모듈 스코프에서 생성하므로
// import 전에 더미 env 필요(순수 함수만 사용, 네트워크 호출 없음) → dynamic import
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://smoke.invalid";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-anon-key";

import type { UploadXhrLike } from "../../src/lib/venue-stories/upload";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

type ProgressEvt = { lengthComputable: boolean; loaded: number; total: number };

class FakeXhr implements UploadXhrLike {
  calls: string[] = [];
  status = 0;
  upload: { onprogress: ((e: ProgressEvt) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  headers: Record<string, string> = {};
  url = "";
  body: unknown = null;
  private progressAtOpen: boolean | null = null;
  private terminalAtOpen: boolean | null = null;

  open(_method: string, url: string) {
    this.calls.push("open");
    this.url = url;
    // open() 시점에 listener가 이미 붙어 있었는지 기록 (선등록 계약의 핵심 검증)
    this.progressAtOpen = this.upload.onprogress != null;
    this.terminalAtOpen = this.onload != null && this.onerror != null && this.onabort != null;
  }
  setRequestHeader(name: string, value: string) {
    this.calls.push(`header:${name}`);
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.calls.push("send");
    this.body = body;
  }
  get listenersRegisteredBeforeOpen(): boolean {
    return this.progressAtOpen === true && this.terminalAtOpen === true;
  }
}

const HEADERS = {
  authorization: "Bearer test-token",
  apikey: "anon",
  "x-upsert": "false",
  "cache-control": "max-age=3600",
  "content-type": "video/mp4",
};

async function main() {
  const { runXhrUpload, shouldFallbackToSupabaseJs } = await import(
    "../../src/lib/venue-stories/upload"
  );
  console.log("[listener 선등록 — open() 전에 progress/terminal listener 존재]");
  {
    const xhr = new FakeXhr();
    const p = runXhrUpload(xhr, { url: "https://x/storage/v1/object/b/p", headers: HEADERS, body: "data" });
    ok("progress+onload/onerror/onabort 모두 open() 전 등록", xhr.listenersRegisteredBeforeOpen);
    ok("호출 순서: open → headers → send", (() => {
      const iOpen = xhr.calls.indexOf("open");
      const iSend = xhr.calls.indexOf("send");
      const headerIdxs = xhr.calls.map((c, i) => (c.startsWith("header:") ? i : -1)).filter((i) => i >= 0);
      return iOpen === 0 && iSend === xhr.calls.length - 1 && headerIdxs.every((i) => i > iOpen && i < iSend);
    })());
    ok("헤더 5종 전달(authorization/apikey/x-upsert/cache-control/content-type)",
      Object.keys(HEADERS).every((k) => xhr.headers[k] === HEADERS[k as keyof typeof HEADERS]));
    xhr.status = 200;
    xhr.onload?.();
    ok("2xx → resolve(true)", (await p) === true);
  }

  console.log("[progress 콜백 계약]");
  {
    const seen: number[] = [];
    const xhr = new FakeXhr();
    const p = runXhrUpload(xhr, {
      url: "u", headers: {}, body: "d",
      onProgress: (r) => seen.push(r),
    });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 }); // 무시돼야 함
    xhr.status = 201;
    xhr.onload?.();
    await p;
    ok("lengthComputable 이벤트 → ratio 전달 (0.25, 1)", seen.length === 2 && seen[0] === 0.25 && seen[1] === 1);
  }

  console.log("[비2xx/에러/abort → resolve(false)]");
  {
    const xhr = new FakeXhr();
    const p = runXhrUpload(xhr, { url: "u", headers: {}, body: "d" });
    xhr.status = 403; // RLS 거부 등
    xhr.onload?.();
    ok("403 → false", (await p) === false);
  }
  {
    const xhr = new FakeXhr();
    const p = runXhrUpload(xhr, { url: "u", headers: {}, body: "d" });
    xhr.onerror?.();
    ok("network error → false", (await p) === false);
  }
  {
    const xhr = new FakeXhr();
    const p = runXhrUpload(xhr, { url: "u", headers: {}, body: "d" });
    xhr.onabort?.();
    ok("abort → false", (await p) === false);
  }

  console.log("[supabase-js 폴백 판정 — 하나라도 미비면 폴백(진행률 없이 업로드 유지)]");
  const full = { base: "https://x", anonKey: "k", token: "t", hasXhr: true };
  ok("전부 가용 → XHR 경로", shouldFallbackToSupabaseJs(full) === false);
  ok("base 없음 → 폴백", shouldFallbackToSupabaseJs({ ...full, base: undefined }) === true);
  ok("anonKey 없음 → 폴백", shouldFallbackToSupabaseJs({ ...full, anonKey: undefined }) === true);
  ok("token 없음 → 폴백", shouldFallbackToSupabaseJs({ ...full, token: undefined }) === true);
  ok("XHR 미가용 → 폴백", shouldFallbackToSupabaseJs({ ...full, hasXhr: false }) === true);

  console.log("[업로드 중 UI 잠금 계약 — 컴포저 소스 정적 검증(삼순 #795 blocker)]");
  {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(
      join(__dirname, "../../src/components/game/VenueStoryComposer.tsx"),
      "utf8",
    );
    // submitting 동안 잠겨야 하는 조작 전수: 닫기 guard + disabled 속성들
    ok("close()에 submitting guard 존재", /const close = \(\) => \{\s*(\/\/[^\n]*\n\s*)*if \(submitting\) return;/.test(src));
    ok("onPick이 submitting 중 무시", /if \(!f \|\| submitting\) return;/.test(src));
    const disabledCount = (src.match(/disabled=\{submitting\}/g) ?? []).length;
    // 닫기 버튼 + 선택 CTA + 다시선택 + hidden file input + caption + 동의 checkbox = 6곳
    ok(`disabled={submitting} 6곳 이상 (현재 ${disabledCount})`, disabledCount >= 6);
    ok("caption input에 disabled 적용", /maxLength=\{200\}\s*\n\s*disabled=\{submitting\}/.test(src));
    ok("동의 checkbox에 disabled 적용", /onChange=\{toggleAgree\}\s*\n\s*disabled=\{submitting\}/.test(src));

    // 픽 대기 안내 배선 — iOS 영상 export 무피드백 구간 (7/23 리포트)
    console.log("[픽 대기 안내 배선 — openPicker/pick-session 연결]");
    ok("openPicker가 pick-session 토큰 발급+재진입 차단", /const token = pickSession\(\)\.open\(\);\s*\n\s*if \(token == null\) return;/.test(src));
    ok("onPick이 발급 토큰으로 resolveChange(late/stale 무시)", /const token = pickTokenRef\.current;[\s\S]{0,120}?if \(!pickSession\(\)\.resolveChange\(token\)\) return;/.test(src));
    ok("reset()이 in-flight 픽 invalidate(cancelPick)", /const reset = \(\) => \{[\s\S]{0,120}?cancelPick\(\);/.test(src));
    ok("cancel listener 누적 방지(선제거 후 등록)", /detachPickCancelListener\(\);\s*\n\s*const handler = \(\) => cancelPick\(\);/.test(src));
    ok("수동 취소 버튼도 cancelPick 사용", /onClick=\{cancelPick\}/.test(src));
    ok("픽 CTA가 openPicker 사용(직접 click 잔존 0)", !src.includes("inputRef.current?.click()") && (src.match(/onClick=\{openPicker\}/g) ?? []).length === 2);
    ok("대기 안내 UI는 업로드 중엔 미표시(picking && !submitting)", /picking && !submitting && \(/.test(src));
  }

  console.log("[pick-session identity 회귀 — 삼순 #805 라운드3 시나리오]");
  {
    const { createPickSession } = await import("../../src/lib/venue-stories/pick-session");

    // 시나리오 1: open → 수동 취소 → late change 무시(취소한 선택이 되살아나면 안 됨)
    {
      const seen: boolean[] = [];
      const s = createPickSession((p) => seen.push(p));
      const t = s.open();
      ok("open 토큰 발급", typeof t === "number" && s.isPicking() === true);
      s.cancel();
      ok("수동 취소 후 picking 해제", s.isPicking() === false);
      ok("취소 세션의 late change 무시(resolveChange=false)", s.resolveChange(t) === false);
      ok("상태 콜백 순서 true→false, 중복 없음", seen.length === 2 && seen[0] === true && seen[1] === false);
    }

    // 시나리오 2 (삼순 핵심): idA open → cancel(idA) → idB open → resolve(idA)=false && B 유지 → resolve(idB)=true
    {
      const s = createPickSession();
      const idA = s.open();
      s.cancel();
      const idB = s.open();
      ok("A/B 토큰이 서로 다름", idA !== idB && idA != null && idB != null);
      ok("A의 late change는 B로 오인되지 않음(resolve(idA)=false)", s.resolveChange(idA) === false);
      ok("A 무시 후에도 B 세션 유지", s.isPicking() === true);
      ok("B의 정상 change는 유효(resolve(idB)=true)", s.resolveChange(idB) === true && s.isPicking() === false);
    }

    // 시나리오 3: close/reset(cancel) → reopen 정상, 이전 토큰 change는 무시
    {
      const s = createPickSession();
      const idA = s.open();
      s.cancel(); // close/reset
      const idB = s.open();
      ok("reopen 성공(스피너 잔존 없이 새 세션)", idB != null && s.isPicking() === true);
      ok("reopen 후 이전 토큰 change 무시", s.resolveChange(idA) === false && s.isPicking() === true);
      ok("새 세션 change는 유효", s.resolveChange(idB) === true && s.isPicking() === false);
    }

    // 시나리오 4: 준비 중 재진입 차단 — 한 번에 하나의 in-flight 픽만
    {
      const s = createPickSession();
      const idA = s.open();
      ok("1차 open 허용", idA != null);
      ok("준비 중 2차 open 차단(null)", s.open() === null);
      ok("차단돼도 기존 세션 유지", s.isPicking() === true && s.resolveChange(idA) === true);
    }

    // 시나리오 5: null/무효 토큰 방어 + 성공 후 재선택 사이클 반복
    {
      const s = createPickSession();
      ok("활성 세션 없을 때 resolveChange(null)=false", s.resolveChange(null) === false);
      const t1 = s.open(); s.resolveChange(t1);
      const t2 = s.open();
      ok("재선택 사이클 반복 정상", s.isPicking() === true && s.resolveChange(t2) === true);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
