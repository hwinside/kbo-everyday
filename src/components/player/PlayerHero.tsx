"use client";

import Image from "next/image";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import CountryFlag from "@/components/player/CountryFlag";
import type { Nationality } from "@/lib/utils/player-nationality";
import { militaryLabel } from "@/lib/utils/military-label";

// Hero 이미지: 검수 통과 선수만 노출 (default deny).
// v2 cutout 품질 이슈로 allowlist 방식 전환 (2026-04-28).
// 검수 통과 시 hero-approved-kboids.json 에 kboId 추가.
import heroApprovedList from "@/lib/constants/hero-approved-kboids.json";
const HERO_APPROVED = new Set<string>(heroApprovedList as string[]);

export type HeroStat = { label: string; value: string };

/**
 * 선수별 Hero 스탯 산출
 * 타자: 기본 타율, 상위 10위 내인 종목 추가 (홈런/안타/도루)
 * 투수: 기본 ERA, 5승패 이상 + 상위 10위 내인 종목 추가 (승/패, 탈삼진, 세이브, 홀드)
 * ※ 현재는 목업 기준으로 임계치만 적용. 실서비스는 실시간 랭킹 API로 교체.
 */
// string/number 모두 허용 (일부 API가 문자열 반환)
function toNum(v: any): number | null {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmt(n: number | null, digits: number): string {
  return n == null ? "-" : n.toFixed(digits);
}

/**
 * 선수 랜킹 기반 조건부 노출 — 시즌 초반 접대 임계치 미도달 문제 해결
 * rankings: 해당 선수가 각 종목에서 몇 위인지 (rank ≤ 10이면 상위 10위)
 */
export type PlayerRanks = {
  hr?: number;      // 홈런 순위
  hits?: number;    // 안타 순위
  sb?: number;      // 도루 순위
  avg?: number;     // 타율 순위
  rbi?: number;     // 타점 순위
  so?: number;      // 탈삼진 순위
  saves?: number;   // 세이브 순위
  holds?: number;   // 홀드 순위
  era?: number;     // 평균자책 순위
  whip?: number;    // WHIP 순위
  wins?: number;    // 승리 순위
  ip?: number;      // 이닝 순위
  fip?: number;     // FIP 순위
  war?: number;     // WAR 순위
  k9?: number;      // K/9 순위
};

export function buildHeroStats(
  stats: any,
  position: string,
  ranks: PlayerRanks = {},
): HeroStat[] {
  const out: HeroStat[] = [];
  if (!stats) return out;
  const avg = toNum(stats.avg);
  const hr = toNum(stats.hr);
  const hits = toNum(stats.hits);
  const sb = toNum(stats.sb);
  const era = toNum(stats.era);
  const wins = toNum(stats.wins);
  const losses = toNum(stats.losses);
  const so = toNum(stats.so);
  const saves = toNum(stats.saves);
  const holds = toNum(stats.holds);
  const isPitcher = /투수|P$|SP|RP|CP/i.test(position) || era != null;
  const top10 = (r?: number) => r != null && r >= 1 && r <= 10;
  if (!isPitcher) {
    out.push({ label: "타율", value: avg != null ? fmt(avg, 3).replace(/^0/, "") : "-" });
    if (hr != null && top10(ranks.hr)) out.push({ label: "홈런", value: String(hr) });
    if (hits != null && top10(ranks.hits)) out.push({ label: "안타", value: String(hits) });
    if (sb != null && top10(ranks.sb)) out.push({ label: "도루", value: String(sb) });
  } else {
    out.push({ label: "ERA", value: fmt(era, 2) });
    const whip = toNum(stats.whip);
    if (whip != null && top10(ranks.whip)) out.push({ label: "WHIP", value: fmt(whip, 2) });
    const w = wins ?? 0;
    const l = losses ?? 0;
    if (w + l >= 5) out.push({ label: "승/패", value: `${w}-${l}` });
    if (so != null && top10(ranks.so)) out.push({ label: "탈삼진", value: String(so) });
    if (saves != null && top10(ranks.saves)) out.push({ label: "세이브", value: String(saves) });
    if (holds != null && top10(ranks.holds)) out.push({ label: "홀드", value: String(holds) });
  }
  return out.slice(0, 4);
}

export function hasHeroImage(kboId?: string | number | null): boolean {
  if (kboId == null) return false;
  return HERO_APPROVED.has(String(kboId));
}

interface PlayerHeroProps {
  kboId: string; // public/players-hero/{kboId}.webp
  playerName: string;
  teamName: string;
  teamBg: string;
  backNo?: number | null;
  position?: string | null;
  /** 군 복무 구단 표기 (예: "상무"). 있으면 포지션 아래 별도 명시 */
  military?: string | null;
  /** 생년월일 표시 문자열 (예: "2000.07.17 · 만 25세"). 없으면 미표시 */
  birthText?: string | null;
  /** 외국인 선수 국적 (국기+국가명). 내국인은 null */
  nationality?: Nationality | null;
  stats?: HeroStat[];
  /** 좌상단 back link href (next/link). 없으면 window.history.back() */
  backHref?: string;
  /** 좌상단 back 버튼 표시 여부 (페이지 상단에 별도 헤더가 이미 있으면 false) */
  showTopBar?: boolean;
  /** 우상단 공유 버튼 노출 (현재 동작 안 해 기본 false) */
  showShare?: boolean;
  /** Hero 하단 ~ 페이지 본문 사이에 넣을 부가 요소 (탭 등) */
  children?: ReactNode;
}

export default function PlayerHero({
  kboId,
  playerName,
  teamName,
  teamBg,
  backNo,
  position,
  military,
  birthText,
  nationality,
  stats = [],
  backHref,
  showTopBar = true,
  showShare = false,
  children,
}: PlayerHeroProps) {
  const nameLen = playerName.length;
  const nameSize =
    nameLen <= 3 ? 44 :
    nameLen === 4 ? 38 :
    nameLen === 5 ? 32 :
    nameLen === 6 ? 28 :
    24;

  const BackButton = (
    <button
      type="button"
      onClick={() => {
        if (backHref) {
          window.location.href = backHref;
        } else {
          window.history.back();
        }
      }}
      className="rounded-full bg-black/40 p-2 text-white backdrop-blur-sm transition-colors hover:bg-black/60"
      aria-label="뒤로가기"
    >
      <ChevronLeft size={22} />
    </button>
  );

  // 팀컬러 기반 배경: 상단에 팀컬러 힌트, 하단으로 갈수록 중성 다크
  // spotlight 없이 배경 gradient에만 팀컬러 노출 — cutout(유니폼/피부)에 팀컬러 오버레이 없음
  const bgGradient =
    `linear-gradient(180deg, ${teamBg}40 0%, ${teamBg}1A 40%, #0F0F12 78%, #0A0A0B 100%)`;

  return (
    <div
      className="relative overflow-hidden"
      style={{ background: bgGradient }}
    >
      {/* Top bar (back 버튼만, 공유 제거) — 호출측에 전역 헤더가 있으면 showTopBar=false로 완전 생략 */}
      {showTopBar && (
        <div className="relative z-20 flex items-center px-4 pt-2">
          {BackButton}
        </div>
      )}

      {/* Hero content: 좌 텍스트 · 중앙 선수 · 우 스탯 */}
      <div className="relative px-4 pb-0 pt-0" style={{ minHeight: 184 }}>
        {/* Left: 이름/등번호/포지션 */}
        <div className="absolute left-4 top-1 z-10 text-left" style={{ letterSpacing: "-0.05em" }}>
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-[3px] rounded-full" style={{ backgroundColor: teamBg }} />
            <div className="text-[11px] font-bold tracking-[0.12em] text-white/55">
              {teamName}
            </div>
          </div>
          <h1
            className="mt-1 font-black leading-[0.95] text-white drop-shadow-lg whitespace-nowrap"
            style={{ letterSpacing: "-0.1em", fontSize: nameSize }}
          >
            {playerName}
          </h1>
          <div className="mt-3 flex flex-col gap-1">
            {backNo != null && backNo > 0 && (
              <div className="text-lg font-extrabold text-white/75 whitespace-nowrap" style={{ letterSpacing: "-0.05em" }}>
                #{backNo}
              </div>
            )}
            {position && (
              <div className="text-lg font-bold text-white/60 whitespace-nowrap" style={{ letterSpacing: "-0.05em" }}>
                {position}
              </div>
            )}
            {militaryLabel(military) && (
              <div
                data-testid="military-badge"
                className="inline-flex w-fit items-center gap-1 rounded-full bg-white/15 px-2.5 py-0.5 text-[12px] font-bold text-white/80 whitespace-nowrap"
              >
                🎖️ {militaryLabel(military)}
              </div>
            )}
            {nationality && (
              <CountryFlag
                nationality={nationality}
                size={15}
                className="text-[11px] font-semibold text-white/60"
              />
            )}
            {birthText && (
              <div className="text-[11px] font-medium text-white/45 whitespace-nowrap" style={{ letterSpacing: "-0.03em" }}>
                {birthText}
              </div>
            )}
          </div>
        </div>

        {/* Center: cutout */}
        {/* 상단 safe space 6px + 하단 그라데이션 fade(어깨선 자연스럽게 사라짐) */}
        {/* - container: top-[6px] h-[194px] → 상단 여유 6px 확보 (모자 끝이 Hero 상단에 닿는 케이스 방지) */}
        {/* - mask: 0~96% 완전 노출 → 96~100% fade — 어깨선이 더 드러나게 fade를 거의 끝까지 내림
             (구자욱/박해민처럼 소스 크롭이 타이트한 케이스도 어깨 노출). 하단 4%만 soft out. */}
        <div
          className="pointer-events-none absolute left-1/2 top-[6px] z-0 -translate-x-1/2 h-[194px] w-[200px] overflow-hidden"
          style={{
            maskImage: "linear-gradient(180deg, #000 0%, #000 96%, transparent 100%)",
            WebkitMaskImage: "linear-gradient(180deg, #000 0%, #000 96%, transparent 100%)",
          }}
        >
          <Image
            src={`/players-hero/${kboId}.webp`}
            alt={playerName}
            fill
            sizes="220px"
            className="relative object-contain"
            priority
            unoptimized
          />
        </div>

        {/* Right: 스탯 — 첫 스탯(타율/ERA) 라벨은 좌측 "| LG"와 동일 행에 두고, 값은 이름과 동일 size+baseline 정렬 */}
        {stats.length > 0 && (
          <div className="absolute right-4 top-1 z-10 flex flex-col items-end text-right" style={{ letterSpacing: "-0.05em" }}>
            {/* 좌측 "| LG" 행과 동일 높이(11px label) */}
            <div className="text-[11px] font-bold tracking-[0.12em] text-white/55 leading-[12px]">
              {stats[0].label}
            </div>
            {/* 첫 스탯 값: 왼쪽 이름과 동일 사이즈 + baseline (좌우 완벽 대칭) */}
            <div
              className="mt-1 font-black leading-[0.95] text-white drop-shadow-lg whitespace-nowrap"
              style={{ letterSpacing: "-0.1em", fontSize: nameSize }}
            >
              {stats[0].value}
            </div>
            {/* 추가 스탯들 (#/포지션 높이와 정렬) */}
            <div className="mt-3 flex flex-col gap-1">
              {stats.slice(1).map((s, i) => (
                <div key={i} className="text-right whitespace-nowrap">
                  <span className="text-[11px] font-semibold tracking-[0.08em] text-white/55 mr-1.5">
                    {s.label}
                  </span>
                  <span className="text-lg font-extrabold text-white/85" style={{ letterSpacing: "-0.05em" }}>
                    {s.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom fade — 탭과 Hero 사이 부드러운 경계 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-b from-transparent to-bg-primary z-[5]" />

      {/* children slot (탭 등) */}
      {children && (
        <div className="relative z-10 bg-bg-primary">{children}</div>
      )}
    </div>
  );
}
