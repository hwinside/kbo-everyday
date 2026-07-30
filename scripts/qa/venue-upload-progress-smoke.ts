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
    ok(
      "close()에 submitting + 동기 in-flight guard 존재",
      /const close = \(\) => \{[\s\S]{0,180}?if \(submitting \|\| uploadInFlightRef\.current \|\| processingPickRef\.current\) return;/.test(src),
    );
    ok("native export 결과가 submitting 중이면 무시", /if \(!files \|\| files\.length === 0 \|\| submitting\) return;/.test(src));
    const disabledCount = (src.match(/disabled=\{submitting\}/g) ?? []).length;
    ok(`disabled={submitting} 4곳 이상 (현재 ${disabledCount})`, disabledCount >= 4);
    ok("caption input에 disabled 적용", /maxLength=\{200\}\s*\n\s*disabled=\{submitting\}/.test(src));
    ok("동의 checkbox에 disabled 적용", /onChange=\{toggleAgree\}\s*\n\s*disabled=\{submitting\}/.test(src));

    console.log("[커스텀 사진첩 배선 — OS 시스템 input 폴백 금지]");
    ok("네이티브 사진첩 열거 브릿지 사용", src.includes("listVenueMedia("));
    // 라운드3 #2/#3: export 는 업로드 차례에 runVenueUploadQueue 가 lazy 로 수행(assetId→File), 업로드는 기존 파이프라인(prepareVenueStoryMedia) 그대로 탄다.
    ok(
      "asset export 후 기존 File 파이프라인 연결(lazy export via runVenueUploadQueue)",
      /exportOriginal: \(assetId\) => exportVenueMediaFile\(assetId\)/.test(src) &&
        src.includes("runVenueUploadQueue(targets, {") &&
        /prepareVenueStoryMedia\(file, gameId/.test(src),
    );
    ok("OS file input 생성 0", !src.includes('document.createElement("input")'));
    ok("Limited 더 보기 브릿지 사용", src.includes("presentLimitedVenueMediaPicker()"));
    ok("권한 거부 설정 유도", src.includes("openVenueMediaSettings()"));
    // 관리자 QA closed-window 우회 — 렌더 gateReason과 submit 게이트 둘 다 단일 헬퍼 uploadBlocked 사용
    // (삼순 #832 blocker1 + 왕복2: isVenueUploadBlocked 헬퍼로 클라·서버 단일 소스, 취소는 관리자도 차단)
    ok("uploadBlocked가 isVenueUploadBlocked 헬퍼 사용(privileged: isAdmin)", /const uploadBlocked =[\s\S]{0,120}?isVenueUploadBlocked\(\{[\s\S]{0,120}?privileged: isAdmin/.test(src));
    ok("gateReason이 uploadBlocked 기반(헬퍼 판정 재사용)", /const gateReason = uploadBlocked \? venue\?\.reason \?\? null : null/.test(src));
    ok("submit 게이트도 uploadBlocked 사용(버튼만 활성하고 막지 않음 방지)", /if \(uploadBlocked\) \{/.test(src));
    ok("reset()이 async asset export invalidate", /const reset = \(\) => \{[\s\S]{0,220}?pickSeqRef\.current\+\+;/.test(src));
    ok("그리드 재진입 CTA가 openPicker 사용", (src.match(/onClick=\{openPicker\}/g) ?? []).length === 2);
  }

  console.log("[pick-controller identity 회귀 — production 배선 경유 (삼순 #805 라운드4)]");
  {
    const { createPickController } = await import("../../src/lib/venue-stories/pick-controller");
    type Handlers = { onChange: (f: unknown) => void; onCancel: () => void };
    const fileA = { name: "a.mov" };
    const fileB = { name: "b.mov" };

    const make = () => {
      const picks: Handlers[] = [];
      const files: unknown[] = [];
      const states: boolean[] = [];
      const ctrl = createPickController({
        openNative: (h) => picks.push(h as Handlers),
        onFile: (f) => files.push(f),
        onStateChange: (p) => states.push(p),
      });
      return { ctrl, picks, files, states };
    };

    // 삼순 핵심 시나리오: open A → cancel A → open B → A의 late change → B 유지, A 파일 무반영 → B change 유효
    {
      const { ctrl, picks, files } = make();
      ok("A open", ctrl.openPicker() === true && picks.length === 1);
      ctrl.cancel();
      ok("B open(재열기)", ctrl.openPicker() === true && picks.length === 2);
      picks[0].onChange(fileA); // A의 late change — A 인스턴스의 handler로만 도착
      ok("A late change 무반영(파일 0)", files.length === 0);
      ok("A late change 후에도 B 세션 유지", ctrl.isPicking() === true);
      picks[1].onChange(fileB);
      ok("B change 유효(fileB만 반영)", files.length === 1 && files[0] === fileB && ctrl.isPicking() === false);
    }

    // A의 late cancel이 B를 죽이지 않아야 함
    {
      const { ctrl, picks } = make();
      ctrl.openPicker();
      ctrl.cancel();
      ctrl.openPicker();
      picks[0].onCancel(); // A의 late cancel
      ok("A late cancel이 B 세션을 죽이지 않음", ctrl.isPicking() === true);
      picks[1].onCancel();
      ok("B 자신의 cancel은 유효", ctrl.isPicking() === false);
    }

    // 수동 취소 → late change 무시 + 상태 콜백 순서
    {
      const { ctrl, picks, files, states } = make();
      ctrl.openPicker();
      ctrl.cancel();
      picks[0].onChange(fileA);
      ok("취소 후 late change 무시", files.length === 0 && ctrl.isPicking() === false);
      ok("상태 콜백 true→false 중복 없음", states.join(",") === "true,false");
    }

    // 준비 중 재진입 차단 — native picker가 두 번 열리지 않음
    {
      const { ctrl, picks } = make();
      ok("1차 open 허용", ctrl.openPicker() === true);
      ok("준비 중 2차 open 차단(native 미호출)", ctrl.openPicker() === false && picks.length === 1);
      picks[0].onChange(fileA);
      ok("차단돼도 기존 세션 정상 종결", ctrl.isPicking() === false);
    }

    // 성공 선택 후 재선택 사이클 반복 + 같은 인스턴스 중복 change 무시
    {
      const { ctrl, picks, files } = make();
      ctrl.openPicker();
      picks[0].onChange(fileA);
      picks[0].onChange(fileA); // 중복 late fire
      ok("같은 픽 중복 change는 1회만 반영", files.length === 1);
      ok("재선택 사이클 정상", ctrl.openPicker() === true && picks.length === 2);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
