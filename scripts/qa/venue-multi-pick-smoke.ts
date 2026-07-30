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
  resolveVenuePickerMode,
  toggleAssetSelection,
  previewMediaMode,
  shouldRefreshLibraryOnResume,
  VENUE_LIBRARY_FIRST_PAGE_SIZE,
  VENUE_LIBRARY_PAGE_SIZE,
  type MultiItemStatus,
} from "../../src/lib/venue-stories/multi-pick";
import { teamPalette } from "../../src/design-v2/team-palette";
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

console.log("[④ CTA 팀색 — 기존 teamPalette.accent/onAccent 계약]");
{
  // 전 팀 WCAG AA 보강(onAccentColor 대비 기반 판정)은 합의상 별도 PR(onAccent helper 분리)에서
  // 다뤘다 — 여기서는 기존 teamPalette 계약(흑/백 자동 선택 + neutral fallback)만 고정한다.
  let pairAll = true;
  let anyAA = true;
  for (const team of Object.values(TEAMS)) {
    const p = teamPalette(team);
    if (p.onAccent !== "#ffffff" && p.onAccent !== "#0a0a0a") pairAll = false;
    if (team.slug === "neutral" && !meetsAA(p.onAccent, p.accent)) anyAA = false;
  }
  ok("전 팀 onAccent 흑/백 자동 선택(기존 계약)", pairAll);
  ok("neutral(KBO 블루) accent/onAccent AA", anyAA);
  ok("미매칭 팀은 neutral fallback", teamPalette(TEAMS.neutral).isNeutral);
}

console.log("[version gate — 픽커 모드 / 그리드 멀티셀렉트 토글]");
{
  ok(
    "설치 앱 + 브릿지 가용 → grid",
    resolveVenuePickerMode({ nativeRuntime: true, pluginAvailable: true }) === "grid",
  );
  ok(
    "구설치본(브릿지 없음) → 기존 file input 폴백",
    resolveVenuePickerMode({ nativeRuntime: true, pluginAvailable: false }) === "fileInput",
  );
  ok(
    "웹/PWA → 기존 file input 폴백",
    resolveVenuePickerMode({ nativeRuntime: false, pluginAvailable: false }) === "fileInput" &&
      resolveVenuePickerMode({ nativeRuntime: false, pluginAvailable: true }) === "fileInput",
  );
  const t1 = toggleAssetSelection([], "a");
  const t2 = toggleAssetSelection(["a"], "b");
  const t3 = toggleAssetSelection(["a", "b"], "c");
  ok("탭 토글 — 선택 순서 1→2→3 append", t1.next.join(",") === "a" && t2.next.join(",") === "a,b" && t3.next.join(",") === "a,b,c");
  const t4 = toggleAssetSelection(["a", "b", "c"], "b");
  ok("재탭 해제 — 뒤 번호 한 칸 당김", t4.next.join(",") === "a,c" && !t4.overMax);
  const t5 = toggleAssetSelection(["a", "b", "c"], "d");
  ok("상한(3) 도달 시 무변경 + overMax", t5.next.join(",") === "a,b,c" && t5.overMax);
}

console.log("[라운드2 #2 — 선택→즉시 프리뷰(썸네일 우선) / 원본 비동기 분리]");
{
  // 원본 미준비 상태에서는 네이티브 썸네일(data URL)을 img 로 즉시 표시한다.
  ok(
    "영상 + 썸네일만 있으면 img 모드(즉시 프리뷰)",
    previewMediaMode({ kind: "video", previewUrl: "data:image/jpeg;base64,x", originalReady: false }) === "image",
  );
  ok(
    "영상 + 원본 blob 준비 완료면 video 모드",
    previewMediaMode({ kind: "video", previewUrl: "blob:https://x/1", originalReady: true }) === "video",
  );
  ok(
    "영상 + blob 이지만 원본 미준비면 img 모드(video 장착 금지)",
    previewMediaMode({ kind: "video", previewUrl: "blob:https://x/1", originalReady: false }) === "image",
  );
  ok(
    "이미지는 준비 여부 무관 img 모드",
    previewMediaMode({ kind: "image", previewUrl: "data:image/jpeg;base64,x", originalReady: false }) === "image",
  );
  ok(
    "프리뷰 URL 없으면(iCloud 썸네일 부재) placeholder — 영구 shimmer 금지 축과 분리",
    previewMediaMode({ kind: "image", previewUrl: null, originalReady: false }) === "placeholder" &&
      previewMediaMode({ kind: "video", previewUrl: "", originalReady: true }) === "placeholder",
  );
}

console.log("[라운드2 #1 — 앱 복귀 재조회 / 라운드2 #3 — 점진 pagination]");
{
  ok(
    "그리드 열림 + 문서 visible → 재조회",
    shouldRefreshLibraryOnResume({ libraryOpen: true, documentVisible: true }) === true,
  );
  ok(
    "그리드 닫힘/문서 hidden → 재조회 안 함",
    shouldRefreshLibraryOnResume({ libraryOpen: false, documentVisible: true }) === false &&
      shouldRefreshLibraryOnResume({ libraryOpen: true, documentVisible: false }) === false,
  );
  ok(
    "첫 페이지는 소량(웜 진입), 후속 페이지보다 작다",
    VENUE_LIBRARY_FIRST_PAGE_SIZE === 24 &&
      VENUE_LIBRARY_PAGE_SIZE === 60 &&
      VENUE_LIBRARY_FIRST_PAGE_SIZE < VENUE_LIBRARY_PAGE_SIZE,
  );
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
  ok(
    "CTA 팀색은 기존 teamPalette + TEAMS 만 사용(onAccent helper 신설은 별도 PR)",
    src.includes("teamPalette(team ?? TEAMS.neutral)") && !src.includes("paletteForTeamId("),
  );
  ok("네이티브 사진첩 열거 브릿지 사용", src.includes("listVenueMedia("));
  ok(
    "version gate — 브릿지 미가용이면 기존 file input 폴백(업로드 동선 보존)",
    src.includes("isVenueMediaLibraryAvailable()") &&
      src.includes("resolveVenuePickerMode(") &&
      src.includes('type="file"') &&
      src.includes('accept="image/*,video/*"') &&
      src.includes("fileInputRef.current?.click()"),
  );
  ok(
    "그리드 한 화면 멀티셀렉트 — 탭 토글 후 확정 즉시 닫기+썸네일 프리뷰+원본 비동기 큐(라운드2 #2)",
    src.includes("toggleAssetSelection(") &&
      src.includes("confirmLibrarySelection") &&
      /const additions = librarySelection\.filter[\s\S]{0,600}?previewUrl: asset\.thumbnailUrl[\s\S]{0,800}?setLibraryOpen\(false\)[\s\S]{0,200}?enqueueOriginalPrepare\(item\)/.test(src) &&
      // 확정 핸들러 안에서 원본 export 를 await 하지 않는다(선택→프리뷰 P95 ≤0.3초 계약)
      !/confirmLibrarySelection = [\s\S]{0,1500}?await exportVenueMediaFile/.test(src),
  );
  ok(
    "업로드는 원본 준비 완료를 await(runUpload — pendingFiles)",
    /let file = target\.file;[\s\S]{0,400}?await pendingFilesRef\.current\.get\(target\.key\)/.test(src) &&
      src.includes("원본을 준비하지 못했어요"),
  );
  ok(
    "원본 export 순차 큐(동시 메모리 폭증 방지) + 준비 중 상태 노출",
    src.includes("prepareQueueRef") && src.includes("원본 준비 중"),
  );
  ok(
    "앱 복귀(visibilitychange) 시 권한·목록 재조회 + denied '다시 확인' 동선(라운드2 #1)",
    src.includes('document.addEventListener("visibilitychange"') &&
      src.includes("shouldRefreshLibraryOnResume") &&
      src.includes("다시 확인") &&
      src.includes("openVenueMediaSettings"),
  );
  ok(
    "export 단건마다 그리드 닫힘 구조 제거(토글 중 setLibraryOpen(false) 없음)",
    !/toggleLibraryAsset[\s\S]{0,600}?setLibraryOpen\(false\)/.test(src),
  );
  ok("Limited/선택 사진 `더 보기` 흐름", src.includes("presentLimitedVenueMediaPicker()") && src.includes("더 보기"));
  ok("권한 거부 시 OS 설정 유도", src.includes("openVenueMediaSettings()") && src.includes("설정 열기"));
  // 프리뷰 화면 CTA 1개 + 그리드 확정 바 1개(상호 배타 화면) — 상단 공유 버튼은 여전히 없음.
  const stickyCtaCount = (src.match(/className="w-full py-3\.5 rounded-xl/g) ?? []).length;
  ok(
    "화면당 하단 sticky CTA 1개(프리뷰/그리드 배타 렌더 · 상단 공유 버튼 없음)",
    stickyCtaCount === 2 &&
      src.includes("{!libraryOpen && (") &&
      src.includes('{libraryOpen && phase !== "done" && (') &&
      !src.includes("공유하기"),
  );
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
  ok(
    "탭 즉시 선택 배지+햅틱(export 대기 없음)",
    /setLibrarySelection\(\(prev\)[\s\S]{0,500}?venueMediaSelectionHaptic\(\)/.test(src),
  );
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
  ok(
    "원격 WebView 안전 export — base64 청크 읽기(convertFileSrc/file:// 의존 0)",
    bridge.includes("readExport(options: { token: string; offset: number; length: number })") &&
      bridge.includes("releaseExport(options: { token: string })") &&
      !bridge.includes("convertFileSrc"),
  );
  ok(
    "설치 앱 판정은 공용 isNativeRuntime (Capacitor.isNativePlatform 단독 판정 금지 — PR #484 패턴)",
    bridge.includes('import { isNativeRuntime } from "@/lib/capacitor/platform"') &&
      bridge.includes("return isNativeRuntime();"),
  );
  ok(
    "브릿지 가용성 런타임 probe(version gate)",
    bridge.includes("export async function isVenueMediaLibraryAvailable") &&
      bridge.includes('callPlugin<{ permission: VenueMediaPermission }>("getPermission")'),
  );
  ok(
    "원격 로드 dual-instance 우회 — 주입 브릿지 fallback(native-app-review 패턴)",
    bridge.includes("window.Capacitor") || bridge.includes("InjectedCapacitor"),
  );
  ok("export cache 정리(releaseExport) 호출", bridge.includes('callPlugin<void>("releaseExport"'));
  ok("Limited 추가 허용 API", bridge.includes("presentLimitedPicker(): Promise<void>"));
  ok("설정 유도 API", bridge.includes("openSettings(): Promise<void>"));
  ok("선택 햅틱 API + 구 브릿지 fallback", bridge.includes("selectionChanged(): Promise<void>") && bridge.includes("navigator.vibrate?.(8)"));
}

console.log("[네이티브 실구현 — iOS PhotoKit / Android MediaStore / 권한·등록]");
{
  const swift = readFileSync(
    join(__dirname, "../../ios/App/App/VenueMediaLibraryPlugin.swift"),
    "utf8",
  );
  ok(
    "iOS — PhotoKit 열거/썸네일/원본 export",
    swift.includes("PHAsset.fetchAssets") &&
      swift.includes("PHImageManager") &&
      swift.includes("requestImageDataAndOrientation") &&
      swift.includes("requestAVAsset"),
  );
  ok(
    "iOS — 플러그인 메서드 9종 선언(CAPBridgedPlugin)",
    swift.includes('jsName = "VenueMediaLibrary"') &&
      ["getPermission", "requestPermission", "listMedia", "exportMedia", "readExport", "releaseExport", "presentLimitedPicker", "openSettings", "selectionChanged"].every((m) =>
        swift.includes(`CAPPluginMethod(name: "${m}"`),
      ),
  );
  ok(
    "iOS — Limited(일부 선택) + 설정 유도 + iCloud 원본 허용",
    swift.includes("presentLimitedLibraryPicker") &&
      swift.includes("openSettingsURLString") &&
      swift.includes("isNetworkAccessAllowed = true"),
  );
  ok(
    "iOS — Limited '더 보기' completion 후 resolve(stale 방지, 라운드2 #1)",
    /presentLimitedLibraryPicker\(from: vc\)\s*\{/.test(swift) &&
      swift.includes('call.resolve(["permission": self.currentPermission()])'),
  );
  const infoPlist = readFileSync(join(__dirname, "../../ios/App/App/Info.plist"), "utf8");
  ok(
    "iOS — 사진 권한 설명에 직관 사진·영상 업로드 목적 고지(라운드2 #4)",
    /NSPhotoLibraryUsageDescription<\/key>\s*<string>[^<]*직관[^<]*사진·영상[^<]*<\/string>/.test(infoPlist),
  );
  ok(
    "iOS — PHPhotoLibraryPreventAutomaticLimitedAccessAlert(수동 Limited UX, 라운드2 #4)",
    /PHPhotoLibraryPreventAutomaticLimitedAccessAlert<\/key>\s*<true\/>/.test(infoPlist),
  );
  ok("iOS — export cache 정리(release/deinit)", swift.includes("removeItem(at:") && swift.includes("deinit"));
  const mainVC = readFileSync(join(__dirname, "../../ios/App/App/MainViewController.swift"), "utf8");
  ok("iOS — 브릿지 수동 등록", mainVC.includes("registerPluginInstance(VenueMediaLibraryPlugin())"));
  const pbx = readFileSync(join(__dirname, "../../ios/App/App.xcodeproj/project.pbxproj"), "utf8");
  ok("iOS — Xcode 타쉿 소스 포함", (pbx.match(/VenueMediaLibraryPlugin\.swift/g) ?? []).length >= 4);
  const plist = readFileSync(join(__dirname, "../../ios/App/App/Info.plist"), "utf8");
  ok("iOS — NSPhotoLibraryUsageDescription 선언", plist.includes("NSPhotoLibraryUsageDescription"));

  const kotlin = readFileSync(
    join(__dirname, "../../android/app/src/main/java/fan/keubo/app/VenueMediaLibraryPlugin.kt"),
    "utf8",
  );
  ok(
    "Android Kotlin — MediaStore 열거/썸네일/원본 export",
    kotlin.includes("MediaStore.Files.getContentUri") &&
      kotlin.includes("loadThumbnail") &&
      kotlin.includes("openInputStream"),
  );
  ok(
    "Android — 권한 alias(READ_MEDIA_IMAGES/VIDEO/VISUAL_USER_SELECTED + legacy)",
    kotlin.includes("READ_MEDIA_IMAGES") &&
      kotlin.includes("READ_MEDIA_VIDEO") &&
      kotlin.includes("READ_MEDIA_VISUAL_USER_SELECTED") &&
      kotlin.includes("READ_EXTERNAL_STORAGE"),
  );
  ok("Android — limited(일부 사진) 판정", kotlin.includes('"limited"') && kotlin.includes("mediaPartial"));
  ok("Android — export cache 정리(destroy)", kotlin.includes("handleOnDestroy"));
  const manifest = readFileSync(join(__dirname, "../../android/app/src/main/AndroidManifest.xml"), "utf8");
  ok(
    "Android — Manifest 권한 선언(13+/14+/≤12L)",
    manifest.includes("android.permission.READ_MEDIA_IMAGES") &&
      manifest.includes("android.permission.READ_MEDIA_VIDEO") &&
      manifest.includes("android.permission.READ_MEDIA_VISUAL_USER_SELECTED") &&
      /READ_EXTERNAL_STORAGE"[\s\S]{0,80}?maxSdkVersion="32"/.test(manifest),
  );
  const mainActivity = readFileSync(
    join(__dirname, "../../android/app/src/main/java/fan/keubo/app/MainActivity.java"),
    "utf8",
  );
  ok("Android — MainActivity 등록", mainActivity.includes("registerPlugin(VenueMediaLibraryPlugin.class);"));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
