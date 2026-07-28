"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { getTeamBySlug } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import type { PollSummary, PollSummaryOption } from "@/lib/community/poll-client";

/**
 * 커뮤니티 목록의 투표 전용 카드 본문 (spec §6, S3).
 *
 * 질문(post.title)은 PostCard 가 렌더하므로 여기서는 진행중/마감 배지 + 👥 n명 참여 +
 * 선지 미리보기(작성순, 팀 로고/선수 사진·이름)만 그린다. **득표수는 노출하지 않는다**
 * (목록에서 진행중 결과 우회 방지 — 수치는 상세 PollBlock 에서 게이트대로만).
 * 선지 라벨/이미지는 refId 로 current SSOT(TEAMS/roster/photo) 해석, 실패 시 snapshot fallback.
 */

const ROSTER_NAME_BY_KBOID = new Map(
  (PLAYERS_ROSTER as { kboId: string; name: string }[]).map((p) => [String(p.kboId), p.name]),
);

const PREVIEW_MAX = 4;

/** 마감 경계 판정(순수 함수, 회귀 공유). 서버 closed 또는 nowMs가 closesAt 이상이면 마감. */
export function isPollEffectiveClosed(
  summary: { closed: boolean; closesAt: string },
  nowMs: number,
): boolean {
  return summary.closed || nowMs >= new Date(summary.closesAt).getTime();
}

/** 다음 마감 경계 타이머 예약 간격(ms) 계산. 최대 30일을 6시간 hop 으로 커버.
 *  반환: {kind:'closed'} 이미 마감 / {kind:'hop', ms} 6시간 뒤 재평가 / {kind:'fire', ms} 경계에서 마감 전환. */
export function pollBoundaryTimer(
  summary: { closed: boolean; closesAt: string },
  nowMs: number,
): { kind: "closed" } | { kind: "hop"; ms: number } | { kind: "fire"; ms: number } {
  if (summary.closed) return { kind: "closed" };
  const ms = new Date(summary.closesAt).getTime() - nowMs;
  if (ms <= 0) return { kind: "fire", ms: 0 };
  const MAX_HOP = 6 * 60 * 60 * 1000;
  if (ms > MAX_HOP) return { kind: "hop", ms: MAX_HOP };
  return { kind: "fire", ms: ms + 250 };
}

function resolve(o: PollSummaryOption): { label: string; image: string | null } {
  if (o.kind === "team" && o.refId) {
    const team = getTeamBySlug(o.refId);
    if (team) return { label: team.name, image: team.logoPath };
  } else if (o.kind === "player" && o.refId) {
    const name = ROSTER_NAME_BY_KBOID.get(o.refId);
    if (name) return { label: name, image: getPlayerPhotoByKboId(o.refId) ?? o.image };
  }
  return { label: o.label ?? (o.kind === "etc" ? "선택지" : o.refId ?? ""), image: o.image };
}

export default function PollCardBody({ summary }: { summary: PollSummary }) {
  const preview = summary.options.slice(0, PREVIEW_MAX);
  const more = Math.max(0, summary.optionCount - preview.length);

  // 서버 closed 또는 클라이언트 경계 도달 즉시 반영(목록을 열어둔 채 마감 시각을
  // 넘겨도 진행중으로 남는 stale 방지). summary 재조회는 상위 목록이 pollIdsKey로
  // 관리하므로 여기서는 배지/표시만 경계에서 전환한다.
  const [boundaryClosed, setBoundaryClosed] = useState(false);
  const [hopTick, setHopTick] = useState(0);
  const effectiveClosed = summary.closed || boundaryClosed;
  useEffect(() => {
    if (summary.closed || boundaryClosed) return;
    // 렌더 중 Date.now 호출 없이 effect 안에서만 경계 판정(순수 함수 재사용). 동기 setState 대신 타이머.
    const plan = pollBoundaryTimer(summary, Date.now());
    if (plan.kind === "closed") return;
    if (plan.kind === "hop") {
      const t = setTimeout(() => setHopTick((n) => n + 1), plan.ms);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setBoundaryClosed(true), plan.ms);
    return () => clearTimeout(t);
  }, [summary, summary.closed, summary.closesAt, boundaryClosed, hopTick]);

  return (
    <div className="mt-2 rounded-xl border border-border p-3">
      {/* 배지 + 참여수 */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
            effectiveClosed ? "bg-bg-tertiary text-text-tertiary" : "bg-accent/15 text-accent"
          }`}
        >
          {effectiveClosed ? "마감" : "진행중"}
        </span>
        <span className="text-xs text-text-tertiary ml-auto">👥 {summary.voterCount}명 참여</span>
      </div>

      {/* 선지 미리보기 (작성순, 득표수 없음) */}
      <div className="space-y-1.5">
        {preview.map((o) => {
          const { label, image } = resolve(o);
          return (
            <div
              key={o.position}
              className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-bg-tertiary"
            >
              {image ? (
                <Image
                  src={image}
                  alt={label}
                  width={22}
                  height={22}
                  className="rounded-full object-cover w-[22px] h-[22px] flex-none bg-bg-secondary"
                />
              ) : (
                <span className="w-[22px] h-[22px] rounded-full bg-bg-secondary flex-none" />
              )}
              <span className="flex-1 text-sm text-text-primary truncate">{label}</span>
            </div>
          );
        })}
        {more > 0 && <p className="text-xs text-text-tertiary pl-1">외 {more}개</p>}
      </div>
    </div>
  );
}
