import assert from "node:assert/strict";
import {
  applyDiaryDetailUrlRefresh,
  applyDiaryThumbUrlRefresh,
  buildDiaryCountsMap,
  buildDiaryHomeGames,
  classifyDiaryPendingPoll,
  diaryAddSelectDisabled,
  diaryCountsOwnerKey,
  diaryCountsReady,
  diaryBottomCta,
  diaryCanStartUpload,
  diaryCaptionForSubmit,
  diaryDisplaySummary,
  diaryGameSourceLabel,
  diaryLeaveNotice,
  diaryMediaSourceLabel,
  diaryPendingTerminalPhase,
  diaryPickCaption,
  diaryPickLocked,
  diaryPickState,
  diaryShowsComments,
  diaryUploadBadge,
  diaryUploadCta,
  diaryUploadTargets,
  diaryWinRateScopeCaption,
  DIARY_WIN_RATE_DEFAULT_SCOPE,
  makeDiaryThumbRefresh,
  mergeDiaryMediaPages,
  mergeDiarySummaryPairs,
  mergeVenueSummaries,
  shouldFetchNextDiaryPage,
  startDiaryPendingPoll,
  VENUE_DIARY_HOME_THUMBNAILS,
  VENUE_DIARY_MAX_LIST_PAGES,
  VENUE_DIARY_MEDIA_CAP,
  type DiaryMediaGroupInput,
  type DiaryPendingProbe,
  type DiaryPendingTerminal,
  type DiaryUploadItemState,
} from "../../src/lib/venue-diary/view";
import {
  startVenueStoryUrlRefresh,
  VENUE_STORY_URL_REFRESH_MS,
  VENUE_STORY_URL_RETRY_MS,
  VENUE_STORY_URL_MINT_TIMEOUT_MS,
} from "../../src/lib/venue-stories/refresh-policy";

// 가상 클럭 — loop 타이머와 mint timeout 타이머를 같은 시간축에서 구동해 8s abort→10s retry 를 재현.
class Clock {
  now = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (id: number): void => {
    this.tasks.delete(id);
  };
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Infinity;
      for (const [id, t] of this.tasks) {
        if (t.at <= target && t.at < nextAt) {
          nextAt = t.at;
          nextId = id;
        }
      }
      if (nextId === -1) break;
      const task = this.tasks.get(nextId)!;
      this.tasks.delete(nextId);
      this.now = task.at;
      task.fn();
      // 마이크로태스크 플러시(Promise.race/await 체인 해소)
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    }
    this.now = target;
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

// 1) 경기 카드 라벨: 썸네일 중 하나라도 GPS 인증이면 GPS 인증, 아니면 직접 추가
{
  assert.deepEqual(
    diaryGameSourceLabel([{ venueVerified: false }, { venueVerified: true }]),
    { kind: "gps", text: "GPS 인증" },
    "하나라도 GPS면 GPS 인증",
  );
  assert.deepEqual(
    diaryGameSourceLabel([{ venueVerified: false }, { venueVerified: false }]),
    { kind: "manual", text: "직접 추가" },
    "전부 직접 추가면 직접 추가",
  );
  assert.deepEqual(diaryGameSourceLabel([]), { kind: "manual", text: "직접 추가" });
  assert.equal(diaryMediaSourceLabel(true).text, "GPS 인증");
  assert.equal(diaryMediaSourceLabel(false).text, "직접 추가");
  // '인증'이 아니라 정확히 'GPS 인증'(삼순 조건부 GO)
  assert.equal(diaryMediaSourceLabel(true).text, "GPS 인증");
}

// 2) 경기 선택 픽 상태: 0=선택 / 부분=N/10 더 추가 / 가득=잠금
{
  assert.deepEqual(diaryPickState(0), { kind: "pick" });
  assert.deepEqual(diaryPickState(2), { kind: "add", count: 2, cap: VENUE_DIARY_MEDIA_CAP });
  assert.deepEqual(diaryPickState(VENUE_DIARY_MEDIA_CAP), {
    kind: "locked",
    cap: VENUE_DIARY_MEDIA_CAP,
  });
  assert.deepEqual(diaryPickState(999), { kind: "locked", cap: VENUE_DIARY_MEDIA_CAP });
  assert.equal(VENUE_DIARY_MEDIA_CAP, 10, "경기당 상한 10");

  assert.equal(diaryPickCaption(diaryPickState(0)), null);
  assert.equal(diaryPickCaption(diaryPickState(2)), "이미 2개 올림");
  assert.equal(diaryPickCaption(diaryPickState(10)), "가득 채움");

  assert.equal(diaryPickLocked(diaryPickState(9)), false);
  assert.equal(diaryPickLocked(diaryPickState(10)), true);
  // 음수/NaN 방어
  assert.deepEqual(diaryPickState(-3), { kind: "pick" });
  assert.deepEqual(diaryPickState(Number.NaN), { kind: "pick" });
}

// 3) 업로드 항목 배지: 완료/업로드 %/영상 처리 중/실패
{
  assert.deepEqual(diaryUploadBadge({ phase: "done" }), { kind: "done", label: "완료" });
  assert.deepEqual(diaryUploadBadge({ phase: "uploading", percent: 62 }), {
    kind: "uploading",
    label: "업로드 중 62%",
  });
  // percent clamp/반올림
  assert.equal(diaryUploadBadge({ phase: "uploading", percent: 61.6 }).label, "업로드 중 62%");
  assert.equal(diaryUploadBadge({ phase: "uploading", percent: 240 }).label, "업로드 중 100%");
  assert.equal(diaryUploadBadge({ phase: "uploading" }).label, "업로드 중 0%");
  assert.deepEqual(diaryUploadBadge({ phase: "processing" }), {
    kind: "processing",
    label: "영상 처리 중",
  });
  assert.deepEqual(diaryUploadBadge({ phase: "failed" }), {
    kind: "failed",
    label: "실패 · 다시 시도",
  });
  assert.equal(diaryUploadBadge({ phase: "queued" }).kind, "queued");
}

// 4) 배치 CTA: 업로드>처리>완료 우선순위 + 처리 중 서브안내
{
  assert.equal(diaryUploadCta([]).kind, "idle");

  const uploading: DiaryUploadItemState[] = [
    { phase: "uploading", percent: 30 },
    { phase: "done" },
  ];
  assert.deepEqual(diaryUploadCta(uploading), {
    kind: "wait",
    label: "1개 올리는 중…",
    subLabel: null,
  });

  const processing: DiaryUploadItemState[] = [
    { phase: "processing", mediaType: "video" },
    { phase: "done" },
  ];
  const cta = diaryUploadCta(processing);
  assert.equal(cta.kind, "wait");
  assert.equal(cta.label, "1개 처리 중 · 나머지 저장됨");
  assert.ok(cta.subLabel && cta.subLabel.includes("자동으로"), "처리 중 서브 안내");

  assert.deepEqual(diaryUploadCta([{ phase: "done" }, { phase: "done" }]), {
    kind: "go",
    label: "2개 저장 완료",
    subLabel: null,
  });

  const mixed = diaryUploadCta([{ phase: "done" }, { phase: "failed" }]);
  assert.equal(mixed.kind, "go");
  assert.equal(mixed.label, "1개 저장됨 · 1개 실패");

  assert.equal(diaryUploadCta([{ phase: "failed" }]).kind, "idle");
  assert.equal(diaryUploadCta([{ phase: "queued" }]).kind, "idle");
}

// 5) 상세 댓글 노출: GPS만 true
{
  assert.equal(diaryShowsComments(true), true);
  assert.equal(diaryShowsComments(false), false);
}

// 6) 홈 병합: 미디어 순서 보존 + 성적 join + 썸네일 상한/+N
{
  const mediaGroups: DiaryMediaGroupInput[] = [
    {
      gameId: "G2",
      gameDate: "2026-07-22",
      stadiumName: "잠실",
      counts: { image: 5, video: 1, total: 9 },
      thumbnails: Array.from({ length: 8 }, (_, i) => ({
        id: i + 1,
        mediaType: i === 1 ? "video" : "image",
        thumbUrl: `https://cdn/${i}.jpg`,
        venueVerified: true,
      })),
    },
    {
      gameId: "G1",
      gameDate: "2026-05-04",
      stadiumName: "잠실",
      counts: { image: 2, video: 0, total: 2 },
      thumbnails: [
        { id: 21, mediaType: "image", thumbUrl: "https://cdn/a.jpg", venueVerified: false },
        { id: 22, mediaType: "image", thumbUrl: "https://cdn/b.jpg", venueVerified: false },
      ],
    },
  ];
  const attendanceGames = [
    {
      gameId: "G2",
      result: "W" as const,
      awayTeam: { id: 9, name: "한화", score: 1 },
      homeTeam: { id: 1, name: "LG", score: 2 },
    },
    // G1 은 성적 정보 없음(join 미스) — result null 유지
  ];
  const games = buildDiaryHomeGames({ mediaGroups, attendanceGames });
  assert.equal(games.length, 2);
  assert.equal(games[0].gameId, "G2", "미디어 순서(최신) 보존");
  assert.equal(games[0].label.kind, "gps", "GPS 인증 썸네일 포함");
  assert.equal(games[0].thumbnails.length, VENUE_DIARY_HOME_THUMBNAILS, "썸네일 상한 6");
  assert.equal(games[0].extraCount, 3, "total 9 - 표시 6 = +3");
  assert.equal(games[0].total, 9);
  assert.equal(games[0].result, "W");
  assert.equal(games[0].homeTeam?.score, 2);

  assert.equal(games[1].gameId, "G1");
  assert.equal(games[1].label.kind, "manual", "직접 추가만");
  assert.equal(games[1].thumbnails.length, 2);
  assert.equal(games[1].extraCount, 0, "total 2, 표시 2 → +0");
  assert.equal(games[1].result, null, "성적 join 미스는 null");
}

// 7) 시즌 summary 합산('전체' 세그먼트): winRate 는 합산 표본으로 재계산
{
  const merged = mergeVenueSummaries([
    { attendanceCount: 12, wins: 7, losses: 5, draws: 0, finalCount: 12, winRate: 7 / 12 },
    { attendanceCount: 8, wins: 3, losses: 4, draws: 1, finalCount: 8, winRate: 3 / 8 },
  ]);
  assert.equal(merged.attendanceCount, 20);
  assert.equal(merged.wins, 10);
  assert.equal(merged.losses, 9);
  assert.equal(merged.draws, 1);
  assert.equal(merged.finalCount, 20);
  // 기존 summarizeVenueAttendance 와 동일: 무승부도 분모 포함(finalCount 기준)
  assert.equal(merged.winRate, 10 / 20, "winRate = 합산 승/(승+패+무)");

  const empty = mergeVenueSummaries([]);
  assert.equal(empty.attendanceCount, 0);
  assert.equal(empty.winRate, null, "표본 0 → null");
}

// 7-1) 승률 범위 토글(2026-07-30 정책 변경): 기본 전체(직접 추가 포함) ↔ GPS 인증만
{
  assert.equal(DIARY_WIN_RATE_DEFAULT_SCOPE, "all", "기본값 = 직접 추가 포함 전체");

  // 시즌 A: GPS 1승 1패 / 전체 3승 1패(직접 추가 2승) · 시즌 B: GPS 1패 / 전체 1승 1패
  const seasonA = {
    certified: { attendanceCount: 2, wins: 1, losses: 1, draws: 0, finalCount: 2, winRate: 1 / 2 },
    overall: { attendanceCount: 4, wins: 3, losses: 1, draws: 0, finalCount: 4, winRate: 3 / 4 },
  };
  const seasonB = {
    certified: { attendanceCount: 1, wins: 0, losses: 1, draws: 0, finalCount: 1, winRate: 0 },
    overall: { attendanceCount: 2, wins: 1, losses: 1, draws: 0, finalCount: 2, winRate: 1 / 2 },
  };
  const merged = mergeDiarySummaryPairs([seasonA, seasonB]);
  assert.equal(merged.certified.attendanceCount, 3, "인증 직관수는 GPS 건만 합산");
  assert.equal(merged.certified.winRate, 1 / 3, "GPS-only 합산 승률");
  assert.equal(merged.overall.winRate, 4 / 6, "직접 추가 포함 합산 승률");

  // manual 포함 승률(기본) vs GPS-only 승률(토글)이 실제로 다른 값으로 전환된다.
  const shownDefault = diaryDisplaySummary(merged, DIARY_WIN_RATE_DEFAULT_SCOPE);
  assert.equal(shownDefault.winRate, 4 / 6, "기본 표시 = 전체 승률");
  assert.equal(shownDefault.wins, 4);
  const shownGps = diaryDisplaySummary(merged, "gps");
  assert.equal(shownGps.winRate, 1 / 3, "토글 표시 = GPS 인증만 승률");
  assert.equal(shownGps.wins, 1);
  assert.notEqual(shownDefault.winRate, shownGps.winRate, "두 범위 승률이 구분됨");

  assert.equal(diaryWinRateScopeCaption("all"), "승률·승패 · 직접 추가 포함");
  assert.equal(diaryWinRateScopeCaption("gps"), "승률·승패 · GPS 인증만");

  const emptyPair = mergeDiarySummaryPairs([]);
  assert.equal(emptyPair.overall.winRate, null, "표본 0 → null(전체)");
  assert.equal(emptyPair.certified.winRate, null, "표본 0 → null(GPS)");
}

// 8) Blocker 1 — 목록 cursor 전페이지 병합 + 무한루프 가드
{
  const mk = (gameId: string): DiaryMediaGroupInput => ({
    gameId,
    gameDate: "2026-07-01",
    stadiumName: "잠실",
    counts: { image: 1, video: 0, total: 1 },
    thumbnails: [
      { id: Number(gameId.replace(/\D/g, "")) || 0, mediaType: "image", thumbUrl: `u/${gameId}`, venueVerified: false },
    ],
  });
  // 페이지 경계 중복(G3)은 첫 등장만 남기고 순서 보존
  const merged = mergeDiaryMediaPages([
    { games: [mk("G1"), mk("G2"), mk("G3")] },
    { games: [mk("G3"), mk("G4")] },
  ]);
  assert.deepEqual(
    merged.map((g) => g.gameId),
    ["G1", "G2", "G3", "G4"],
    "cursor 병합 — 순서 보존 + gameId 중복 0",
  );

  // hasMore & 유효 cursor & 상한 미만일 때만 계속
  assert.equal(
    shouldFetchNextDiaryPage({ hasMore: true, nextCursor: "2026-07-01|G30", pagesFetched: 1 }),
    true,
  );
  assert.equal(
    shouldFetchNextDiaryPage({ hasMore: false, nextCursor: "2026-07-01|G30", pagesFetched: 1 }),
    false,
    "hasMore=false 면 중단",
  );
  assert.equal(
    shouldFetchNextDiaryPage({ hasMore: true, nextCursor: null, pagesFetched: 1 }),
    false,
    "cursor 없으면 중단",
  );
  assert.equal(
    shouldFetchNextDiaryPage({
      hasMore: true,
      nextCursor: "c",
      pagesFetched: VENUE_DIARY_MAX_LIST_PAGES,
    }),
    false,
    "상한 도달면 중단(무한루프 가드)",
  );
}

// 9) Blocker 1 — signed URL 재발급 apply(id/순서 보존, URL만 교체)
{
  const media = [
    { id: 1, mediaUrl: "old-1", thumbUrl: "t-1", caption: "a" },
    { id: 2, mediaUrl: "old-2", thumbUrl: null, caption: "b" },
  ];
  const refreshed = applyDiaryDetailUrlRefresh(media, [
    { id: 1, mediaUrl: "new-1", thumbUrl: "nt-1" },
    { id: 9, mediaUrl: "ghost", thumbUrl: null },
  ]);
  assert.equal(refreshed[0].mediaUrl, "new-1", "id 일치 URL 교체");
  assert.equal(refreshed[0].thumbUrl, "nt-1");
  assert.equal(refreshed[0].caption, "a", "메타(caption) 보존");
  assert.equal(refreshed[1].mediaUrl, "old-2", "fresh 없는 id 는 그대로");
  assert.deepEqual(
    refreshed.map((m) => m.id),
    [1, 2],
    "순서 보존",
  );

  const groups: DiaryMediaGroupInput[] = [
    {
      gameId: "G1",
      gameDate: "2026-07-01",
      stadiumName: "잠실",
      counts: { image: 2, video: 0, total: 2 },
      thumbnails: [
        { id: 11, mediaType: "image", thumbUrl: "old-11", venueVerified: false },
        { id: 12, mediaType: "image", thumbUrl: "old-12", venueVerified: false },
      ],
    },
  ];
  const freshGroups: DiaryMediaGroupInput[] = [
    {
      gameId: "G1",
      gameDate: "2026-07-01",
      stadiumName: "잠실",
      counts: { image: 2, video: 0, total: 2 },
      thumbnails: [
        { id: 11, mediaType: "image", thumbUrl: "new-11", venueVerified: false },
      ],
    },
  ];
  const rt = applyDiaryThumbUrlRefresh(groups, freshGroups);
  assert.equal(rt[0].thumbnails[0].thumbUrl, "new-11", "썸네일 thumbUrl 교체");
  assert.equal(rt[0].thumbnails[1].thumbUrl, "old-12", "fresh 없는 썸네일 보존");
  assert.equal(rt[0].counts.total, 2, "카운트 보존");
}

// 10) Blocker 2 — 명시적 업로드 CTA / caption 소스 / 전송 대상
{
  const queued: DiaryUploadItemState[] = [{ phase: "queued" }, { phase: "queued" }];
  // 동의 전: 시작 불가 + CTA 비활성
  assert.equal(diaryCanStartUpload(queued, false), false, "동의 전 시작 불가");
  const before = diaryBottomCta(queued, false);
  assert.equal(before.action, "upload");
  assert.equal(before.disabled, true, "동의 전 CTA disabled");
  // 동의 후: 시작 가능 + 명시적 업로드 CTA
  assert.equal(diaryCanStartUpload(queued, true), true);
  const after = diaryBottomCta(queued, true);
  assert.equal(after.action, "upload");
  assert.equal(after.kind, "start");
  assert.equal(after.disabled, false);
  assert.equal(after.label, "2개 올리기");

  // 업로드 중이면 진행 대기(close action, wait)
  const uploading: DiaryUploadItemState[] = [{ phase: "uploading", percent: 20 }, { phase: "queued" }];
  const mid = diaryBottomCta(uploading, true);
  assert.equal(mid.action, "close");
  assert.equal(mid.kind, "wait");
  assert.equal(mid.disabled, true);

  // 전부 완료면 close/go
  const done = diaryBottomCta([{ phase: "done" }, { phase: "done" }], true);
  assert.equal(done.action, "close");
  assert.equal(done.kind, "go");

  // 전송 대상: queued/failed 만, done 재전송 안 함
  const items = [
    { key: "a", state: { phase: "done" } as DiaryUploadItemState },
    { key: "b", state: { phase: "queued" } as DiaryUploadItemState },
    { key: "c", state: { phase: "failed" } as DiaryUploadItemState },
  ];
  assert.deepEqual(
    diaryUploadTargets(items).map((i) => i.key),
    ["b", "c"],
    "queued/failed 만 전송 — done 제외",
  );

  // caption 소스: 제출 시점 값 trim, 빈 문자열은 null
  assert.equal(diaryCaptionForSubmit("  방문 메모  "), "방문 메모");
  assert.equal(diaryCaptionForSubmit("   "), null);
  assert.equal(diaryCaptionForSubmit(""), null);
}

// 11) Blocker 3 — uploading 이탈 경고 / pending 안전 카피
{
  // uploading: 경고 tone + actual guard
  const up = diaryLeaveNotice([{ phase: "uploading", percent: 10 }, { phase: "done" }]);
  assert.equal(up.tone, "warn");
  assert.equal(up.guard, true, "uploading 중에만 actual guard");

  // processing: 안전(나가도 계속) + guard 없음
  const proc = diaryLeaveNotice([{ phase: "processing", mediaType: "video" }, { phase: "done" }]);
  assert.equal(proc.tone, "safe");
  assert.equal(proc.guard, false);
  assert.ok(proc.text.includes("계속"), "processing 은 '나가도 계속' 카피");

  // 빈/완료: 안전 + guard 없음 + 이탈 경고 카피 아님
  const idle = diaryLeaveNotice([{ phase: "done" }]);
  assert.equal(idle.guard, false);
  assert.ok(!idle.text.includes("중단"), "완료 상태는 중단 경고 아님");
}

async function runAsyncRegressions() {
// 12) Blocker 1 (actual-wiring) — never-settle refresh → 8s mint abort → 10s retry 성공.
//     컴포넌트가 쓰는 바로 그 makeDiaryThumbRefresh + mintWithTimeout + startVenueStoryUrlRefresh 를 실행.
{
  const run = async () => {
    const clock = new Clock();
    let sessionMode: "hang" | "ok" = "hang";
    let applied: DiaryMediaGroupInput[] | null = null;
    let fetchAllCalls = 0;

    const groupFor = (tag: string): DiaryMediaGroupInput => ({
      gameId: "G1",
      gameDate: "2026-07-01",
      stadiumName: "잠실",
      counts: { image: 1, video: 0, total: 1 },
      thumbnails: [{ id: 1, mediaType: "image", thumbUrl: `${tag}-1`, venueVerified: false }],
    });

    const refresh = makeDiaryThumbRefresh({
      seasons: [2026],
      // getSafeSession 가 non-settle 인 실제 버그 재현: hang 면 영원히 pending.
      getToken: () =>
        sessionMode === "hang"
          ? new Promise<string | null>(() => {})
          : Promise.resolve("tok"),
      fetchAllPages: async () => {
        fetchAllCalls += 1;
        return [groupFor("new")];
      },
      isCurrent: () => true,
      apply: (fresh) => {
        applied = fresh;
      },
      timers: {
        timeoutMs: VENUE_STORY_URL_MINT_TIMEOUT_MS,
        setTimer: clock.set,
        clearTimer: clock.clear,
      },
    });

    let previousStoryId: number | null = 1;
    let lastRefreshAt = clock.now;
    let calls = 0;
    const wrappedRefresh = (storyId: number, controller: AbortController) => {
      calls += 1;
      return refresh(storyId, controller);
    };

    const cancel = startVenueStoryUrlRefresh<number>({
      storyId: 1,
      isCurrentStory: () => true,
      refresh: wrappedRefresh,
      now: () => clock.now,
      setTimer: clock.set,
      clearTimer: clock.clear,
      makeController: () => new AbortController(),
      getPreviousStoryId: () => previousStoryId,
      setPreviousStoryId: (v) => {
        previousStoryId = v;
      },
      getLastRefreshAt: () => lastRefreshAt,
      setLastRefreshAt: (v) => {
        lastRefreshAt = v;
      },
    });
    await flush();

    // 초기 lastRefreshAt=now → 4분 뒤 첫 refresh 예약. 아직 호출 전.
    assert.equal(calls, 0, "초기엔 refresh 미호출(4분 간격)");

    // 4분 경과 → refresh 호출, getToken hang → 8s에 mint abort → settle(false).
    await clock.advance(VENUE_STORY_URL_REFRESH_MS);
    assert.equal(calls, 1, "4분 후 refresh 1회 호출(never-settle)");
    assert.equal(applied, null, "never-settle 은 apply 안 됨");

    // 8s mint timeout 경과 → abort→false→retry(10s) 예약. session 복구.
    await clock.advance(VENUE_STORY_URL_MINT_TIMEOUT_MS);
    sessionMode = "ok";
    // 10s retry 경과 → refresh 재호출 → 이번엔 settle → apply.
    await clock.advance(VENUE_STORY_URL_RETRY_MS);
    assert.ok(calls >= 2, `8s abort 후 10s retry 로 refresh 재호출(calls=${calls})`);
    assert.ok(applied != null, "retry settle 후 apply 됨(never-settle→timeout→retry 성공)");
    assert.equal(fetchAllCalls, 1, "settle 된 retry 에서만 전페이지 fetch");
    assert.equal((applied as DiaryMediaGroupInput[])[0].thumbnails[0].thumbUrl, "new-1");

    cancel();
  };
  await run();
}

// 13) Blocker 2 (actual-wiring) — refresh 가 전페이지(31경기)를 재발급 → 31번째도 new-* 로 갱신.
{
  const run = async () => {
    const clock = new Clock();
    // 로드된 홈 목록: 31경기(cursor 2페이지). 각 경기 썸네일 id=경기번호.
    const loaded: DiaryMediaGroupInput[] = Array.from({ length: 31 }, (_, i) => ({
      gameId: `G${i + 1}`,
      gameDate: "2026-07-01",
      stadiumName: "잠실",
      counts: { image: 1, video: 0, total: 1 },
      thumbnails: [
        { id: i + 1, mediaType: "image", thumbUrl: `old-${i + 1}`, venueVerified: false },
      ],
    }));
    let current = loaded;

    const refresh = makeDiaryThumbRefresh({
      seasons: [2026],
      getToken: async () => "tok",
      // 전페이지: 모든 31경기 썸네일을 new-* 로 발급(첫 페이지만이 아니라 전체).
      fetchAllPages: async () =>
        loaded.map((g) => ({
          ...g,
          thumbnails: g.thumbnails.map((t) => ({ ...t, thumbUrl: `new-${t.id}` })),
        })),
      isCurrent: () => true,
      apply: (fresh) => {
        current = applyDiaryThumbUrlRefresh(current, fresh);
      },
      timers: { setTimer: clock.set, clearTimer: clock.clear },
    });

    const ok = await refresh(1, new AbortController());
    await flush();
    assert.equal(ok, true, "전페이지 refresh 성공");
    assert.equal(current[0].thumbnails[0].thumbUrl, "new-1", "1번째 갱신");
    assert.equal(current[29].thumbnails[0].thumbUrl, "new-30", "30번째 갱신");
    // 핵심 회귀: 첨 페이지만 받던 기존은 old-31 잔존 → 전페이지라 31번째도 new-31.
    assert.equal(current[30].thumbnails[0].thumbUrl, "new-31", "31번째도 new-* 로 갱신(2페이지 만료 방지)");
  };
  await run();
}

// 14) Blocker 3 (actual-wiring) — id 추적 pending poll: bounded probe + archived/timeout terminal + phase.
//     removed 는 상세 GET(active|archived)에서 도달 불가라 계약에서 제거됨(허위계약 0).
{
  // 순수 분류기 — found→archived, 소진→timeout, 그 외 계속(null). removed 분기 없음.
  assert.equal(
    classifyDiaryPendingPoll({ probe: { found: true }, attemptsLeft: 5 }),
    "archived",
  );
  assert.equal(
    classifyDiaryPendingPoll({ probe: { found: false }, attemptsLeft: 0 }),
    "timeout",
  );
  assert.equal(
    classifyDiaryPendingPoll({ probe: { found: false }, attemptsLeft: 2 }),
    null,
    "아직 시도 남음 → 계속",
  );
  assert.equal(classifyDiaryPendingPoll({ probe: null, attemptsLeft: 3 }), null, "probe 실패 → 계속");
  assert.equal(classifyDiaryPendingPoll({ probe: null, attemptsLeft: 0 }), "timeout", "관측 실패로 소진 → timeout");
  assert.equal(diaryPendingTerminalPhase("archived"), "done");
  assert.equal(diaryPendingTerminalPhase("timeout"), "stalled");

  // 루프 actual-wiring: 각 terminal 경로에서 onTerminal 1회 + 타이머 중단.
  const runPoll = async (
    probes: Array<DiaryPendingProbe | null>,
  ): Promise<{ terminal: DiaryPendingTerminal | null; ticks: number }> => {
    const clock = new Clock();
    let i = 0;
    let terminal: DiaryPendingTerminal | null = null;
    let terminalCalls = 0;
    const delays = [10, 20, 30];
    const cancel = startDiaryPendingPoll<number>({
      delays,
      probe: async () => probes[Math.min(i++, probes.length - 1)] ?? null,
      onTerminal: (t) => {
        terminal = t;
        terminalCalls += 1;
      },
      setTimer: clock.set,
      clearTimer: clock.clear,
      probeTimeoutMs: 8000,
    });
    await clock.advance(200);
    cancel();
    assert.ok(terminalCalls <= 1, "terminal 콜백은 최대 1회");
    return { terminal, ticks: i };
  };

  // archived: 2번째 tick에서 found → archived, 이후 poll 중단.
  const a = await runPoll([{ found: false }, { found: true }, { found: true }]);
  assert.equal(a.terminal, "archived", "found → archived");
  assert.equal(a.ticks, 2, "found 즉시 종료(3번째 tick 없음)");

  // timeout: 끝까지 found 안 됨 → timeout.
  const t = await runPoll([{ found: false }, { found: false }, { found: false }]);
  assert.equal(t.terminal, "timeout", "소진 → timeout");
  assert.equal(t.ticks, 3, "delays 길이만큼 poll");
}

// 14b) Blocker 3 (bounded probe) — throw/never-settle 에서 영구정지 0: 다음 tick 재개 + cleanup abort.
{
  // throw → 다음 tick 예약(unhandled 0, 영구정지 0): 1번째 probe throw, 2번째 found → archived.
  {
    const clock = new Clock();
    let calls = 0;
    let terminal: DiaryPendingTerminal | null = null;
    const cancel = startDiaryPendingPoll<number>({
      delays: [10, 20, 30],
      probe: async () => {
        calls += 1;
        if (calls === 1) throw new Error("probe boom");
        return { found: true };
      },
      onTerminal: (tm) => {
        terminal = tm;
      },
      setTimer: clock.set,
      clearTimer: clock.clear,
      probeTimeoutMs: 8000,
    });
    await clock.advance(100);
    cancel();
    assert.ok(calls >= 2, `throw 후 다음 tick 재개(calls=${calls})`);
    assert.equal(terminal, "archived", "throw→다음 tick→found→archived");
  }

  // never-settle → 8s mint abort → 다음 tick 재개.
  {
    const clock = new Clock();
    let calls = 0;
    let aborts = 0;
    let terminal: DiaryPendingTerminal | null = null;
    const cancel = startDiaryPendingPoll<number>({
      delays: [10, 20, 30],
      probe: (signal) => {
        calls += 1;
        if (calls === 1) {
          signal.addEventListener("abort", () => {
            aborts += 1;
          });
          return new Promise<DiaryPendingProbe | null>(() => {}); // 영원히 pending
        }
        return Promise.resolve({ found: true });
      },
      onTerminal: (tm) => {
        terminal = tm;
      },
      setTimer: clock.set,
      clearTimer: clock.clear,
      probeTimeoutMs: 8000,
    });
    await clock.advance(10); // tick1: probe hang
    assert.equal(calls, 1);
    assert.equal(terminal, null, "never-settle: 아직 terminal 아님");
    await clock.advance(8000); // 8s mint timeout → abort → null → 다음 tick 예약
    assert.equal(aborts, 1, "never-settle 은 8s 에 abort(다음 timer 소실 0)");
    await clock.advance(30);
    cancel();
    assert.ok(calls >= 2, `8s abort 후 다음 tick 재개(calls=${calls})`);
    assert.equal(terminal, "archived", "never-settle→8s abort→다음 tick→archived");
  }

  // cleanup abort: in-flight probe 를 즉시 abort + 이후 tick/terminal 없음.
  {
    const clock = new Clock();
    let aborts = 0;
    let terminalCalls = 0;
    const cancel = startDiaryPendingPoll<number>({
      delays: [10, 20],
      probe: (signal) => {
        signal.addEventListener("abort", () => {
          aborts += 1;
        });
        return new Promise<DiaryPendingProbe | null>(() => {});
      },
      onTerminal: () => {
        terminalCalls += 1;
      },
      setTimer: clock.set,
      clearTimer: clock.clear,
      probeTimeoutMs: 8000,
    });
    await clock.advance(10); // tick1: probe in-flight
    cancel(); // cleanup 이 activeController 를 abort
    assert.equal(aborts, 1, "cleanup 이 in-flight probe 를 abort");
    await clock.advance(20000);
    assert.equal(terminalCalls, 0, "cleanup 후 terminal 없음(누수 0)");
  }

  // 복수 pending 영상 역순 승급(id별 소유권): 뒤 영상 먼저·앞 영상 늦게 → 둘 다 archived 반영.
  {
    const clock = new Clock();
    const terminals = new Map<number, DiaryPendingTerminal>();
    const mkPoll = (storyId: number, foundAtTick: number) => {
      let i = 0;
      return startDiaryPendingPoll<number>({
        delays: [10, 20, 30],
        probe: async () => {
          i += 1;
          return { found: i >= foundAtTick };
        },
        onTerminal: (t) => {
          terminals.set(storyId, t);
        },
        setTimer: clock.set,
        clearTimer: clock.clear,
        probeTimeoutMs: 8000,
      });
    };
    const cancelA = mkPoll(101, 3); // 앞 영상: tick3 늦은 승급
    const cancelB = mkPoll(202, 1); // 뒤 영상: tick1 먼저 승급
    await clock.advance(200);
    cancelA();
    cancelB();
    assert.equal(terminals.get(202), "archived", "뒤 영상 먼저 승급");
    assert.equal(terminals.get(101), "archived", "앞 영상 늦은 승급도 반영(단일슬롯 뒤섞임 0)");
    assert.equal(terminals.size, 2, "두 poll 독립 종결");
  }
}

// 14c) Blocker 4 — fail-closed 선택 게이트: counts 미확정이면 어떤 count 도 선택 불가.
{
  // 미확정(로딩/오류): 0/2/10 모두 disabled → 0 폴백으로 10/10 을 선택가능 오노출 0.
  assert.equal(diaryAddSelectDisabled(false, 0), true, "counts 미확정이면 0개도 선택 불가");
  assert.equal(diaryAddSelectDisabled(false, 2), true);
  assert.equal(diaryAddSelectDisabled(false, 10), true, "미확정 10/10 을 선택가능으로 오노출 0");
  // 확정 후: 상한만 잠김, 그 외 선택 가능.
  assert.equal(diaryAddSelectDisabled(true, 0), false, "확정 후 0개 선택 가능");
  assert.equal(diaryAddSelectDisabled(true, 2), false, "확정 후 부분은 추가 가능");
  assert.equal(diaryAddSelectDisabled(true, 10), true, "확정 후 10/10 은 잠김");

  // ── counts owner-key: 재오픈/유저 전환 첫 렌더 stale counts fail-closed ──
  // 시나리오: user A 로 open(seq1) → counts 확정(owner=A:1) → 닫기 → 재오픈(seq2).
  // 재오픈 첫 렌더는 currentKey=A:2 인데 owner 는 아직 A:1 → 불일치 → ready=false(선택 차단).
  const openerA1 = diaryCountsOwnerKey("userA", 1, 2026);
  assert.equal(
    diaryCountsReady(openerA1, diaryCountsOwnerKey("userA", 1, 2026)),
    true,
    "counts 확정된 같은 (user, open, season) 세션은 ready",
  );
  assert.equal(
    diaryCountsReady(openerA1, diaryCountsOwnerKey("userA", 2, 2026)),
    false,
    "재오픈(openSeq 증가) 첫 렌더는 이전 counts owner 와 불일치 → fail-closed",
  );
  assert.equal(
    diaryCountsReady(openerA1, diaryCountsOwnerKey("userB", 1, 2026)),
    false,
    "유저 전환 첫 렌더는 다른 user 라 불일치 → fail-closed(다른 유저 counts 잔존 0)",
  );
  // 시즌 전환: 2026 counts 를 2025 시트에 그대로 쓰면 기존 10/10 경기가 0/10 으로 오표시돼
  // 상한을 뚚는 fail-open 이 된다 → season 이 key 에 들어가 첫 렌더부터 차단돼야 한다.
  assert.equal(
    diaryCountsReady(openerA1, diaryCountsOwnerKey("userA", 1, 2025)),
    false,
    "시즌 전환 첫 렌더는 다른 시즌 counts 라 불일치 → fail-closed",
  );
  assert.equal(
    diaryCountsReady(
      diaryCountsOwnerKey("userA", 1, 2025),
      diaryCountsOwnerKey("userA", 1, 2025),
    ),
    true,
    "2025 counts 확정 후 2025 시트는 ready",
  );
  assert.equal(
    diaryCountsReady(null, diaryCountsOwnerKey("userA", 1, 2026)),
    false,
    "counts 미확정(owner=null)은 항상 fail-closed",
  );
  assert.equal(
    diaryCountsReady(openerA1, null),
    false,
    "sheet 닫힘(currentKey=null)이면 ready 아님",
  );
  // fail-closed key 불일치 시엔 10/10 이든 뭐든 전부 선택 차단(diaryAddSelectDisabled 와 결합).
  assert.equal(
    diaryAddSelectDisabled(
      diaryCountsReady(openerA1, diaryCountsOwnerKey("userA", 2, 2026)),
      2,
    ),
    true,
    "재오픈 첫 렌더는 2/10 경기도 선택 차단(이전 세션 count 노출 0)",
  );
  // 시즌 전환 첫 렌더도 같다 — 2026 counts 를 들고 2025 시트로 넘어가는 순간 전부 차단.
  assert.equal(
    diaryAddSelectDisabled(
      diaryCountsReady(openerA1, diaryCountsOwnerKey("userA", 1, 2025)),
      2,
    ),
    true,
    "시즌 전환 첫 렌더는 2/10 경기도 선택 차단(다른 시즌 count 노출 0)",
  );
}

// 15) counts 는 시트에 선택된 시즌과 같은 시즌이어야 한다.
//     예전엔 시트가 2026 고정이라 "항상 2026 counts" 가 계약이었지만, 지금은 시트가 시즌을
//     고를 수 있으므로 계약이 "선택 시즌의 counts" 로 바뀌었다. 어느 쪽이든 핵심은 동일하다:
//     시트가 보여주는 경기와 counts 의 시즌이 엇갈리면 기존 10/10 경기가 0/10 으로 보이는
//     fail-open 이 된다.
{
  const groups2026: DiaryMediaGroupInput[] = [
    {
      gameId: "20260718LGDS",
      gameDate: "2026-07-18",
      stadiumName: "잠실",
      counts: { image: 6, video: 4, total: 10 },
      thumbnails: [],
    },
    {
      gameId: "20260720LGDS",
      gameDate: "2026-07-20",
      stadiumName: "잠실",
      counts: { image: 2, video: 0, total: 2 },
      thumbnails: [],
    },
  ];
  const counts = buildDiaryCountsMap(groups2026);
  // 2026 시트가 2026 counts 를 받으면 10/10 경기는 locked, 2/10 은 add.
  assert.equal(counts.get("20260718LGDS"), 10);
  assert.equal(diaryPickLocked(diaryPickState(counts.get("20260718LGDS") ?? 0)), true, "2026 10/10 → 잠김");
  assert.deepEqual(diaryPickState(counts.get("20260720LGDS") ?? 0), {
    kind: "add",
    count: 2,
    cap: VENUE_DIARY_MEDIA_CAP,
  });

  const groups2025: DiaryMediaGroupInput[] = [
    {
      gameId: "20250801LGSS0",
      gameDate: "2025-08-01",
      stadiumName: "대구",
      counts: { image: 10, video: 0, total: 10 },
      thumbnails: [],
    },
  ];
  const counts2025 = buildDiaryCountsMap(groups2025);
  // 2025 시트가 2025 counts 를 받으면 2025 의 10/10 경기가 제대로 잠긴다.
  assert.equal(
    diaryPickLocked(diaryPickState(counts2025.get("20250801LGSS0") ?? 0)),
    true,
    "2025 counts 로 2025 10/10 경기 잠김",
  );
  // 교차 fail-open 재현 — 시즌이 엇갈리면 양방향 모두 10/10 이 0→선택가능으로 보인다.
  // 그래서 counts 는 선택 시즌으로 fetch 하고, owner key 에 season 을 넣어 전환 순간을 차단한다.
  assert.deepEqual(
    diaryPickState(counts2025.get("20260718LGDS") ?? 0),
    { kind: "pick" },
    "2025 counts 로 2026 10/10 을 보면 0→선택가능 오표시(fail-open)",
  );
  assert.deepEqual(
    diaryPickState(counts.get("20250801LGSS0") ?? 0),
    { kind: "pick" },
    "2026 counts 로 2025 10/10 을 보면 0→선택가능 오표시(fail-open)",
  );
}

}

runAsyncRegressions()
  .then(() => console.log("venue-diary-view-smoke: OK"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
