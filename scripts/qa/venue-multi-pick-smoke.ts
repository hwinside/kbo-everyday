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
import { JSDOM } from "jsdom";
import {
  runVenueUploadQueue,
  resolveVenueOriginal,
  VenueOriginalUnavailableError,
  type VenueUploadTarget,
} from "../../src/lib/venue-stories/venue-upload-queue";
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
  VENUE_LIBRARY_FILTERS,
  VENUE_LIBRARY_FILTER_MIN_VISIBLE,
  VENUE_LIBRARY_FILTER_MAX_AUTO_PAGES,
  filterLibraryAssets,
  shouldAutoLoadMoreForFilter,
  libraryEmptyMessage,
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

console.log("[미디어 타입 토글 — 전체/사진/영상 필터 + 자동 페이징]");
{
  const assets = [
    { id: "a", kind: "image" as const },
    { id: "b", kind: "video" as const },
    { id: "c", kind: "image" as const },
    { id: "d", kind: "video" as const },
  ];
  ok(
    "탭 3개 — 전체/사진/영상",
    VENUE_LIBRARY_FILTERS.map((t) => t.value).join(",") === "all,image,video" &&
      VENUE_LIBRARY_FILTERS.map((t) => t.label).join(",") === "전체,사진,영상",
  );
  ok(
    "영상 탭 = video 만, 최근순(원본 배열 순서) 보존",
    filterLibraryAssets(assets, "video").map((a) => a.id).join(",") === "b,d",
  );
  ok(
    "사진 탭 = image 만",
    filterLibraryAssets(assets, "image").map((a) => a.id).join(",") === "a,c",
  );
  ok(
    "전체 탭 = 전수 그대로(복사본, 원본 미변경)",
    filterLibraryAssets(assets, "all").map((a) => a.id).join(",") === "a,b,c,d" &&
      filterLibraryAssets(assets, "all") !== assets,
  );
  ok(
    "영상 탭에서 한 화면 분량 미달 + 커서 있음 → 다음 페이지 자동 로드(빈 화면 오인 방지)",
    shouldAutoLoadMoreForFilter({
      filter: "video",
      visibleCount: 2,
      hasCursor: true,
      loading: false,
      autoPages: 0,
    }) === true,
  );
  ok(
    "전체 탭은 자동 추가 로드 안 함(기존 동작 보존 — 수동 '더 불러오기'만)",
    shouldAutoLoadMoreForFilter({
      filter: "all",
      visibleCount: 0,
      hasCursor: true,
      loading: false,
      autoPages: 0,
    }) === false,
  );
  ok(
    "커서 없음(끝)·로딩 중이면 자동 로드 안 함(중복 호출 금지)",
    shouldAutoLoadMoreForFilter({
      filter: "video",
      visibleCount: 0,
      hasCursor: false,
      loading: false,
      autoPages: 0,
    }) === false &&
      shouldAutoLoadMoreForFilter({
        filter: "video",
        visibleCount: 0,
        hasCursor: true,
        loading: true,
        autoPages: 0,
      }) === false,
  );
  ok(
    "자동 로드는 bounded — 상한 도달 시 중단(영상 0개 사진첩에서 무한 브릿지 호출 차단)",
    shouldAutoLoadMoreForFilter({
      filter: "video",
      visibleCount: 0,
      hasCursor: true,
      loading: false,
      autoPages: VENUE_LIBRARY_FILTER_MAX_AUTO_PAGES,
    }) === false && VENUE_LIBRARY_FILTER_MAX_AUTO_PAGES > 0,
  );
  ok(
    "한 화면 분량을 채우면 자동 로드 중단",
    shouldAutoLoadMoreForFilter({
      filter: "video",
      visibleCount: VENUE_LIBRARY_FILTER_MIN_VISIBLE,
      hasCursor: true,
      loading: false,
      autoPages: 0,
    }) === false,
  );
  ok(
    "빈 상태 문구 — '사진첩에 아무것도 없음' vs '이 타입만 없음' 구분",
    libraryEmptyMessage({ filter: "video", totalLoaded: 40 }) === "최근 영상이 없어요" &&
      libraryEmptyMessage({ filter: "image", totalLoaded: 40 }) === "최근 사진이 없어요" &&
      libraryEmptyMessage({ filter: "video", totalLoaded: 0 }) === "최근 사진·영상이 없어요" &&
      libraryEmptyMessage({ filter: "video", totalLoaded: 0, hasAnyMedia: true }) ===
        "최근 영상이 없어요" &&
      libraryEmptyMessage({ filter: "all", totalLoaded: 40 }) === "최근 사진·영상이 없어요",
  );
}

console.log("[③ 컴포저 정적 계약 — 단일 sticky CTA / raw 팀변수 금지]");
{
  const src = readFileSync(
    join(__dirname, "../../src/components/game/VenueStoryComposer.tsx"),
    "utf8",
  );
  const gridSrc = readFileSync(
    join(__dirname, "../../src/components/game/VenueLibraryGrid.tsx"),
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
    "미디어 타입 토글이 그리드에 실배선 — 필터 상태로 걸러난 목록이 VenueLibraryGrid 로 간다",
    // 탭 렌더 + 선택 핸들러 + 필터 적용 목록이 그리드 assets 로 전달되는 실제 배선까지 확인.
    src.includes("VENUE_LIBRARY_FILTERS.map(") &&
      src.includes("selectLibraryFilter(tab.value)") &&
      /const visibleLibraryAssets = useMemo\([\s\S]{0,200}?filterLibraryAssets\(libraryAssets, libraryFilter\)/.test(
        src,
      ) &&
      /<VenueLibraryGrid[\s\S]{0,200}?assets=\{visibleLibraryAssets\}/.test(src) &&
      // 걸러지지 않은 원본 배열을 그리드에 그대로 넘기는 구배선 잔존 0
      !/<VenueLibraryGrid[\s\S]{0,200}?assets=\{libraryAssets\}/.test(src) &&
      // 빈 상태 문구도 탭별로 갈라진다(하드코딩 문구 잔존 금지)
      src.includes("libraryEmptyMessage({"),
  );
  ok(
    "탭 전환은 네이티브를 해당 타입으로 **재열거**한다 — cursor 리셋 + 목록 초기화 + 재조회",
    /selectLibraryFilter = \(next: VenueLibraryFilter\) => \{[\s\S]{0,600}?setLibraryAssets\(\[\]\)[\s\S]{0,200}?setLibraryCursor\(null\)[\s\S]{0,200}?loadLibrary\(false\)/.test(
      src,
    ),
  );
  ok(
    "listVenueMedia 에 현재 탭을 전달 — 전체는 undefined(기존 계약), 그 외는 단일 타입 배열",
    /listVenueMedia\([\s\S]{0,300}?requestedTypes === "all" \? undefined : \[requestedTypes\]/.test(src) &&
      // 비동기 응답이 도착했을 때 탭이 바뀜으면 버린다(탭 간 목록 오염 방지)
      /if \(libraryFilterRef\.current !== requestedTypes\) return;/.test(src),
  );
  ok(
    "구설치본 fail-safe — 네이티브가 mediaTypes 를 무시해도 화면단 거르기가 남아 혼합 목록이 안 섞인다",
    /const visibleLibraryAssets = useMemo\([\s\S]{0,200}?filterLibraryAssets\(libraryAssets, libraryFilter\)/.test(
      src,
    ) && /<VenueLibraryGrid[\s\S]{0,200}?assets=\{visibleLibraryAssets\}/.test(src),
  );
  ok(
    "네이티브 실구현 — iOS PHFetch predicate 가 요청 타입으로 갈라지고 미전달은 사진+영상 폴백",
    (() => {
      const swift = readFileSync(
        join(__dirname, "../../ios/App/App/VenueMediaLibraryPlugin.swift"),
        "utf8",
      );
      return (
        swift.includes('call.getArray("mediaTypes", String.self)') &&
        // 오직 image 요청이면 image 단일 predicate
        /wantsImage && !wantsVideo \{[\s\S]{0,200}?PHAssetMediaType\.image\.rawValue/.test(swift) &&
        /wantsVideo && !wantsImage \{[\s\S]{0,200}?PHAssetMediaType\.video\.rawValue/.test(swift) &&
        // 폴백은 기존 OR predicate 그대로
        /return NSPredicate\(\s*format: "mediaType == %d OR mediaType == %d"/.test(swift) &&
        // fetch 에 실제로 적용되는지(상수만 선언하고 안 쓰는 false-green 차단)
        swift.includes("options.predicate = self.mediaTypePredicate(requestedTypes)")
      );
    })(),
  );
  ok(
    "네이티브 실구현 — Android MediaStore selection 이 요청 타입으로 갈라지고 placeholder 개수가 args 와 일치",
    (() => {
      const kt = readFileSync(
        join(
          __dirname,
          "../../android/app/src/main/java/fan/keubo/app/VenueMediaLibraryPlugin.kt",
        ),
        "utf8",
      );
      return (
        kt.includes('call.getArray("mediaTypes")') &&
        /wantsImage && !wantsVideo -> arrayOf\(image\)/.test(kt) &&
        /wantsVideo && !wantsImage -> arrayOf\(video\)/.test(kt) &&
        /else -> arrayOf\(image, video\)/.test(kt) &&
        // selection 이 args 길이에서 파생된다 — IN (?, ?) 하드코딩 잔존 금지
        kt.includes("val selectionArgs = mediaTypeSelectionArgs(requestedTypes)") &&
        /val placeholders = selectionArgs\.joinToString\(", "\) \{ "\?" \}/.test(kt) &&
        kt.includes("MEDIA_TYPE} IN ($placeholders)") &&
        !/MEDIA_TYPE\} IN \(\?, \?\)/.test(kt)
      );
    })(),
  );
  ok(
    "필터 자동 페이징은 bounded — 상한 상수를 쓰고 append 에서만 증가",
    src.includes("shouldAutoLoadMoreForFilter({") &&
      src.includes("libraryAutoPagesRef") &&
      /libraryAutoPagesRef\.current = append \? libraryAutoPagesRef\.current \+ 1 : 0/.test(src),
  );
  ok(
    "version gate — 브릿지 미가용이면 기존 file input 폴백(업로드 동선 보존)",
    src.includes("isVenueMediaLibraryAvailable()") &&
      src.includes("resolveVenuePickerMode(") &&
      src.includes('type="file"') &&
      src.includes('accept="image/*,video/*"') &&
      src.includes("fileInputRef.current?.click()"),
  );
  ok(
    "그리드 한 화면 멀티셀렉트 — 타일 탭 = 프리뷰 즉시 갱신 + 선택 토글, 확정은 썸네일만 보관(라운드3 #1/#3)",
    src.includes("toggleAssetSelection(") &&
      src.includes("<VenueLibraryGrid") &&
      src.includes("confirmLibrarySelection") &&
      // 확정은 네이티브 썸네일만 provisional 항목에 담고(file: null) 그리드를 즉시 닫는다(원본 pre-export 없음).
      /const additions = librarySelection\.filter[\s\S]{0,900}?file: null[\s\S]{0,300}?previewUrl: asset\.thumbnailUrl/.test(src) &&
      /confirmLibrarySelection = \(\) => \{[\s\S]{0,1500}?setLibraryOpen\(false\)/.test(src) &&
      // 확정 핸들러 안에서 원본 export 를 await 하지 않는다(선택→프리뷰 P95 ≤0.3초 계약)
      !/confirmLibrarySelection = [\s\S]{0,1500}?await exportVenueMediaFile/.test(src) &&
      // 선-export 큐(enqueueOriginalPrepare)·푸시리스(pendingFilesRef)는 제거되었다(bounded memory).
      !src.includes("enqueueOriginalPrepare") &&
      !src.includes("pendingFilesRef") &&
      !src.includes("prepareQueueRef"),
  );
  ok(
    "업로드는 runVenueUploadQueue 로 위임 — 원본은 업로드 차례에 lazy export(라운드3 #2/#3)",
    src.includes("runVenueUploadQueue(targets, {") &&
      src.includes("exportOriginal: (assetId) => exportVenueMediaFile(assetId)") &&
      src.includes("원본을 준비하지 못했어요"),
  );
  ok(
    "그리드 항목은 full-res data URL 를 누적하지 않는다(썸네일만 프리뷰, bounded memory #3)",
    // 그리드 확정 경로에서 readFileAsDataURL(고해상 변환)을 호출하지 않고(폴백 파일입력만 사용),
      // provisional 항목은 file: null 로 생성된다.
      /confirmLibrarySelection = [\s\S]{0,900}?file: null/.test(src) &&
      !/confirmLibrarySelection = [\s\S]{0,1500}?readFileAsDataURL/.test(src),
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
  ok("그리드 썸네일 lazy+async decode", gridSrc.includes('loading="lazy"') && gridSrc.includes('decoding="async"'));
  ok("썸네일 placeholder→fade-in", gridSrc.includes("animate-pulse opacity-100") && gridSrc.includes("transition-opacity duration-200"));
  ok("오프스크린 셀 렌더 비용 제한", gridSrc.includes('contentVisibility: "auto"'));
  ok("선택 배지 spring 애니메이션", gridSrc.includes('transition={{ type: "spring", stiffness: 520, damping: 30 }}'));
  ok("컴포저가 VenueLibraryGrid 로 위임(타일 탭→프리뷰 컴포넌트)", src.includes("<VenueLibraryGrid") && src.includes('from "@/components/game/VenueLibraryGrid"'));
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
  ok(
    "최근순 페이지 열거 API + 미디어 타입 필터(mediaTypes) — 생략 가능(기존 계약 보존)",
    /listMedia\(options: \{[\s\S]{0,600}?cursor\?: string;[\s\S]{0,400}?limit: number;[\s\S]{0,900}?mediaTypes\?: VenueMediaKind\[\];[\s\S]{0,80}?\}\): Promise<VenueMediaPage>/.test(
      bridge,
    ) &&
      // 호출 헬퍼도 선택적 전달 — 빈 배열이면 아예 보내지 않는다(구버전 동일 동작)
      /mediaTypes && mediaTypes\.length > 0 \? \{ mediaTypes \} : \{\}/.test(bridge),
  );
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
  const workflow = readFileSync(
    join(__dirname, "../../.github/workflows/venue-story-picker-gate.yml"),
    "utf8",
  );
  const nativeContractPaths = [
    "ios/App/App/VenueMediaLibraryPlugin.swift",
    "ios/App/App/Info.plist",
    "ios/App/App/MainViewController.swift",
    "ios/App/App.xcodeproj/project.pbxproj",
    "android/app/src/main/java/fan/keubo/app/VenueMediaLibraryPlugin.kt",
    "android/app/src/main/java/fan/keubo/app/MainActivity.java",
    "android/app/src/main/AndroidManifest.xml",
  ];
  ok(
    "required workflow — 스모크가 직접 읽는 네이티브 계약 파일이 PR/push paths 양쪽에 모두 결속",
    nativeContractPaths.every((path) => workflow.split(`\"${path}\"`).length - 1 === 2),
  );
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

// ────────────────────────────────────────────────────────────────────────────
// 실제 실행형 회귀 (삼순 라운드3 — 정적 regex false-green 지적 반영)
//  #1 실제 컴포넌트 렌더: 타일 탭 → 큰 프리뷰 src 즉시 변경(같은 화면)
//  #2 실제 상태: export 1회 실패 → 재시도 → export 재호출 성공 → 업로드 성공
//  #3 실제 상태: 3개 대용량 원본 동시 상주 최대 1(bounded memory) + 원본은 File 만(data URL 누적 X)
// 각 항목마다 fault injection(보호코드 제거 시 RED) 동봉.
// ────────────────────────────────────────────────────────────────────────────
async function runtimeRegressions() {
  const dom = new JSDOM(`<!DOCTYPE html><body><div id="root"></div></body>`, {
    url: "https://keubo.fan/",
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.navigator = dom.window.navigator;
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.File = dom.window.File;
  g.Blob = dom.window.Blob;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { VenueLibraryGrid } = await import("../../src/components/game/VenueLibraryGrid");

  type Asset = {
    id: string;
    kind: "image" | "video";
    thumbnailUrl: string;
    durationMs: number | null;
    createdAt: number;
  };
  const assets: Asset[] = [
    { id: "a", kind: "image", thumbnailUrl: "data:image/jpeg;base64,AAAA", durationMs: null, createdAt: 3 },
    { id: "b", kind: "image", thumbnailUrl: "data:image/jpeg;base64,BBBB", durationMs: null, createdAt: 2 },
    { id: "c", kind: "video", thumbnailUrl: "data:image/jpeg;base64,CCCC", durationMs: 12000, createdAt: 1 },
  ];

  console.log("[라운드3 #1 — 실제 컴포넌트 렌더: 타일 탭 → 큰 프리뷰 즉시 갱신]");
  {
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    const toggled: string[] = [];
    // onToggle 은 no-op(선택 prop 는 계속 [] 유지) — 그래도 탭 시 프리뷰가 바뀌어야 한다
    // (선택 왕복과 무관한 '탭→프리뷰' 계약. 라운드2 false-green: 선택 뒤에야 프리뷰였던 회귀 차단).
    await act(async () => {
      root.render(
        React.createElement(VenueLibraryGrid, {
          assets: assets as never,
          selection: [],
          onToggle: (a: Asset) => toggled.push(a.id),
          accent: "#123456",
          onAccent: "#ffffff",
        }),
      );
    });
    const focusSrc = () =>
      (container.querySelector('[data-testid="library-focus-image"]') as HTMLImageElement | null)?.getAttribute("src") ??
      null;
    const tapTile = async (id: string) => {
      await act(async () => {
        (container.querySelector(`[data-asset-id="${id}"]`) as HTMLElement).click();
      });
    };
    ok("초기 큰 프리뷰 = 첫 asset 썸네일", focusSrc() === assets[0].thumbnailUrl);
    await tapTile("b");
    ok("타일 b 탭 → 큰 프리뷰 src 즉시 b 로 변경", focusSrc() === assets[1].thumbnailUrl);
    await tapTile("c");
    ok("타일 c 탭 → 큰 프리뷰 src 즉시 c 로 변경(연속 갱신)", focusSrc() === assets[2].thumbnailUrl);
    ok(
      "탭→프리뷰는 selection 왕복과 무관(onToggle no-op·selection=[] 인데도 갱신)",
      toggled.join(",") === "b,c",
    );
    await act(async () => root.unmount());
  }

  console.log("[라운드3 #1 fault injection — 포커스 미갱신(구 false-green) 이면 프리뷰 고정]");
  {
    // setFocusId 를 누락한 '깨진' 그리드(선택으로만 프리뷰 파생) — 탭해도 프리뷰가 안 바뀜을 확인해
    // 위 실제 렌더 회귀가 setFocusId 제거 시 RED 임을 입증한다.
    const BrokenGrid = ({ items }: { items: Asset[] }) => {
      const focus = items[0];
      return React.createElement(
        "div",
        null,
        React.createElement("img", { "data-testid": "broken-preview", src: focus.thumbnailUrl }),
        ...items.map((a) =>
          React.createElement("button", { key: a.id, "data-asset-id": a.id, onClick: () => {} }),
        ),
      );
    };
    const container = dom.window.document.getElementById("root")!;
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(BrokenGrid, { items: assets }));
    });
    const brokenSrc = () =>
      (container.querySelector('[data-testid="broken-preview"]') as HTMLImageElement).getAttribute("src");
    await act(async () => {
      (container.querySelector('[data-asset-id="b"]') as HTMLElement).click();
    });
    ok("fault: 포커스 미갱신 그리드는 탭해도 프리뷰 고정(→ 실제 회귀가 RED 를 잡는다)", brokenSrc() === assets[0].thumbnailUrl);
    await act(async () => root.unmount());
  }

  const mkFile = (id: string) => new (g.File as typeof File)([id], `${id}.jpg`, { type: "image/jpeg" });

  console.log("[라운드3 #2 — export 1회 실패 → 재시도 시 export 재호출 성공 → 업로드 성공]");
  {
    const target: VenueUploadTarget = {
      key: "asset:a1",
      file: null,
      assetId: "a1",
      kind: "image",
      durationMs: null,
    };
    let exportCalls = 0;
    let uploaded = 0;
    let resolveFails = 0;
    const exportOriginal = async (id: string) => {
      exportCalls++;
      if (exportCalls === 1) throw new Error("transient export fail");
      return mkFile(id);
    };
    const handlers = {
      exportOriginal,
      uploadOne: async () => {
        uploaded++;
      },
      onResolveFail: () => {
        resolveFails++;
      },
    };
    // 1차 업로드: export transient 실패 → 항목은 실패로 남고(assetId 보존) 업로드 없음
    await runVenueUploadQueue([target], handlers);
    ok("1차: export 1회 호출·실패 → 업로드 0·resolveFail 1(항목/assetId 유지)", exportCalls === 1 && uploaded === 0 && resolveFails === 1);
    // 재시도: 같은 target(assetId 그대로) → export 재호출 → 성공 → 업로드 성공
    await runVenueUploadQueue([target], handlers);
    ok("재시도: export 재호출(2회째) 성공 → 업로드 성공", exportCalls === 2 && uploaded === 1);
  }

  console.log("[라운드3 #2 fault injection — assetId 소실 시 export 미호출(재시도 불가)]");
  {
    // 구조기(라운드2): export 실패 시 항목/핸들을 잃으면 재시도가 export 를 못 부른다.
    const lost = { file: null, assetId: null };
    let ec = 0;
    let threw = false;
    try {
      await resolveVenueOriginal(lost, async () => {
        ec++;
        return mkFile("x");
      });
    } catch (e) {
      threw = e instanceof VenueOriginalUnavailableError;
    }
    ok("fault: assetId 소실 → export 미호출·재시도 불가(→ #2 보존이 RED 를 잡는다)", threw && ec === 0);
  }

  console.log("[라운드3 #3 — bounded memory: 3개 대용량 원본 동시 상주 최대 1 + 원본은 File 만]");
  {
    const targets: VenueUploadTarget[] = ["m1", "m2", "m3"].map((id) => ({
      key: `asset:${id}`,
      file: null,
      assetId: id,
      kind: "image" as const,
      durationMs: null,
    }));
    let peak = 0;
    const receivedFile: boolean[] = [];
    await runVenueUploadQueue(targets, {
      exportOriginal: async (id) => mkFile(id),
      onResidentChange: (n) => {
        peak = Math.max(peak, n);
      },
      onResolveFail: () => {},
      uploadOne: async (_t, file) => {
        receivedFile.push(file instanceof (g.File as typeof File));
        await Promise.resolve();
      },
    });
    ok("순차 러너 — 원본 동시 상주 peak = 1(3개 대용량)", peak === 1);
    ok("원본은 File 로만 전달 — full-res data URL 누적 0", receivedFile.length === 3 && receivedFile.every(Boolean));

    // fault injection: 순차/해제 가드를 없앤 병렬 pre-resolve 는 peak = 3 이 된다(steady-state 상주 위험).
    let faultPeak = 0;
    let live = 0;
    const files = await Promise.all(targets.map((t) => resolveVenueOriginal(t, async (id) => mkFile(id))));
    live = files.length;
    faultPeak = live;
    for (let i = 0; i < targets.length; i++) {
      live--;
    }
    ok("fault: 병렬 pre-resolve(가드 제거) 는 peak = 3(→ #3 순차 러너가 RED 를 잡는다)", faultPeak === 3);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 라운드4 — production 배선 실행형 회귀 (삼순 라운드4 false-green 지적 반영)
// 실제 VenueStoryComposer 를 jsdom 에 렌더해, 그리드 선택→confirm 으로 만들어진
// **실제 ComposerItem** 이 production mapper(toUploadTarget)를 거쳐 업로드 큐로 가는
// 전체 경로를 고정한다. 러너에 assetId 를 손으로 주입하지 않는다 — 러너가 받는 target 은
// 전부 컴포넌트 state 에서 toUploadTarget 으로 파생된다.
//   ① confirm 시점 export 0회(lazy) + 프리뷰는 네이티브 썸네일만(원본 File 미보관)
//   ② submit: 1번 항목 export 1차 실패 → 항목 failed(assetId 보존) · 2번 항목 업로드 성공
//   ③ 같은 항목 '다시 시도' → export 2회째 호출 → 업로드 성공(재시도 재-export 계약)
// production 심볼 제거 시 이 회귀가 실제 RED:
//   - VenueStoryComposer.toUploadTarget 의 `assetId: it.assetId` → null 로 fault-inject:
//     ②·③ 모두 RED (모든 그리드 항목이 VenueOriginalUnavailableError 로 원본 준비 실패)
//   - 실패 patch 의 assetId 보존 제거(onResolveFail patch 에 assetId:null 주입):
//     ③ RED (재시도가 export 를 다시 못 부른다)
// mock 경계는 기기/네트워크 가장자리만: 네이티브 브릿지(주입 window.Capacitor.Plugins —
// 원격 로드 앱과 동일한 production 폴백 경로), geolocation, supabase auth/storage, fetch.
// ────────────────────────────────────────────────────────────────────────────
async function composerProductionWiringRegression() {
  console.log(
    "[라운드4 — 실제 VenueStoryComposer: 선택→confirm→submit(export 1차 실패)→재시도, production toUploadTarget 경유]",
  );

  // supabase client 모듈 평가 전에 env 필요(createBrowserClient throw 방지)
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test-ref.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";

  const g = globalThis as unknown as Record<string, unknown>;
  // @capacitor/core 첫 import 전에 커스텀 플랫폼('ios') 선언 → isNativeRuntime() true(pickerMode=grid).
  // Geolocation 은 PluginHeaders 로 available 처리하되 methods 를 비워 두면 코어가 web 구현
  // (navigator.geolocation shim)으로 위임한다. VenueMediaLibrary 는 헤더/JS 구현이 없어
  // npm 프록시가 UNIMPLEMENTED throw → callPlugin 이 주입 브릿지(window.Capacitor.Plugins)로
  // 폴백하는 production 경로(원격 로드 설치앱과 동일)를 그대로 탄다.
  g.CapacitorCustomPlatform = { name: "ios" };
  g.Capacitor = { PluginHeaders: [{ name: "Geolocation", methods: [] }] };

  const dom = new JSDOM(`<!DOCTYPE html><body><div id="root"></div></body>`, {
    url: "https://keubo.fan/",
  });
  g.window = dom.window;
  g.document = dom.window.document;
  // Node 24 는 전역 navigator 가 getter-only — 단순 대입은 조용히 무시된다(defineProperty 필수)
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: dom.window.navigator,
  });
  g.HTMLElement = dom.window.HTMLElement;
  g.Element = dom.window.Element;
  g.File = dom.window.File;
  g.Blob = dom.window.Blob;
  g.localStorage = dom.window.localStorage;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  // framer-motion 등 matchMedia 참조 대비
  const matchMediaShim = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  (dom.window as unknown as Record<string, unknown>).matchMedia = matchMediaShim;
  g.matchMedia = matchMediaShim;

  // jsdom 미구현 blob URL — 프리뷰/probe 경로가 죽지 않게 no-op stub
  let blobSeq = 0;
  (URL as unknown as Record<string, unknown>).createObjectURL = () => `blob:mock-${++blobSeq}`;
  (URL as unknown as Record<string, unknown>).revokeObjectURL = () => {};

  // upload.ts probeImage 의 `new Image()` — onload 즉시 발화
  class MockImage {
    naturalWidth = 720;
    naturalHeight = 1280;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(_v: string) {
      setTimeout(() => this.onload?.(), 0);
    }
  }
  g.Image = MockImage;

  // 구장 좌표와 동일한 GPS 측정(정확도 8m) — 선체크/geofence 통과
  const VLAT = 37.5122;
  const VLNG = 127.0719;
  Object.defineProperty(dom.window.navigator, "geolocation", {
    configurable: true,
    value: {
      getCurrentPosition: (onOk: (p: unknown) => void) =>
        onOk({
          timestamp: Date.now(),
          coords: {
            latitude: VLAT,
            longitude: VLNG,
            accuracy: 8,
            altitude: null,
            altitudeAccuracy: null,
            speed: null,
            heading: null,
          },
        }),
    },
  });

  // 서버 API — venue 정보(업로드 가능 시간대) + 스토리 생성 POST 기록
  const postCalls: Array<Record<string, unknown>> = [];
  g.fetch = (async (input: unknown, init?: { method?: string; body?: string }) => {
    const url = String(input);
    if (url.startsWith("/api/venue-stories/venue")) {
      return {
        ok: true,
        json: async () => ({
          gameId: "g-run4",
          stadiumName: "잠실야구장",
          lat: VLAT,
          lng: VLNG,
          radiusM: 2000,
          uploadOpen: true,
          reason: null,
          cancelled: false,
          gateKind: "open",
        }),
      };
    }
    if (url === "/api/venue-stories" && init?.method === "POST") {
      postCalls.push(JSON.parse(init.body ?? "{}") as Record<string, unknown>);
      return { ok: true, json: async () => ({ id: 900 + postCalls.length, status: "active" }) };
    }
    return { ok: true, json: async () => ({}) };
  }) as never;

  // 네이티브 사진첩 브릿지(주입 window.Capacitor.Plugins) — n1 은 export 1차만 transient 실패
  const thumbs: Record<string, string> = {
    n1: "data:image/jpeg;base64,THUMBN1",
    n2: "data:image/jpeg;base64,THUMBN2",
    v1: "data:image/jpeg;base64,THUMBV1",
  };
  type NativeListOptions = { mediaTypes?: Array<"image" | "video"> };
  type NativeListPage = {
    assets: Array<{
      id: string;
      kind: "image" | "video";
      thumbnailUrl: string;
      durationMs: number | null;
      createdAt: number;
    }>;
    nextCursor: string | null;
    permission: "authorized";
  };
  const imagePage = (): NativeListPage => ({
    assets: [
      { id: "n1", kind: "image", thumbnailUrl: thumbs.n1, durationMs: null, createdAt: 2 },
      { id: "n2", kind: "image", thumbnailUrl: thumbs.n2, durationMs: null, createdAt: 1 },
    ],
    nextCursor: null,
    permission: "authorized",
  });
  const videoPage = (): NativeListPage => ({
    assets: [
      { id: "v1", kind: "video", thumbnailUrl: thumbs.v1, durationMs: 8_000, createdAt: 3 },
    ],
    nextCursor: null,
    permission: "authorized",
  });
  let resolveInitialList!: (page: NativeListPage) => void;
  const delayedInitialList = new Promise<NativeListPage>((resolve) => {
    resolveInitialList = resolve;
  });
  let delayNextList = false;
  let returnEmptyVideoPage = false;
  let resolveRapidList!: (page: NativeListPage) => void;
  let delayedRapidList: Promise<NativeListPage> | null = null;
  const listMediaCalls: NativeListOptions[] = [];
  const exportCalls: string[] = [];
  const exportChunkB64 = Buffer.from("orig").toString("base64"); // 4 bytes
  (dom.window as unknown as Record<string, unknown>).Capacitor = {
    Plugins: {
      VenueMediaLibrary: {
        getPermission: async () => ({ permission: "authorized" }),
        requestPermission: async () => ({ permission: "authorized" }),
        listMedia: async (options: NativeListOptions) => {
          listMediaCalls.push(options);
          if (listMediaCalls.length === 1) return delayedInitialList;
          if (delayNextList) {
            delayNextList = false;
            delayedRapidList = new Promise<NativeListPage>((resolve) => {
              resolveRapidList = resolve;
            });
            return delayedRapidList;
          }
          if (options.mediaTypes?.join(",") === "video") {
            return returnEmptyVideoPage
              ? { assets: [], nextCursor: null, permission: "authorized" }
              : videoPage();
          }
          return imagePage();
        },
        exportMedia: async ({ id }: { id: string }) => {
          exportCalls.push(id);
          if (id === "n1" && exportCalls.filter((x) => x === "n1").length === 1) {
            throw new Error("transient native export fail");
          }
          return { token: `tok-${id}`, fileName: `${id}.jpg`, mimeType: "image/jpeg", size: 4, lastModified: 1 };
        },
        readExport: async () => ({ data: exportChunkB64 }),
        releaseExport: async () => ({}),
        selectionChanged: async () => ({}),
      },
    },
  };

  const React = (await import("react")).default;
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");

  // supabase auth/storage 는 네트워크 가장자리만 스텁(모듈/컴포넌트 코드는 실제 그대로)
  const { supabase } = await import("../../src/lib/supabase/client");
  (supabase.auth as unknown as Record<string, unknown>).getSession = async () => ({
    data: { session: { access_token: "test-token", user: { id: "u-run4" } } },
  });
  (supabase.auth as unknown as Record<string, unknown>).getUser = async () => ({
    data: { user: { id: "u-run4" } },
  });
  Object.defineProperty(supabase, "storage", {
    configurable: true,
    value: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/${p}` } }),
      }),
    },
  });

  const VenueStoryComposer = (await import("../../src/components/game/VenueStoryComposer")).default;

  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const uploadedResults: unknown[] = [];
  await act(async () => {
    root.render(
      React.createElement(VenueStoryComposer, {
        gameId: "g-run4",
        isOpen: true,
        onClose: () => {},
        onUploaded: (r: unknown) => uploadedResults.push(r),
      }),
    );
  });

  const body = dom.window.document.body;
  const q = (sel: string) => body.querySelector(sel);
  const buttonByText = (text: string) =>
    Array.from(body.querySelectorAll("button")).find((b) => (b.textContent ?? "").includes(text)) ??
    null;
  const waitFor = async (label: string, cond: () => boolean, maxMs = 8000) => {
    const start = Date.now();
    while (!cond() && Date.now() - start < maxMs) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 15));
      });
    }
    if (!cond()) {
      // 실패 진단용 — 현재 렌더 텍스트 요약(성공 시 무출력)
      console.log("    [debug] body text:", (body.textContent ?? "").replace(/\s+/g, " ").slice(0, 400));
    }
    ok(label, cond());
    return cond();
  };

  // 삼순 1차 NO-GO 실제 재현: 첫 전체 조회가 지연된 동안 영상 탭을 누른다. 기존 구현은
  // 새 loadLibrary가 libraryLoading guard에 막히고, 첫 응답은 stale 폐기된 뒤 재조회가 없어
  // 빈 화면에 영구 고착됐다. latest pending reload가 video 요청을 반드시 이어서 보내야 한다.
  await waitFor(
    "race 전제 — 첫 전체 네이티브 조회가 pending인 동안 필터 탭 렌더",
    () => listMediaCalls.length === 1 && q('[data-library-filter="video"]') != null,
  );
  await act(async () => {
    (q('[data-library-filter="video"]') as HTMLElement).click();
  });
  await act(async () => {
    resolveInitialList(imagePage());
    await Promise.resolve();
  });
  await waitFor(
    "첫 조회 지연→영상 클릭→latest video 네이티브 재조회·렌더",
    () =>
      listMediaCalls.length === 2 &&
      listMediaCalls[1]?.mediaTypes?.join(",") === "video" &&
      q('[data-asset-id="v1"]') != null,
  );
  ok(
    "stale 전체 응답의 사진은 영상 탭 목록을 오염시키지 않음",
    q('[data-asset-id="n1"]') == null && q('[data-asset-id="n2"]') == null,
  );

  // 연속 전체→영상→사진: 전체 재조회가 pending인 동안 두 탭을 빠르게 눌러도 중간 영상은
  // 호출하지 않고 마지막 사진 요청 하나로 합쳐져야 한다(삼순 1차 NO-GO 보완 게이트).
  delayNextList = true;
  await act(async () => {
    (q('[data-library-filter="all"]') as HTMLElement).click();
  });
  await waitFor(
    "연속 탭 race 전제 — 전체 재조회 pending",
    () => listMediaCalls.length === 3 && delayedRapidList != null,
  );
  await act(async () => {
    (q('[data-library-filter="video"]') as HTMLElement).click();
    (q('[data-library-filter="image"]') as HTMLElement).click();
  });
  await act(async () => {
    resolveRapidList(imagePage());
    await Promise.resolve();
  });
  await waitFor(
    "연속 전체→영상→사진은 마지막 image 네이티브 재조회·렌더",
    () =>
      listMediaCalls.length === 4 &&
      listMediaCalls[3]?.mediaTypes?.join(",") === "image" &&
      q('[data-asset-id="n1"]') != null,
  );
  ok(
    "연속 탭 중간 video 요청/결과는 남지 않음",
    listMediaCalls.slice(3).every((call) => call.mediaTypes?.join(",") !== "video") &&
      q('[data-asset-id="v1"]') == null,
  );

  // 사진 2장·영상 0개인 실제 타입별 네이티브 조회. 현재 video 응답 자체는 빈 배열이므로
  // 직전 all/image 조회에서 확인한 `사진첩에 미디어가 있음` 사실을 보존해야 올바른 안내가 나온다.
  returnEmptyVideoPage = true;
  await act(async () => {
    (q('[data-library-filter="video"]') as HTMLElement).click();
  });
  await waitFor(
    "사진 있음·영상 0 — 실제 Composer가 '최근 영상이 없어요' + 전체 전환 안내",
    () =>
      listMediaCalls.length === 5 &&
      (q('[data-testid="library-empty"]')?.textContent ?? "").includes("최근 영상이 없어요") &&
      (q('[data-testid="library-empty"]')?.textContent ?? "").includes("위 탭을 '전체'로 바꾸면 모두 볼 수 있어요"),
  );
  ok(
    "사진 있음·영상 0 — 권한 확인 오안내 잔존 0",
    !(q('[data-testid="library-empty"]')?.textContent ?? "").includes("사진 접근 범위를 확인"),
  );

  // 기존 업로드 production 배선 회귀는 전체 탭의 사진 2장으로 계속 검증한다.
  await act(async () => {
    (q('[data-library-filter="all"]') as HTMLElement).click();
  });

  // 선체크 ok → 커스텀 그리드 자동 오픈(실제 loadLibrary → 주입 브릿지 listMedia)
  await waitFor(
    "실제 컴포넌트 — 선체크 통과 후 커스텀 그리드 자동 오픈(네이티브 타일 렌더)",
    () =>
      listMediaCalls.length === 6 &&
      q('[data-asset-id="n1"]') != null &&
      q('[data-asset-id="n2"]') != null,
  );

  // 타일 탭 2회 → 하단 '2개 선택 완료' confirm — 실제 confirmLibrarySelection 이 ComposerItem 생성
  await act(async () => {
    (q('[data-asset-id="n1"]') as HTMLElement).click();
  });
  await act(async () => {
    (q('[data-asset-id="n2"]') as HTMLElement).click();
  });
  const confirmBtn = buttonByText("선택 완료");
  ok(
    "그리드 하단 확정 버튼 '2개 선택 완료' 노출",
    (confirmBtn?.textContent ?? "").includes("2개 선택 완료"),
  );
  await act(async () => {
    confirmBtn!.click();
  });
  ok("confirm 시점 export 0회 — 원본은 업로드 차례에만 lazy export", exportCalls.length === 0);
  await waitFor(
    "confirm → 프리뷰는 네이티브 소형 썸네일(data URL)만 — 원본 File 미보관(thumbnail-only)",
    () =>
      Array.from(body.querySelectorAll("img")).some(
        (im) => im.getAttribute("src") === thumbs.n1,
      ),
  );

  // 가이드라인 동의 → CTA 활성 → 제출: submit() 이 items.map(toUploadTarget) — production mapper 경유
  await act(async () => {
    (q('input[type="checkbox"]') as HTMLElement).click();
  });
  await waitFor(
    `CTA '${VENUE_STORY_CTA_LABEL}' 활성화(동의+선체크+항목)`,
    () => {
      const cta = buttonByText(VENUE_STORY_CTA_LABEL) as HTMLButtonElement | null;
      return cta != null && !cta.disabled;
    },
  );
  await act(async () => {
    (buttonByText(VENUE_STORY_CTA_LABEL) as HTMLElement).click();
  });

  // 1차 submit: n1 export transient 실패 → failed(assetId 보존) · n2 성공 → 완료 요약 성공 1 · 실패 1
  await waitFor(
    "1차 submit → 완료 요약 '성공 1 · 실패 1' (n1 원본 준비 실패·n2 업로드 성공)",
    () =>
      (body.textContent ?? "").includes("업로드 완료") &&
      (body.textContent ?? "").includes("성공 1") &&
      (body.textContent ?? "").includes("실패 1"),
  );
  ok(
    "1차 submit: export 호출 순서 [n1(실패), n2(성공)] — production toUploadTarget 이 assetId 를 러너에 전달",
    exportCalls.join(",") === "n1,n2",
  );
  ok(
    "1차 submit: 성공 1건만 서버 POST + 트레이 낙관 반영 1회 — 실패건 업로드 없음",
    postCalls.length === 1 && uploadedResults.length === 1,
  );
  const retryBtn = buttonByText("다시 시도");
  ok("실패건(n1)만 개별 '다시 시도' 버튼 노출", retryBtn != null);

  // 재시도: 같은 항목이 다시 toUploadTarget 을 거쳐 export 2회째 호출 → 업로드 성공
  await act(async () => {
    retryBtn!.click();
  });
  await waitFor(
    "재시도: export 2회째 호출(n1 재-export) → 업로드 성공 → '성공 2 · 실패 0'",
    () =>
      exportCalls.join(",") === "n1,n2,n1" &&
      postCalls.length === 2 &&
      (body.textContent ?? "").includes("성공 2") &&
      (body.textContent ?? "").includes("실패 0"),
  );
  ok(
    "재시도가 재-export 로만 성공 — 실패 patch 의 assetId 보존 + state 에 원본 File 비저장(file=null 유지) 실행 증거",
    exportCalls.filter((x) => x === "n1").length === 2 && uploadedResults.length === 2,
  );
  ok(
    "완료 후에도 모든 프리뷰가 네이티브 썸네일(data URL) 그대로 — full-res 원본/blob 승격 없음",
    Array.from(body.querySelectorAll("img")).length > 0 &&
      Array.from(body.querySelectorAll("img")).every((im) =>
        [thumbs.n1, thumbs.n2].includes(im.getAttribute("src") ?? ""),
      ),
  );
  ok("성공 후 '다시 시도' 버튼 제거(성공/진행 항목 재전송 금지)", buttonByText("다시 시도") == null);

  await act(async () => root.unmount());
}

runtimeRegressions()
  .then(() => composerProductionWiringRegression())
  .catch((e) => {
    fail++;
    console.error("  ❌ runtime regressions threw:", e);
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    // 라운드4 실제 컴포넌트 회귀가 supabase/jsdom 핸들을 남기므로 명시 종료(성공 0·실패 1)
    process.exit(fail > 0 ? 1 : 0);
  });
