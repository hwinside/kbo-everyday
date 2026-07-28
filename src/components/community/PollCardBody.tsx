"use client";

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

  return (
    <div className="mt-2 rounded-xl border border-border p-3">
      {/* 배지 + 참여수 */}
      <div className="flex items-center gap-2 mb-2">
        <span
          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
            summary.closed ? "bg-bg-tertiary text-text-tertiary" : "bg-accent/15 text-accent"
          }`}
        >
          {summary.closed ? "마감" : "진행중"}
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
