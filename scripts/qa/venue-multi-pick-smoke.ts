/**
 * 직관 스토리 앱 내 커스텀 그리드 계약 스모크.
 * 실행: npm run qa:venue-multi-pick
 * 스펙 게이트(#product 1785211442.603729 목업 삼순 GO 2026-07-29):
 *   ① 최근순 커스텀 그리드 + 선택 스트립 순서 1→2→3 보존 + 최대 3개
 *   ② 미디어 타입 정합 — 사진에 영상 길이 배지 금지, 영상은 0:12 형식
 *   ③ 하단 sticky CTA 1개 `전체 팀 공유` (rounded-xl · py-3.5 · safe-area) — 상단 공유 버튼 없음
 *   ④ CTA 팀색 raw --team-primary 금지 — teamPalette.accent/onAccent(10팀 WCAG AA)
 *   ⑤ 완료 요약 — 실패 사유 1줄 + 실패건만 개별 재시도
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  VENUE_STORY_MAX_ITEMS,
  VENUE_STORY_OVER_MAX_MSG,
  VENUE_STORY_CTA_LABEL,
  VENUE_UPLOAD_NETWORK_FAIL_MSG,
  pickIdentity,
  mergePickedItems,
  formatDurationBadge,
  mediaDurationBadge,
  overallUploadProgress,
  summarizeUploadOutcome,
  uploadFailureReason,
  isRetryableItem,
  type MultiItemStatus,
} from "../../src/lib/venue-stories/multi-pick";
import { paletteForTeamId, teamPalette } from "../../src/design-v2/team-palette";
import { TEAMS } from "../../src/design-v2/TEAMS";
import { meetsAA } from "../../src/lib/design-v2/contrast";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

console.log("[① 병합 — 순서 보존 / 중복 / 상한]");
{
  type T = { key: string };
  const id = (t: T) => t.key;
  const a = { key: "a" }, b = { key: "b" }, c = { key: "c" }, d = { key: "d" };
  const r1 = mergePickedItems<T>([], [a, b, c], id);
  ok("빈 상태 3개 픽 — 선택 순서 그대로", r1.merged.map(id).join(",") === "a,b,c");
  const r2 = mergePickedItems<T>([a], [b, c, d], id);
  ok("기존 1 + 새 3 → 상한 3, 초과 1 drop", r2.merged.map(id).join(",") === "a,b,c" && r2.droppedOverMax === 1);
  const r3 = mergePickedItems<T>([a, b], [b, c], id);
  ok("중복 픽 제거(순서 유지)", r3.merged.map(id).join(",") === "a,b,c" && r3.droppedDuplicate === 1);
  const r4 = mergePickedItems<T>([a, b, c], [d], id);
  ok("이미 만석이면 전량 drop", r4.merged.map(id).join(",") === "a,b,c" && r4.droppedOverMax === 1);
  ok("상한 상수 3", VENUE_STORY_MAX_ITEMS === 3);
  ok("초과 안내 문구에 상한 포함", VENUE_STORY_OVER_MAX_MSG.includes("3개"));
  ok(
    "pickIdentity — name/size/lastModified 결합",
    pickIdentity({ name: "a.mov", size: 10, lastModified: 5 }) === "a.mov:10:5" &&
      pickIdentity({ name: "a.mov", size: 10, lastModified: 6 }) !==
        pickIdentity({ name: "a.mov", size: 10, lastModified: 5 }),
  );
}

console.log("[② 미디어 타입 정합 — 길이 배지]");
{
  ok("영상 12초 → 0:12", mediaDurationBadge("video", 12000) === "0:12");
  ok("영상 65초 → 1:05", mediaDurationBadge("video", 65000) === "1:05");
  ok("영상 400ms 반올림 최소 0:01", mediaDurationBadge("video", 400) === "0:01");
  ok("영상 duration 미상 → 배지 없음(재생 아이콘만)", mediaDurationBadge("video", null) === null);
  ok("사진은 durationMs 가 있어도 배지 금지", mediaDurationBadge("image", 12000) === null);
  ok("formatDurationBadge null/0 → null", formatDurationBadge(null) === null && formatDurationBadge(0) === null);
}

console.log("[진행률 / 완료 요약]");
{
  ok("항목 0 → 0", overallUploadProgress([], 0.5) === 0);
  ok("3개 중 1 완료 + 진행 0.5 → 50", overallUploadProgress(["done", "uploading", "ready"], 0.5) === 50);
  ok("진행 중엔 99 캡(완료 오인 방지)", overallUploadProgress(["done", "done", "uploading"], 1) === 99);
  ok("전량 종결(실패 포함) → 100", overallUploadProgress(["done", "failed", "done"], 0) === 100);
  ok("ratio 범위 클램프", overallUploadProgress(["uploading"], 5) === 99 && overallUploadProgress(["uploading"], -1) === 0);
  const o = summarizeUploadOutcome(["done", "failed", "done"] as MultiItemStatus[]);
  ok("요약 집계 성공2·실패1·allSettled", o.success === 2 && o.failed === 1 && o.allSettled);
  ok("미종결이면 allSettled=false", summarizeUploadOutcome(["done", "uploading"]).allSettled === false);
  ok("빈 배열은 allSettled=false", summarizeUploadOutcome([]).allSettled === false);
}

console.log("[⑤ 실패 사유 1줄 + 실패건만 재시도]");
{
  ok("네트워크 실패 → 네트워크 오류", uploadFailureReason({ kind: "network" }) === VENUE_UPLOAD_NETWORK_FAIL_MSG);
  ok("서버 사유 passthrough", uploadFailureReason({ kind: "server", message: "이 경기에 올릴 수 있는 개수를 초과했어요" }) === "이 경기에 올릴 수 있는 개수를 초과했어요");
  ok("prepare 사유 passthrough", uploadFailureReason({ kind: "prepare", message: "영상은 15초 이하만 올릴 수 있어요" }) === "영상은 15초 이하만 올릴 수 있어요");
  ok("빈 사유 fallback", uploadFailureReason({ kind: "server", message: "  " }) === "업로드에 실패했어요");
  ok("재시도는 failed 만", isRetryableItem("failed") && !isRetryableItem("done") && !isRetryableItem("uploading") && !isRetryableItem("ready"));
}

console.log("[④ CTA 팀색 — teamPalette.accent/onAccent WCAG AA(10팀+neutral)]");
{
  let aaAll = true;
  for (const team of Object.values(TEAMS)) {
    const p = teamPalette(team);
    if (!meetsAA(p.onAccent, p.accent)) {
      aaAll = false;
      console.log(`    ✗ ${team.slug}: ${p.onAccent} on ${p.accent}`);
    }
  }
  ok("전 팀 accent/onAccent 대비 AA(≥4.5:1)", aaAll);
  ok("paletteForTeamId — id 매칭", paletteForTeamId(TEAMS.lg.id).primary === TEAMS.lg.primary);
  ok("paletteForTeamId — null/미매칭은 neutral fallback", paletteForTeamId(null).isNeutral && paletteForTeamId(9999).isNeutral);
}

console.log("[③ 컴포저 정적 계약 — 단일 sticky CTA / raw 팀변수 금지]");
{
  const src = readFileSync(
    join(__dirname, "../../src/components/game/VenueStoryComposer.tsx"),
    "utf8",
  );
  ok("CTA 라벨 상수 `전체 팀 공유` 사용", VENUE_STORY_CTA_LABEL === "전체 팀 공유" && src.includes("VENUE_STORY_CTA_LABEL"));
  ok("CTA 규격 rounded-xl · py-3.5", /className="w-full py-3\.5 rounded-xl/.test(src));
  ok("safe-area(bottom) 유지", src.includes("env(safe-area-inset-bottom)"));
  ok("CTA 색상은 palette.accent/onAccent", /style=\{\{ background: palette\.accent, color: palette\.onAccent \}\}/.test(src));
  ok("raw --team-primary 사용 0", !src.includes("--team-primary"));
  ok("공용 paletteForTeamId 사용(픽커 로컬 예외 없음)", src.includes("paletteForTeamId(getMyTeamId())"));
  ok("네이티브 사진첩 열거 브릿지 사용", src.includes("listVenueMedia("));
  ok("OS 시스템 file input 폴백 금지", !src.includes('document.createElement("input")'));
  ok("그리드 탭 즉시 asset export→프리뷰 전환", /exportVenueMediaFile\(asset\.id\)[\s\S]{0,180}?handlePickedFiles\(\[file\], \[asset\.id\]\)[\s\S]{0,100}?setLibraryOpen\(false\)/.test(src));
  ok("Limited/선택 사진 `더 보기` 흐름", src.includes("presentLimitedVenueMediaPicker()") && src.includes("더 보기"));
  ok("권한 거부 시 OS 설정 유도", src.includes("openVenueMediaSettings()") && src.includes("설정 열기"));
  const stickyCtaCount = (src.match(/className="w-full py-3\.5 rounded-xl/g) ?? []).length;
  ok("하단 sticky CTA 1개(상단 공유 버튼 없음)", stickyCtaCount === 1 && !src.includes("공유하기"));
  ok("완료 요약 재시도 게이트가 isRetryableItem 사용", src.includes("isRetryableItem(target.status)"));
  ok(
    "재시도 중 닫기/중복 전송 동기 guard",
    src.includes("if (!target || uploadInFlightRef.current || !isRetryableItem(target.status)) return;") &&
      src.includes("if (submitting || uploadInFlightRef.current || processingPickRef.current) return;"),
  );
  ok("멀티픽 병합이 mergePickedItems 사용(순서/상한 단일 소스)", src.includes("mergePickedItems("));
  ok("배지 렌더가 mediaDurationBadge 사용(사진 배지 금지 단일 소스)", (src.match(/mediaDurationBadge\(/g) ?? []).length >= 3);
  ok("그리드 썸네일 lazy+async decode", src.includes('loading="lazy"') && src.includes('decoding="async"'));
  ok("썸네일 placeholder→fade-in", src.includes("animate-pulse opacity-100") && src.includes("transition-opacity duration-200"));
  ok("오프스크린 셀 렌더 비용 제한", src.includes('contentVisibility: "auto"'));
  ok("선택 배지 spring 애니메이션", src.includes('transition={{ type: "spring", stiffness: 520, damping: 30 }}'));
  ok("선택 즉시 optimistic 배지", /setPendingAssetId\(asset\.id\)[\s\S]{0,120}?venueMediaSelectionHaptic\(\)/.test(src));
  ok("프리뷰 전환 AnimatePresence wait", src.includes('<AnimatePresence mode="wait" initial={false}>'));
  ok("스트립 layout 재정렬 애니메이션", src.includes("<motion.button") && src.includes("layout"));
  ok("스트립 이동·삭제 44px 터치 타겟", (src.match(/w-11 h-11 rounded-xl/g) ?? []).length >= 3);
  ok("완료 요약 fade/slide 전환", /phase === "done"[\s\S]{0,180}?<motion\.div[\s\S]{0,180}?initial=\{\{ opacity: 0, y: 10 \}\}/.test(src));
  ok("업로드 진행률 300ms ease-out", src.includes("transition-[width] duration-300 ease-out"));
}

console.log("[B안 브릿지 계약 — 사진첩 열거/asset export]");
{
  const bridge = readFileSync(
    join(__dirname, "../../src/lib/capacitor/venue-media-library.ts"),
    "utf8",
  );
  ok("VenueMediaLibrary 커스텀 플러그인 등록", bridge.includes('registerPlugin<VenueMediaLibraryPlugin>("VenueMediaLibrary")'));
  ok("최근순 페이지 열거 API", bridge.includes("listMedia(options: { cursor?: string; limit: number })"));
  ok("원본 asset export API", bridge.includes("exportMedia(options: { id: string })"));
  ok("원격 WebView file 경로 변환", bridge.includes("Capacitor.convertFileSrc(exported.webPath)"));
  ok("Limited 추가 허용 API", bridge.includes("presentLimitedPicker(): Promise<void>"));
  ok("설정 유도 API", bridge.includes("openSettings(): Promise<void>"));
  ok("선택 햅틱 API + 구 브릿지 fallback", bridge.includes("selectionChanged(): Promise<void>") && bridge.includes("navigator.vibrate?.(8)"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
