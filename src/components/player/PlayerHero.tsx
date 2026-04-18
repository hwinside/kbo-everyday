"use client";

import Image from "next/image";
import { ChevronLeft, Share2 } from "lucide-react";
import type { ReactNode } from "react";

// Hero 이미지 매핑: kboId → public/players-hero/{kboId}.webp 존재 여부
// 현재 확보된 선수 cutout 목록. 신규 추가 시 이 set에 kboId 추가.
const HERO_KBOIDS = new Set<string>([
  "53123", // 오스틴
  "66108", // 홍창기
  "69102", // 문보경
  "65207", // 신민재
  "68119", // 문성주
]);

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

export function buildHeroStats(stats: any, position: string): HeroStat[] {
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
  if (!isPitcher) {
    out.push({ label: "타율", value: avg != null ? fmt(avg, 3).replace(/^0/, "") : "-" });
    if (hr != null && hr >= 20) out.push({ label: "홈런", value: String(hr) });
    if (hits != null && hits >= 130) out.push({ label: "안타", value: String(hits) });
    if (sb != null && sb >= 20) out.push({ label: "도루", value: String(sb) });
  } else {
    out.push({ label: "ERA", value: fmt(era, 2) });
    const w = wins ?? 0;
    const l = losses ?? 0;
    if (w + l >= 5) out.push({ label: "승/패", value: `${w}-${l}` });
    if (so != null && so >= 100) out.push({ label: "탈삼진", value: String(so) });
    if (saves != null && saves >= 10) out.push({ label: "세이브", value: String(saves) });
    if (holds != null && holds >= 10) out.push({ label: "홀드", value: String(holds) });
  }
  return out.slice(0, 4);
}

export function hasHeroImage(kboId?: string | number | null): boolean {
  if (kboId == null) return false;
  return HERO_KBOIDS.has(String(kboId));
}

interface PlayerHeroProps {
  kboId: string; // public/players-hero/{kboId}.webp
  playerName: string;
  teamName: string;
  teamBg: string;
  backNo?: number | null;
  position?: string | null;
  stats?: HeroStat[];
  /** 좌상단 back link href (next/link). 없으면 window.history.back() */
  backHref?: string;
  /** 좌상단 back 버튼 표시 여부 (페이지 상단에 별도 헤더가 이미 있으면 false) */
  showTopBar?: boolean;
  /** 우상단 공유 버튼 노출 (서브 title = {playerName} - 크보팬) */
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
  const bgGradient =
    `linear-gradient(180deg, ${teamBg}28 0%, ${teamBg}12 35%, #0F0F12 75%, #0A0A0B 100%)`;

  return (
    <div
      className="relative overflow-hidden pt-safe"
      style={{ background: bgGradient }}
    >
      {/* Top bar */}
      {(showTopBar || showShare) && (
        <div className="relative z-20 flex items-center justify-between px-4 pt-3">
          {showTopBar ? BackButton : <span />}
          {showShare && (
            <button
              type="button"
              onClick={async () => {
                if (typeof window === "undefined") return;
                const url = window.location.href;
                try {
                  if (navigator.share) {
                    await navigator.share({ title: `${playerName} - 크보팬`, url });
                  } else {
                    await navigator.clipboard.writeText(url);
                    alert("링크가 복사되었습니다!");
                  }
                } catch { /* cancelled */ }
              }}
              className="rounded-full bg-black/40 p-2 text-white backdrop-blur-sm transition-colors hover:bg-black/60"
              aria-label="공유"
            >
              <Share2 size={18} />
            </button>
          )}
        </div>
      )}

      {/* Hero content: 좌 텍스트 · 중앙 선수 · 우 스탯 */}
      <div className="relative px-4 pb-0 pt-1" style={{ minHeight: 300 }}>
        {/* Left: 이름/등번호/포지션 */}
        <div className="absolute left-4 top-7 z-10 text-left" style={{ letterSpacing: "-0.05em" }}>
          <div className="flex items-center gap-1.5">
            <div className="h-3 w-[3px] rounded-full" style={{ backgroundColor: teamBg }} />
            <div className="text-[11px] font-bold tracking-[0.12em] text-white/55">
              {teamName}
            </div>
          </div>
          <h1
            className="mt-1.5 font-black leading-[0.95] text-white drop-shadow-lg whitespace-nowrap"
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
          </div>
        </div>

        {/* Center: cutout */}
        <div
          className="pointer-events-none absolute left-1/2 top-1 z-0 -translate-x-1/2 h-[260px] w-[240px] overflow-hidden"
          style={{
            maskImage: "linear-gradient(180deg, #000 0%, #000 55%, transparent 90%)",
            WebkitMaskImage: "linear-gradient(180deg, #000 0%, #000 55%, transparent 90%)",
          }}
        >
          {/* 선수 뒤 spotlight — 팀컬러 glow */}
          <div
            className="absolute inset-x-0 bottom-0 h-[220px] rounded-full opacity-55 blur-2xl"
            style={{ background: `radial-gradient(ellipse at 50% 70%, ${teamBg} 0%, ${teamBg}55 35%, transparent 70%)` }}
          />
          <Image
            src={`/players-hero/${kboId}.webp`}
            alt={playerName}
            fill
            sizes="260px"
            className="relative object-contain object-top"
            priority
            unoptimized
          />
        </div>

        {/* Right: 스탯 */}
        {stats.length > 0 && (
          <div className="absolute right-4 top-7 z-10 flex flex-col items-end gap-3 text-right" style={{ letterSpacing: "-0.05em" }}>
            {stats.map((s, i) => (
              <div key={i} className="text-right">
                <div className="text-[11px] font-semibold tracking-[0.08em] text-white/55 whitespace-nowrap">
                  {s.label}
                </div>
                <div
                  className={`font-black leading-[0.95] text-white drop-shadow-md whitespace-nowrap ${
                    i === 0 ? "text-[40px]" : "text-[22px]"
                  }`}
                  style={{ letterSpacing: "-0.1em" }}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom fade */}
      <div className="pointer-events-none absolute inset-x-0 bottom-16 h-28 bg-gradient-to-b from-transparent via-bg-primary/60 to-bg-primary z-[5]" />

      {/* children slot (탭 등) */}
      {children && (
        <div className="relative z-10 bg-bg-primary">{children}</div>
      )}
    </div>
  );
}
