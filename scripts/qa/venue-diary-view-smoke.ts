import assert from "node:assert/strict";
import {
  applyDiaryDetailUrlRefresh,
  applyDiaryThumbUrlRefresh,
  buildDiaryHomeGames,
  diaryBottomCta,
  diaryCanStartUpload,
  diaryCaptionForSubmit,
  diaryGameSourceLabel,
  diaryLeaveNotice,
  diaryMediaSourceLabel,
  diaryPickCaption,
  diaryPickLocked,
  diaryPickState,
  diaryShowsComments,
  diaryUploadBadge,
  diaryUploadCta,
  diaryUploadTargets,
  mergeDiaryMediaPages,
  mergeVenueSummaries,
  shouldFetchNextDiaryPage,
  VENUE_DIARY_HOME_THUMBNAILS,
  VENUE_DIARY_MAX_LIST_PAGES,
  VENUE_DIARY_MEDIA_CAP,
  type DiaryMediaGroupInput,
  type DiaryUploadItemState,
} from "../../src/lib/venue-diary/view";

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

console.log("venue-diary-view-smoke: OK");
