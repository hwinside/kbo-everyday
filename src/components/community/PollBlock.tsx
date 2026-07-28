"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Check, Clock } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import { getTeamBySlug } from "@/lib/constants/teams";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import {
  fetchPollDetail,
  castPollVote,
  type PollDetail,
  type PollDetailOption,
} from "@/lib/community/poll-client";

// 상세 선지 렌더는 current SSOT(teams.ts / roster / photo)를 refId 로 현재 해석하고,
// 서버 snapshot(label/image)은 fallback 으로만 쓴다(spec §1/§3.2 — 팀명/로고·선수명/사진
// 변경이 상세에 즉시 반영). etc 는 snapshot label(=자유입력)이 SSOT.
const ROSTER_NAME_BY_KBOID = new Map(
  (PLAYERS_ROSTER as { kboId: string; name: string }[]).map((p) => [String(p.kboId), p.name]),
);

function resolveOption(o: PollDetailOption): { label: string; image: string | null } {
  if (o.kind === "team" && o.refId) {
    const team = getTeamBySlug(o.refId);
    if (team) return { label: team.name, image: team.logoPath };
  } else if (o.kind === "player" && o.refId) {
    const name = ROSTER_NAME_BY_KBOID.get(o.refId);
    if (name) return { label: name, image: getPlayerPhotoByKboId(o.refId) ?? o.image };
  }
  // etc 또는 current 해석 실패 → snapshot fallback
  return { label: o.label ?? (o.kind === "etc" ? "(빈 선지)" : o.refId ?? ""), image: o.image };
}

/**
 * 커뮤니티 투표 상세 블록 (spec §6, S2).
 *
 * - 미투표·진행중 → 선지 버튼만(결과 숨김). 투표/마감 → 막대 %+표수+내 선택 하이라이트.
 * - 마감 → 투표 비활성 '마감됨' + 전원 결과 공개. 투표했고 진행중이면 '변경' 가능.
 * - 결과 게이트·마감·중복·단일선택은 서버(route+RPC)가 SSOT. 여기서는 표시만.
 * - 질문/설명(post.title/content)은 PostDetail 본문이 이미 렌더하므로 여기서는
 *   선지·집계·상태만 렌더(중복 방지).
 */

interface PollBlockProps {
  postId: number;
  /** 로그인 필요 시 호스트가 로그인 시트를 띄우도록. */
  onRequireLogin?: () => void;
}

function pct(votes: number | null, voterCount: number): number {
  if (!votes || voterCount <= 0) return 0;
  return Math.round((votes / voterCount) * 100);
}

function remainingLabel(closesAt: string, closed: boolean): string {
  if (closed) return "마감됨";
  const diff = new Date(closesAt).getTime() - Date.now();
  if (diff <= 0) return "마감됨";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}분 후 마감`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 후 마감`;
  return `${Math.floor(hr / 24)}일 후 마감`;
}

export default function PollBlock({ postId, onRequireLogin }: PollBlockProps) {
  const { user } = useAuth();
  const [detail, setDetail] = useState<PollDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 투표 모드: 미투표(진행중)거나 '변경'을 눌렀을 때. 선택 상태 보관.
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [voteError, setVoteError] = useState<string | null>(null);
  // 페이지를 열어둔 채 마감시각을 넘겼을 때 경계에서 즉시 마감 처리(재조회로 결과 공개 수렴).
  const [boundaryClosed, setBoundaryClosed] = useState(false);
  // 장기(최대 30일) 마감까지 hop 재예약하기 위한 tick(setTimeout 2^31ms 상한 회피).
  const [hopTick, setHopTick] = useState(0);

  const load = useCallback(async () => {
    try {
      const d = await fetchPollDetail(postId);
      setDetail(d);
      setLoadError(d ? null : "투표를 찾을 수 없어요");
      // 진행중이고 아직 결과를 못 보는 상태(미투표)면 자동 투표 모드.
      if (d && !d.closed && !d.canSeeResults) {
        setEditing(true);
        setSelected(new Set());
      } else {
        setEditing(false);
        setSelected(new Set(d?.mySelection ?? []));
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "투표를 불러오지 못했어요");
    } finally {
      setLoading(false);
    }
  }, [postId]);

  useEffect(() => {
    load();
  }, [load]);

  // 마감 경계 타이머: 페이지를 열어둔 채 closesAt 을 넘으면 즉시 마감 처리 + 재조회로
  // 서버 canonical 결과(closed=true, vote_count 공개)를 수렴시킨다. 마감까지의 간격이
  // 길면(최대 30일) setTimeout 상한(2^31ms)·장기 드리프트 문제가 있으므로 6시간 hop 으로
  // 잖게 끊어 재예약(hopTick)해 전 범위를 커버한다. detail.closed / detail 없으면 스케줄 안 함.
  useEffect(() => {
    if (!detail || detail.closed) return;
    const ms = new Date(detail.closesAt).getTime() - Date.now();
    if (ms <= 0) {
      setBoundaryClosed(true);
      load();
      return;
    }
    const MAX_HOP = 6 * 60 * 60 * 1000; // 6시간 hop
    if (ms > MAX_HOP) {
      // 아직 멀었음 → 6시간 뒤 tick 증가 → effect 재실행으로 ms 재계산/재예약.
      const t = setTimeout(() => setHopTick((n) => n + 1), MAX_HOP);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => {
      setBoundaryClosed(true);
      load();
    }, ms + 250);
    return () => clearTimeout(t);
  }, [detail, load, hopTick]);

  function toggle(optionId: number, allowMultiple: boolean) {
    setVoteError(null);
    setSelected((prev) => {
      const next = new Set(prev);
      if (allowMultiple) {
        if (next.has(optionId)) next.delete(optionId);
        else next.add(optionId);
      } else {
        next.clear();
        next.add(optionId);
      }
      return next;
    });
  }

  async function submitVote() {
    if (!detail || submitting) return;
    if (!user) {
      onRequireLogin?.();
      return;
    }
    if (selected.size === 0) {
      setVoteError("선지를 선택해 주세요");
      return;
    }
    setSubmitting(true);
    setVoteError(null);
    try {
      await castPollVote(postId, [...selected]);
      await load();
    } catch (e) {
      setVoteError(e instanceof Error ? e.message : "투표에 실패했어요");
    } finally {
      setSubmitting(false);
    }
  }

  function startChange() {
    if (!detail) return;
    setSelected(new Set(detail.mySelection));
    setEditing(true);
    setVoteError(null);
  }

  if (loading) {
    return <div className="mt-4 py-6 text-center text-sm text-text-tertiary">투표 불러오는 중…</div>;
  }
  if (!detail) {
    return <div className="mt-4 py-6 text-center text-sm text-text-tertiary">{loadError ?? "투표를 찾을 수 없어요"}</div>;
  }

  // 경계 경과 즉시 반영: 서버 closed 또는 클라이언트 경계 도달. 재조회 전까지도 투표 비활성.
  const effectiveClosed = detail.closed || boundaryClosed || Date.now() >= new Date(detail.closesAt).getTime();
  const showResults = (detail.canSeeResults && !editing) || (effectiveClosed && detail.canSeeResults);
  const status = effectiveClosed ? "마감" : "진행중";

  // 결과 공개 시에만 받은 표 많은 순(내림차순)으로 정렬. Array#sort 는 안정 정렬이므로
  // 동표 선지는 원래(작성) 순서를 유지한다. 투표 모드에서는 작성 순서 그대로 둔다.
  const displayOptions = showResults
    ? [...detail.options].sort((a, b) => (b.voteCount ?? 0) - (a.voteCount ?? 0))
    : detail.options;

  return (
    <div className="mt-4 rounded-2xl border border-border p-4">
      {/* 상태 헤더 */}
      <div className="flex items-center gap-2 mb-3">
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            effectiveClosed ? "bg-bg-tertiary text-text-tertiary" : "bg-accent/15 text-accent"
          }`}
        >
          {status}
        </span>
        <span className="text-xs text-text-tertiary flex items-center gap-1">
          <Clock size={12} /> {remainingLabel(detail.closesAt, effectiveClosed)}
        </span>
        <span className="text-xs text-text-tertiary ml-auto">👥 {detail.voterCount}명 참여</span>
      </div>

      {/* 선지 — 결과 공개 시 받은 표 많은 순(내림차순)으로 정렬, 동표는 원래 순서 유지(안정 정렬).
          투표 모드(결과 미공개)에서는 작성 순서 그대로 노출해 순위 유출을 막는다. */}
      <div className="space-y-2">
        {displayOptions.map((o) => (
          <PollOptionRow
            key={o.id}
            option={o}
            showResults={showResults}
            voterCount={detail.voterCount}
            selectable={editing && !effectiveClosed}
            checked={selected.has(o.id)}
            mine={detail.mySelection.includes(o.id)}
            onToggle={() => toggle(o.id, detail.allowMultiple)}
          />
        ))}
      </div>

      {voteError && <p className="text-sm text-red-500 mt-2">{voteError}</p>}

      {/* 액션 */}
      <div className="mt-3 flex items-center gap-2">
        {effectiveClosed ? (
          <span className="text-sm text-text-tertiary">마감된 투표예요</span>
        ) : editing ? (
          <button
            onClick={submitVote}
            disabled={submitting || selected.size === 0}
            className="flex-1 py-2.5 rounded-xl bg-accent text-white text-sm font-semibold disabled:opacity-40 active:scale-[0.98] transition-transform"
          >
            {submitting ? "처리 중…" : detail.voted ? "변경 저장" : "투표하기"}
          </button>
        ) : (
          <>
            <span className="text-sm text-text-secondary flex items-center gap-1">
              <Check size={14} className="text-accent" /> 투표했어요
            </span>
            <button
              onClick={startChange}
              className="ml-auto text-sm font-medium text-accent active:scale-95 transition-transform"
            >
              변경
            </button>
          </>
        )}
      </div>

      {detail.allowMultiple && editing && !effectiveClosed && (
        <p className="text-[11px] text-text-tertiary mt-2">복수선택 가능한 투표예요</p>
      )}
      {!detail.canSeeResults && editing && !effectiveClosed && (
        <p className="text-[11px] text-text-tertiary mt-1">투표하면 중간 결과를 볼 수 있어요</p>
      )}
      {detail.voted && !effectiveClosed && (
        <p className="text-[11px] text-text-tertiary mt-1">첫 투표 이후에는 질문·선지를 수정할 수 없어요</p>
      )}
    </div>
  );
}

function PollOptionRow({
  option,
  showResults,
  voterCount,
  selectable,
  checked,
  mine,
  onToggle,
}: {
  option: PollDetailOption;
  showResults: boolean;
  voterCount: number;
  selectable: boolean;
  checked: boolean;
  mine: boolean;
  onToggle: () => void;
}) {
  const percent = showResults ? pct(option.voteCount, voterCount) : 0;
  // current SSOT 해석(팀명/로고·선수명/사진) → 실패 시 snapshot fallback.
  const { label, image } = resolveOption(option);

  const inner = (
    <div className="relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-bg-tertiary overflow-hidden">
      {/* 결과 막대 배경 */}
      {showResults && (
        <div
          className={`absolute inset-y-0 left-0 ${mine ? "bg-accent/25" : "bg-text-tertiary/15"}`}
          style={{ width: `${percent}%` }}
          aria-hidden
        />
      )}
      {/* 아이콘/로고 (current SSOT → snapshot fallback) */}
      {image ? (
        <Image
          src={image}
          alt={label}
          width={26}
          height={26}
          className="rounded-full object-cover w-[26px] h-[26px] flex-none bg-bg-secondary relative"
        />
      ) : (
        <span className="w-[26px] h-[26px] rounded-full bg-bg-secondary flex-none relative" />
      )}
      <span className={`flex-1 text-sm relative truncate ${mine ? "font-semibold text-text-primary" : "text-text-primary"}`}>
        {label}
        {mine && <Check size={13} className="inline ml-1 text-accent" />}
      </span>
      {/* 선택 모드 체크 or 결과 수치 */}
      {selectable ? (
        <span
          className={`w-5 h-5 rounded-full border flex items-center justify-center flex-none relative ${
            checked ? "bg-accent border-accent" : "border-text-tertiary"
          }`}
        >
          {checked && <Check size={13} className="text-white" />}
        </span>
      ) : showResults ? (
        <span className="text-xs text-text-secondary flex-none relative tabular-nums">
          {percent}% · {option.voteCount ?? 0}표
        </span>
      ) : null}
    </div>
  );

  if (selectable) {
    return (
      <button onClick={onToggle} className="w-full text-left active:scale-[0.99] transition-transform">
        {inner}
      </button>
    );
  }
  return inner;
}
