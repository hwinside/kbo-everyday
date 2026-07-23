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

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
