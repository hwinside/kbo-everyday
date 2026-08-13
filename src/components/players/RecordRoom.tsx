"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import MiniWeeklyTrend from "@/components/players/MiniWeeklyTrend";
import GlassCard from "@/components/ui/GlassCard";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getCanonicalPlayerHref, resolvePlayerIdentity } from "@/lib/utils/resolve-player";
import { TEAMS } from "@/lib/constants/teams";
import { getFavoritePlayers } from "@/lib/store/favorites";
import { STAT_DEFS, type StatType } from "@/lib/stats/title-defs";
import { rankByStat, parseIP, type RankedRow } from "@/lib/stats/title-rankings";
import { calcBatterSaber, calcPitcherSaber } from "@/lib/utils/sabermetrics-calc";
import playerPositions from "@/lib/constants/player-positions.json";

const POSITIONS = playerPositions as Record<string, string>;

/* 기록실 뷰 — 타자/투수/수비. WAR는 STAT_DEFS 밖 특수 처리(자체 산식). */
type View = StatType | "defense";

/* 기록실 노출 스탯 — "war"·"woba"·"wrc"·"iso"·"babip"는 STAT_DEFS 밖 특수 처리(자체 산식 계산) */
const BATTER_STATS = ["war", "woba", "wrc", "iso", "babip", "hr", "avg", "ops", "obp", "rbi", "runs", "sb", "bb", "doubles", "so_batter", "games_batter"];
const PITCHER_STATS = ["war", "era", "wins", "saves", "holds", "so_pitcher", "whip", "ip", "games_pitcher"];

/* 수비 스탯 — STAT_DEFS 밖 로컬 정의(수비기록은 정적 크롤 JSON 집계, /api/stats?type=defense) */
const DEFENSE_STATS = ["fpct", "poa", "dp", "innings", "e"];
const DEF_DEFS: Record<string, { label: string; emoji: string; fmt: (v: number) => string; rate?: boolean }> = {
  fpct: { label: "수비율", emoji: "🧤", fmt: (v) => v.toFixed(3).replace(/^0/, ""), rate: true },
  poa: { label: "자살+보살", emoji: "🎯", fmt: (v) => String(v) },
  dp: { label: "병살", emoji: "⚡", fmt: (v) => String(v) },
  innings: { label: "수비이닝", emoji: "⏱️", fmt: (v) => v.toFixed(0) },
  e: { label: "실책", emoji: "❌", fmt: (v) => String(v) },
};
const FPCT_MIN_INN = 100; // 수비율 리더보드 자격(저이닝 1.000 노이즈 방지)

/* 자체 산식 스탯 — STAT_DEFS 밖. estimate=true는 '예측' 접두 + 추정치 disclaimer 대상.
 * war는 타자/투수 양쪽, 나머지(woba/wrc/iso/babip)는 타자 전용. */
const SABER_DEFS: Record<
  string,
  { label: string; emoji: string; field: "WAR" | "wOBA" | "wRC_plus" | "ISO" | "BABIP"; fmt: (v: number) => string; estimate: boolean }
> = {
  war: { label: "예측 WAR", emoji: "📈", field: "WAR", fmt: (v) => v.toFixed(2), estimate: true },
  woba: { label: "예측 wOBA", emoji: "🎯", field: "wOBA", fmt: (v) => v.toFixed(3).replace(/^0/, ""), estimate: true },
  wrc: { label: "예측 wRC+", emoji: "📊", field: "wRC_plus", fmt: (v) => String(Math.round(v)), estimate: true },
  iso: { label: "IsoP", emoji: "💥", field: "ISO", fmt: (v) => v.toFixed(3).replace(/^0/, ""), estimate: false },
  babip: { label: "BABIP", emoji: "🍀", field: "BABIP", fmt: (v) => v.toFixed(3).replace(/^0/, ""), estimate: false },
};
/* 예측 지표 disclaimer — 칩 이름(WAR/wOBA/wRC+)에 따라 '공식 OO' 문구 동적 생성 */
const saberDisclaimer = (statName: string) =>
  `내부 예측 모델을 바탕으로 산출한 추정치입니다. 공식 ${statName} 또는 정확한 기록 데이터가 아니며, 실제 값과 차이가 날 수 있습니다.`;

/* 선택 스탯에 걸린 최소 자격 필터(랭킹 노출 기준)를 사용자에게 명시.
 * 임계값 SSOT: rankByStat(비율 타자 30타석/투수 12이닝·카운팅 타자 10경기/투수 5경기),
 * RecordRoom saber minG(타자 10/투수 5), 수비율 FPCT_MIN_INN(100이닝). 누적 수비는 자격 없음. */
const RATE_KEYS = new Set(["avg", "obp", "ops", "era", "whip"]);
function qualNote(view: View, activeStat: string, isDefense: boolean): string | null {
  if (activeStat === "backno") return null; // 등번호순 = 자격 게이트 없음
  if (isDefense) return activeStat === "fpct" ? "수비 100이닝 이상" : null;
  if (SABER_DEFS[activeStat]) return view === "pitcher" ? "5경기 이상" : "10경기 이상";
  // 비율 스탯 실제 게이트 = KBO 공식 규정이닝/규정타석(qualifiedRate 플래그). 12이닝/30타석은 과거시즌 폴백값.
  if (RATE_KEYS.has(activeStat)) return view === "pitcher" ? "규정이닝 충족" : "규정타석 충족";
  return view === "pitcher" ? "5경기 이상" : "10경기 이상";
}

/** "7 1/3" → "7⅓" 보기 좋게. */
function ipLabel(ip: unknown): string {
  return String(ip ?? "0").replace(" 1/3", "⅓").replace(" 2/3", "⅔");
}

/* 규정 미달(랭킹에서 제외된) 선수 섹션용 게이트.
 * qualified 판정은 rankByStat·RecordRoom 본문 필터와 동일하게 미러링한다(로직 드리프트 방지).
 * 비율 스탯의 규정이닝/규정타석 목표치는 현 자격 충족자의 최소값으로 동적 추정(시즌 진행에 따라 증가). */
type UnqualGate = {
  qualified: (p: Row) => boolean;
  hasRecord: (p: Row) => boolean;
  rowProgress: (p: Row) => string;
  note: string;
};
function buildUnqualGate(view: View, activeStat: string, isDefense: boolean, scoped: Row[], league: Row[]): UnqualGate | null {
  if (activeStat === "backno") return null; // 등번호순 = 전원 본 목록 노출(미달 섹션 없음)
  if (isDefense) {
    if (activeStat !== "fpct") return null; // 누적 수비 = 자격 기준 없음
    return {
      qualified: (p) => (Number(p.innings) || 0) >= FPCT_MIN_INN,
      hasRecord: (p) => (Number(p.innings) || 0) > 0,
      rowProgress: (p) => `${(Number(p.innings) || 0).toFixed(0)}이닝 / ${FPCT_MIN_INN}이닝`,
      note: `수비 ${FPCT_MIN_INN}이닝 미만 — ${FPCT_MIN_INN}이닝부터 순위에 노출됩니다`,
    };
  }
  if (RATE_KEYS.has(activeStat)) {
    // 규정이닝/규정타석은 KBO 공식 qualifiedRate 플래그(소속팀 경기수 기준)라 팀마다 다르다.
    // 리그 단일 숫자로 per-row 비교하면 "261타석인데 미달" 모순이 나므로(팀 경기수 차이),
    // 행에는 현재값만 표기하고, 근사 기준치는 섹션 노트에만 '약 N'으로 둔다.
    // ⚠️ 근사치는 *리그 전체* 자격자 최소값으로 계산 — 팀 스코프(충족 0명)에서도 30/12 폴백이 안 나오게.
    //    리그에도 자격자가 없으면(시즌 극초반) 숫자를 아예 생략한다.
    const hasFlag = league.some((p) => p.qualifiedRate !== undefined && p.qualifiedRate !== null);
    const teamLabel = "소속팀 경기수 기준";
    if (view === "pitcher") {
      const qIPs = league.filter((p) => Number(p.qualifiedRate) === 1).map((p) => parseIP(p.ip as string | number));
      const reqIP = qIPs.length ? Math.round(Math.min(...qIPs)) : null;
      return {
        qualified: hasFlag ? (p) => Number(p.qualifiedRate) === 1 : (p) => parseIP(p.ip as string | number) >= 12,
        hasRecord: (p) => parseIP(p.ip as string | number) > 0,
        rowProgress: (p) => `${ipLabel(p.ip)}이닝`,
        note: `규정이닝(${teamLabel}${reqIP ? `, 약 ${reqIP}이닝` : ""}) 미달 — 도달 시 순위에 자동 노출됩니다`,
      };
    }
    const qPAs = league.filter((p) => Number(p.qualifiedRate) === 1).map((p) => Number(p.pa) || 0);
    const reqPA = qPAs.length ? Math.round(Math.min(...qPAs)) : null;
    return {
      qualified: hasFlag ? (p) => Number(p.qualifiedRate) === 1 : (p) => (Number(p.pa) || 0) >= 30,
      hasRecord: (p) => (Number(p.pa) || 0) > 0,
      rowProgress: (p) => `${Number(p.pa) || 0}타석`,
      note: `규정타석(${teamLabel}${reqPA ? `, 약 ${reqPA}타석` : ""}) 미달 — 도달 시 순위에 자동 노출됩니다`,
    };
  }
  // 자체 산식(saber) + 카운팅 = 경기수 게이트(타자 10 / 투수 5)
  const minG = view === "pitcher" ? 5 : 10;
  return {
    qualified: (p) => (Number(p.games) || 0) >= minG,
    hasRecord: (p) => (Number(p.games) || 0) > 0,
    rowProgress: (p) => `${Number(p.games) || 0}경기 / ${minG}경기`,
    note: `${minG}경기 미만 — ${minG}경기부터 순위에 노출됩니다`,
  };
}

type Row = Record<string, unknown> & {
  name: string;
  team?: string;
  teamId?: number;
  kboId?: string;
  playerId?: string;
};

function teamIdFromText(team?: string): number | null {
  if (!team) return null;
  return TEAMS.find((t) => t.shortName === team || t.name === team)?.id ?? null;
}

/* 등번호 — 스탯 행엔 backNo가 없어서 로스터 SSOT(resolvePlayerIdentity)로 조회. 미등록이면 null.
 * 로스터 JSON은 resolve-player 경유로 이미 번들에 포함돼 있어 추가 비용 없음. */
function rosterBackNo(p: Row): string | null {
  const id = p.kboId ?? p.playerId;
  const resolved = resolvePlayerIdentity({
    name: p.name,
    kboId: id != null ? String(id) : null,
    teamId: typeof p.teamId === "number" ? p.teamId : null,
    team: typeof p.team === "string" ? p.team : null,
  });
  return resolved?.backNo ? String(resolved.backNo) : null;
}

/* 자체 타격 세이버메트릭 (예측 WAR·wOBA·wRC+·ISO·BABIP 공통 소스; 타격+주루+포지션, 수비 미반영) */
function batterSaber(p: Row) {
  return calcBatterSaber({
    avg: (p.avg as string | number) ?? 0, hits: Number(p.hits) || 0, hr: Number(p.hr) || 0,
    doubles: Number(p.doubles) || 0, triples: Number(p.triples) || 0, ab: Number(p.ab) || 0,
    pa: Number(p.pa) || 0, runs: Number(p.runs) || 0, rbi: Number(p.rbi) || 0,
    sb: Number(p.sb) || 0, bb: Number(p.bb) || 0, so: Number(p.so) || 0,
    hbp: Number(p.hbp) || 0, cs: Number(p.cs) || 0,
    sf: p.sf != null ? Number(p.sf) : undefined, // 실제 SF 전달 → BABIP 분모 정확(없으면 잔차 추정 폴백)
    position: POSITIONS[String(p.kboId ?? p.playerId ?? "")],
  });
}

/* 자체 산식 스탯 값 — war는 타자/투수 양쪽, 나머지는 타자 전용(투수 뷰엔 칩 없음) */
function computeSaber(p: Row, view: StatType, key: string): number {
  if (key === "war") {
    if (view === "batter") return batterSaber(p).WAR;
    return calcPitcherSaber({
      era: (p.era as string | number) ?? 0, ip: (p.ip as string | number) ?? 0,
      so: Number(p.so) || 0, bb: Number(p.bb) || 0, hr: Number(p.hr) || 0, hits: Number(p.h) || 0,
      r: p.r != null ? Number(p.r) : undefined, er: p.er != null ? Number(p.er) : undefined, // RA9 WAR용 실측 실점
      games: Number(p.games) || 0, wins: Number(p.wins) || 0, losses: Number(p.losses) || 0,
      saves: Number(p.saves) || 0, whip: (p.whip as string | number) ?? 0,
    }).WAR;
  }
  const field = SABER_DEFS[key]?.field;
  return field ? Number(batterSaber(p)[field]) || 0 : 0;
}

/* ISO → "6/20 21:25" (KST). 파싱 실패 시 null */
function fmtUpdated(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function hexToRgba(hex: string, alpha: number): string {
  const c = hex.replace("#", "");
  const full = c.length === 3 ? c.split("").map((x) => x + x).join("") : c;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * 선수기록실 — 스탯 선택 시 그 순으로 정렬된 랭킹 리스트.
 * scopeTeamId 있으면 해당 팀 내 정렬(팀 페이지), 없으면 리그 전체(선수 탭).
 * 타자/투수: /api/stats + rankByStat SSOT 재사용. 수비: 정적 크롤 JSON 집계(type=defense).
 */
export default function RecordRoom({ scopeTeamId }: { scopeTeamId?: number }) {
  const [view, setView] = useState<View>("batter");
  const [activeStat, setActiveStat] = useState<string>("war");
  const [rowsByType, setRowsByType] = useState<Record<string, Row[]>>({});
  const [updatedAtByType, setUpdatedAtByType] = useState<Record<string, string>>({});
  const [sourceByType, setSourceByType] = useState<Record<string, string>>({});
  const [favIds, setFavIds] = useState<Set<string>>(new Set());
  const [showUnqual, setShowUnqual] = useState(false);
  const loading = rowsByType[view] === undefined;
  const isDefense = view === "defense";

  useEffect(() => {
    // 뷰/스탯/스코프 바뀌면 미달 섹션 접힘으로 초기화
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShowUnqual(false);
  }, [view, activeStat, scopeTeamId]);

  useEffect(() => {
    // 최애선수(마이페이지 선택)만 하이라이트 — 팀 스코프에선 전원 강조 방지
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFavIds(new Set(getFavoritePlayers().map((f) => String(f.playerId))));
  }, []);

  useEffect(() => {
    if (rowsByType[view] !== undefined) return;
    fetch(`/api/stats?type=${view}&season=2026&full=1`, { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { stats?: Row[]; updatedAt?: string; source?: string }) => {
        setRowsByType((prev) => ({ ...prev, [view]: data.stats || [] }));
        if (data.updatedAt) setUpdatedAtByType((prev) => ({ ...prev, [view]: data.updatedAt! }));
        if (data.source) setSourceByType((prev) => ({ ...prev, [view]: data.source! }));
      })
      .catch(() => setRowsByType((prev) => ({ ...prev, [view]: [] })));
  }, [view, rowsByType]);

  const baseChips = isDefense ? DEFENSE_STATS : view === "batter" ? BATTER_STATS : PITCHER_STATS;
  // 등번호순 정렬은 팀 스코프 전용(리그 전체에선 무의미) — CS 요청(2026-07-16)
  const chips = scopeTeamId != null ? ["backno", ...baseChips] : baseChips;
  const def = STAT_DEFS[activeStat];

  const ranked = useMemo(() => {
    const rows = rowsByType[view] || [];
    const scoped =
      scopeTeamId != null
        ? rows.filter((p) => (p.teamId ?? teamIdFromText(p.team)) === scopeTeamId)
        : rows;

    if (activeStat === "backno") {
      // 등번호순 — 자격 게이트 없이 스코프 내 전원 오름차순(미등록은 마지막, 동번호는 이름순)
      const withNo = scoped.map((p) => ({ ...p, __backNo: rosterBackNo(p) }));
      const numOf = (s: string | null) => {
        const n = s != null ? Number(s) : NaN;
        return Number.isNaN(n) ? Infinity : n;
      };
      withNo.sort((a, b) => numOf(a.__backNo) - numOf(b.__backNo) || a.name.localeCompare(b.name, "ko"));
      return withNo.map((p, i) => ({ ...p, rank: i + 1 })) as (RankedRow & Row)[];
    }

    if (isDefense) {
      // 수비: 선택 스탯 내림차순. 수비율(rate)은 최소 이닝 자격 적용.
      const dd = DEF_DEFS[activeStat] ?? DEF_DEFS.fpct;
      const pool = dd.rate ? scoped.filter((p) => (Number(p.innings) || 0) >= FPCT_MIN_INN) : scoped;
      const sorted = [...pool].sort((a, b) => (Number(b[activeStat]) || 0) - (Number(a[activeStat]) || 0));
      let prevV: number | null = null, prevR = 0;
      return sorted.map((p, i) => {
        const v = Number(p[activeStat]) || 0;
        const r = i > 0 && v === prevV ? prevR : i + 1;
        prevV = v; prevR = r;
        return { ...p, rank: r };
      }) as (RankedRow & Row)[];
    }

    if (SABER_DEFS[activeStat]) {
      // 자체 산식 스탯: 계산 → 자격(타자 10경기 / 투수 5경기) → 내림차순 → 공동순위
      const minG = view === "batter" ? 10 : 5;
      const withV = scoped
        .filter((p) => (Number(p.games) || 0) >= minG)
        .map((p) => ({ ...p, __saber: computeSaber(p, view as StatType, activeStat) }))
        .sort((a, b) => b.__saber - a.__saber);
      let prevV: number | null = null, prevR = 0;
      return withV.map((p, i) => {
        const r = i > 0 && p.__saber === prevV ? prevR : i + 1;
        prevV = p.__saber; prevR = r;
        return { ...p, rank: r };
      }) as (RankedRow & Row)[];
    }
    return rankByStat(scoped, activeStat) as (RankedRow & Row)[];
  }, [rowsByType, view, activeStat, scopeTeamId, isDefense]);

  // 규정 미달(랭킹 제외) 선수 — 같은 스코프/정렬, 자격 미달 + 출전 기록 있는 선수만.
  const { unqualified, unqualNote, unqualProgress } = useMemo(() => {
    const empty = { unqualified: [] as (Row & { __saber?: number })[], unqualNote: null as string | null, unqualProgress: (() => "") as (p: Row) => string };
    if (loading) return empty;
    const rows = rowsByType[view] || [];
    const scoped =
      scopeTeamId != null
        ? rows.filter((p) => (p.teamId ?? teamIdFromText(p.team)) === scopeTeamId)
        : rows;
    const gate = buildUnqualGate(view, activeStat, isDefense, scoped, rows);
    if (!gate) return empty;
    const isSaber = !!SABER_DEFS[activeStat];
    const pool = scoped
      .filter((p) => !gate.qualified(p) && gate.hasRecord(p))
      .map((p) => (isSaber ? { ...p, __saber: computeSaber(p, view as StatType, activeStat) } : p));
    const valOf = (p: Row & { __saber?: number }): number => {
      if (isDefense) return Number(p[activeStat]) || 0;
      if (isSaber) return Number(p.__saber) || 0;
      if (activeStat === "doubles") return (Number(p.doubles) || 0) + (Number(p.triples) || 0);
      return Number(p[STAT_DEFS[activeStat]?.key ?? activeStat] ?? 0) || 0;
    };
    const higher = isDefense ? true : isSaber ? true : (STAT_DEFS[activeStat]?.higherIsBetter ?? true);
    const sorted = [...pool].sort((a, b) => (higher ? valOf(b) - valOf(a) : valOf(a) - valOf(b)));
    return { unqualified: sorted, unqualNote: gate.note, unqualProgress: gate.rowProgress };
  }, [rowsByType, view, activeStat, scopeTeamId, isDefense, loading]);

  function switchView(t: View) {
    if (t === view) return;
    setView(t);
    // 수비 기본=수비율, 그 외=예상 WAR. 등번호순은 뷰 전환에도 유지(로스터 브라우징 연속성)
    if (activeStat !== "backno") setActiveStat(t === "defense" ? "fpct" : "war");
  }

  const getValue = (p: Row): number => {
    if (isDefense) return Number(p[activeStat]) || 0;
    if (SABER_DEFS[activeStat]) return Number((p as Row & { __saber?: number }).__saber) || 0;
    if (!def) return 0;
    if (activeStat === "doubles") return (Number(p.doubles) || 0) + (Number(p.triples) || 0);
    // 이닝(ip)은 KBO 분수 표기("115 2/3") → Number()로 읽으면 0. parseIP로 실이닝 표시.
    if (def.key === "ip") return parseIP(p.ip as string | number);
    return Number(p[def.key] ?? 0) || 0;
  };
  const fmt = (v: number) => {
    if (isDefense) return (DEF_DEFS[activeStat] ?? DEF_DEFS.fpct).fmt(v);
    if (SABER_DEFS[activeStat]) return SABER_DEFS[activeStat].fmt(v);
    return def?.format ? def.format(v) : String(v);
  };

  return (
    <div>
      {/* 타자/투수/수비 토글 */}
      <div className="mb-3 flex gap-1 rounded-lg bg-bg-glass/40 p-1">
        {(["batter", "pitcher", "defense"] as View[]).map((t) => (
          <button
            key={t}
            onClick={() => switchView(t)}
            className={`flex-1 rounded-md py-2 text-sm font-semibold transition-all ${
              view === t ? "bg-accent text-white shadow-sm" : "text-text-tertiary"
            }`}
          >
            {t === "batter" ? "타자" : t === "pitcher" ? "투수" : "수비"}
          </button>
        ))}
      </div>

      {/* 스탯 칩 (선택 시 정렬 기준) */}
      <div className="mb-4 flex gap-1.5 overflow-x-auto hide-scrollbar pb-1">
        {chips.map((key) => {
          if (key === "backno") {
            return (
              <button
                key={key}
                onClick={() => setActiveStat(key)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  activeStat === key ? "bg-accent text-white" : "bg-bg-secondary/60 text-text-tertiary"
                }`}
              >
                🔢 등번호
              </button>
            );
          }
          if (isDefense) {
            const d = DEF_DEFS[key];
            if (!d) return null;
            return (
              <button
                key={key}
                onClick={() => setActiveStat(key)}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                  activeStat === key ? "bg-accent text-white" : "bg-bg-secondary/60 text-text-tertiary"
                }`}
              >
                {d.emoji} {d.label}
              </button>
            );
          }
          const saber = SABER_DEFS[key];
          const d = STAT_DEFS[key];
          if (!saber && !d) return null;
          const label = saber
            ? saber.label
            : d!.desc.replace(/\s*랭킹.*$/, "").replace(/\s*\(.*\)\s*$/, "").trim();
          const emoji = saber ? saber.emoji : d!.emoji;
          return (
            <button
              key={key}
              onClick={() => setActiveStat(key)}
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                activeStat === key
                  ? "bg-accent text-white"
                  : "bg-bg-secondary/60 text-text-tertiary"
              }`}
            >
              {emoji} {label}
            </button>
          );
        })}
      </div>

      {fmtUpdated(updatedAtByType[view]) && (
        <p className="mb-2 -mt-1 text-[11px] text-text-tertiary">
          마지막 업데이트: {fmtUpdated(updatedAtByType[view])} {
            isDefense
              ? "(수비 기록 일일 갱신)"
              : sourceByType[view] === "live"
                ? "(경기 기록 실시간 반영)"
                : "(최신 집계 기준)"
          }
        </p>
      )}

      {qualNote(view, activeStat, isDefense) && (
        <p className="mb-2 -mt-1 text-[11px] text-text-tertiary">
          ⓘ 자격 기준: {qualNote(view, activeStat, isDefense)}{" "}
          {!loading && unqualified.length > 0 ? "· 미달 선수는 하단 별도 표시" : "(미달 선수 제외)"}
        </p>
      )}

      {SABER_DEFS[activeStat]?.estimate && (
        <p className="mb-3 -mt-1 text-[11px] leading-snug text-text-tertiary">
          ⓘ {saberDisclaimer(SABER_DEFS[activeStat].label.replace(/^예측\s*/, ""))}
        </p>
      )}

      {loading ? (
        <div className="py-16 text-center text-text-tertiary text-sm">로딩 중...</div>
      ) : ranked.length === 0 && unqualified.length === 0 ? (
        <div className="py-16 text-center text-text-tertiary text-sm">
          기록이 아직 없습니다
        </div>
      ) : (
        <div key={`${view}-${activeStat}-${scopeTeamId ?? "all"}`} className="pb-24">
          {ranked.length === 0 && (
            <p className="py-6 text-center text-[13px] text-text-tertiary">
              아직 규정 충족 선수가 없어요. 미달 선수 기록은 아래에서 확인하세요.
            </p>
          )}
          <div className="space-y-2">
          {ranked.map((p, i) => {
            const teamId = (typeof p.teamId === "number" ? p.teamId : null) ?? teamIdFromText(p.team) ?? 0;
            const backNo = scopeTeamId != null ? ((p as Row & { __backNo?: string | null }).__backNo ?? rosterBackNo(p)) : null;
            const isFav = favIds.has(String(p.kboId ?? "")) || favIds.has(String(p.playerId ?? ""));
            const teamColor = TEAMS.find((t) => t.id === teamId)?.colorPrimary || "#FF6B35";
            const rank = p.rank || i + 1;

            const cardStyle: CSSProperties | undefined = isFav
              ? { borderLeft: `3px solid ${hexToRgba(teamColor, 0.8)}`, backgroundColor: hexToRgba(teamColor, 0.12) }
              : undefined;

            const href =
              getCanonicalPlayerHref({ name: p.name, kboId: p.kboId, playerId: p.playerId, teamId }) ??
              `/community/players/${p.kboId || p.playerId || p.name}`;

            return (
              <Link key={p.kboId || p.playerId || `${p.name}-${i}`} href={href} prefetch={false}>
                <GlassCard pressable className="p-3 flex items-center gap-3" style={cardStyle}>
                  <span
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold flex-shrink-0 ${
                      activeStat === "backno"
                        ? "bg-bg-tertiary text-text-tertiary" // 등번호순 = 순위 개념 아님 → 메달 색 없이 중립 배지
                        : rank === 1
                          ? "bg-yellow-500/20 text-yellow-400"
                          : rank === 2
                            ? "bg-gray-400/20 text-gray-300"
                            : rank === 3
                              ? "bg-amber-700/20 text-amber-600"
                              : "bg-bg-tertiary text-text-tertiary"
                    }`}
                  >
                    {rank}
                  </span>
                  <PlayerAvatar
                    name={p.name}
                    teamId={teamId}
                    photoUrl={getPlayerPhotoUrl(p.name, p.kboId || p.playerId, teamId)}
                    size={44}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-semibold text-text-primary">{p.name}</span>
                    <span className="ml-1.5 text-xs text-text-tertiary">{p.team}</span>
                    {backNo != null && activeStat !== "backno" ? (
                      <span className="ml-1.5 text-xs text-text-tertiary">No.{backNo}</span>
                    ) : null}
                    {isDefense && p.position ? (
                      <span className="ml-1.5 text-xs text-text-tertiary">· {String(p.position)}</span>
                    ) : null}
                  </div>
                  <span className="text-lg font-bold tabular-nums text-text-primary">
                    {activeStat === "backno" ? (backNo ?? "—") : fmt(getValue(p))}
                  </span>
                </GlassCard>
              </Link>
            );
          })}
          </div>

          {/* 규정 미달 선수 — 접이식. 리오스처럼 규정이닝/타석 미달이라 순위에서 빠진 선수 확인용.
              규정 충족 선수가 0명이면(예: 팀 스코프 타율) 토글 없이 항상 펼쳐 보여준다. */}
          {unqualified.length > 0 && (
            <div className={ranked.length > 0 ? "mt-5" : "mt-1"}>
              {ranked.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowUnqual((s) => !s)}
                  className="w-full flex items-center justify-center gap-1 rounded-lg border border-white/10 bg-bg-glass/30 py-2.5 text-xs font-semibold text-text-secondary"
                >
                  규정 미달 선수 {unqualified.length}명 {showUnqual ? "접기 ▴" : "보기 ▾"}
                </button>
              )}

              {(showUnqual || ranked.length === 0) && (
                <>
                  {unqualNote && (
                    <p className="mt-2 mb-1 text-[11px] leading-snug text-text-tertiary">ⓘ {unqualNote}</p>
                  )}
                  {!isDefense && (
                    <p className="mb-2 text-[10px] text-text-tertiary">
                      우측 미니 그래프 = 주간 {view === "pitcher" ? "ERA" : "타율"} 추이 (선수 페이지에서 전체 추이 확인)
                    </p>
                  )}
                  <div className="space-y-2">
                    {unqualified.map((p, i) => {
                      const teamId = (typeof p.teamId === "number" ? p.teamId : null) ?? teamIdFromText(p.team) ?? 0;
                      const backNo = scopeTeamId != null ? rosterBackNo(p) : null;
                      const href =
                        getCanonicalPlayerHref({ name: p.name, kboId: p.kboId, playerId: p.playerId, teamId }) ??
                        `/community/players/${p.kboId || p.playerId || p.name}`;
                      return (
                        <Link key={p.kboId || p.playerId || `unq-${p.name}-${i}`} href={href} prefetch={false}>
                          <GlassCard pressable className="p-3 flex items-center gap-3 opacity-70">
                            <span className="flex h-8 w-8 items-center justify-center rounded-full text-[10px] font-semibold flex-shrink-0 bg-bg-tertiary text-text-tertiary">
                              미달
                            </span>
                            <PlayerAvatar
                              name={p.name}
                              teamId={teamId}
                              photoUrl={getPlayerPhotoUrl(p.name, p.kboId || p.playerId, teamId)}
                              size={44}
                            />
                            <div className="flex-1 min-w-0">
                              <div className="truncate">
                                <span className="text-sm font-semibold text-text-primary">{p.name}</span>
                                <span className="ml-1.5 text-xs text-text-tertiary">{p.team}</span>
                                {backNo != null ? (
                                  <span className="ml-1.5 text-xs text-text-tertiary">No.{backNo}</span>
                                ) : null}
                              </div>
                              <span className="text-[11px] text-text-tertiary tabular-nums">{unqualProgress(p)}</span>
                            </div>
                            {!isDefense && (
                              <MiniWeeklyTrend
                                playerId={String(p.kboId ?? p.playerId ?? "")}
                                isPitcher={view === "pitcher"}
                                color={TEAMS.find((t) => t.id === teamId)?.colorPrimary || "#9CA3AF"}
                              />
                            )}
                            <span className="text-lg font-bold tabular-nums text-text-secondary">{fmt(getValue(p))}</span>
                          </GlassCard>
                        </Link>
                      );
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
