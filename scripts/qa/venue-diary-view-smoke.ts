import assert from "node:assert/strict";
import {
  buildDiaryHomeGames,
  diaryGameSourceLabel,
  diaryMediaSourceLabel,
  diaryPickCaption,
  diaryPickLocked,
  diaryPickState,
  diaryShowsComments,
  diaryUploadBadge,
  diaryUploadCta,
  mergeVenueSummaries,
  VENUE_DIARY_HOME_THUMBNAILS,
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

console.log("venue-diary-view-smoke: OK");
