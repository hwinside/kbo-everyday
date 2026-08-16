"use client";

import Image from "next/image";
import { getTeamById } from "@/lib/constants/teams";
import TeamBadge from "@/components/ui/TeamBadge";
import { ALL_TEAMS_LABEL, resolvePostScope, type PostScope } from "@/lib/utils/post-scope";

/**
 * 글 공개범위 배지 (하린아빠 스펙 2026-08-06).
 * 홈 최신글 · 커뮤니티 피드 · 글 상세가 같은 컴포넌트를 쓴다 — 라벨 계산은
 * post-scope.ts(SSOT), 표기는 여기 한 곳.
 *
 * variant:
 *   · "compact" — 홈 최신글. 폭이 좁아(320px 기기) 팀 배지는 *로고만* 겹쳐 표기.
 *   · "full"    — 커뮤니티 피드/상세. 팀 이름까지 표기(TeamBadge).
 */

type Variant = "compact" | "full";

interface Props {
  post: { player_tags?: string[] | null; team_tags?: string[] | null };
  variant?: Variant;
  className?: string;
}

/** "전체구단 공개" 칩 — 크보팬 로고 + 텍스트. */
function AllTeamsChip({ compact }: { compact: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full bg-bg-tertiary font-semibold text-text-secondary whitespace-nowrap shrink-0 ${
        compact ? "py-0.5 pl-0.5 pr-2 text-[10px]" : "py-0.5 pl-0.5 pr-2 text-xs"
      }`}
    >
      <span
        className={`inline-flex shrink-0 items-center justify-center rounded-full overflow-hidden ${
          compact ? "w-4 h-4" : "w-5 h-5"
        }`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- 정적 브랜드 아이콘 */}
        {/* 이 아이콘 PNG 는 알파가 없고 모서리가 흰색이라 원형 클립이 없으면 흰 테두리가 드러난다.
            지금은 부모가 overflow-hidden 이라 가려지지만, 그 한 줄이 바뀌면 조용히 회귀한다
            (쪽지 아바타가 실제로 그렇게 깨졌다). 그래서 자식이 직접 클립한다. */}
        <img src="/icon-192.png" alt="" className="w-full h-full rounded-full object-cover" />
      </span>
      {ALL_TEAMS_LABEL}
    </span>
  );
}

/** 로고만 노출하는 팀 칩(compact 전용). */
function TeamLogoChip({ teamId }: { teamId: number }) {
  const team = getTeamById(teamId);
  if (!team) return null;
  return (
    <span
      className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-white"
      title={team.shortName}
    >
      <Image src={team.logoPath} alt={team.shortName} width={12} height={12} unoptimized className="object-contain" />
    </span>
  );
}

/** "외 n팀" 텍스트 칩. */
function OverflowChip({ n, compact }: { n: number; compact: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full bg-bg-tertiary font-medium text-text-secondary whitespace-nowrap shrink-0 ${
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"
      }`}
    >
      외 {n}팀
    </span>
  );
}

/** 스크린리더용 전체 텍스트 — 로고만 노출되는 compact에서 의미를 잃지 않게. */
export function scopeAriaLabel(scope: PostScope): string {
  switch (scope.kind) {
    case "all":
      return ALL_TEAMS_LABEL;
    case "player":
      return `${getTeamById(scope.teamId)?.shortName ?? ""} ${scope.name}`.trim();
    case "team":
      return getTeamById(scope.teamId)?.shortName ?? "";
    case "teams": {
      const names = scope.shown.map((id) => getTeamById(id)?.shortName ?? "").filter(Boolean);
      return scope.overflow > 0 ? `${names.join(", ")} 외 ${scope.overflow}팀` : names.join(", ");
    }
  }
}

export default function PostScopeBadge({ post, variant = "full", className = "" }: Props) {
  const scope = resolvePostScope(post);
  const compact = variant === "compact";
  const wrapper = `inline-flex items-center gap-1 min-w-0 ${className}`;

  if (scope.kind === "all") {
    return (
      <span className={wrapper}>
        <AllTeamsChip compact={compact} />
      </span>
    );
  }

  if (scope.kind === "player") {
    return (
      <span className={wrapper}>
        <TeamBadge teamId={scope.teamId} playerName={scope.name} size={compact ? "xs" : "sm"} />
      </span>
    );
  }

  if (scope.kind === "team") {
    return (
      <span className={wrapper}>
        <TeamBadge teamId={scope.teamId} size={compact ? "xs" : "sm"} />
      </span>
    );
  }

  // 2~9팀.
  return (
    <span className={wrapper} aria-label={scopeAriaLabel(scope)}>
      {compact ? (
        // 홈: 로고만 나열 — 이름까지 넣으면 제목줄을 밀어낸다(320px 기기).
        <span className="inline-flex items-center gap-0.5 shrink-0" aria-hidden="true">
          {scope.shown.map((id) => (
            <TeamLogoChip key={id} teamId={id} />
          ))}
        </span>
      ) : (
        scope.shown.map((id) => <TeamBadge key={id} teamId={id} size="xs" />)
      )}
      {scope.overflow > 0 && <OverflowChip n={scope.overflow} compact={compact} />}
    </span>
  );
}
