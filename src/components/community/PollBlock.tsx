"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { Check, Clock } from "lucide-react";
import { useAuth } from "@/lib/supabase/AuthContext";
import {
  fetchPollDetail,
  castPollVote,
  type PollDetail,
  type PollDetailOption,
} from "@/lib/community/poll-client";

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

  const showResults = detail.canSeeResults && !editing;
  const status = detail.closed ? "마감" : "진행중";

  return (
    <div className="mt-4 rounded-2xl border border-border p-4">
      {/* 상태 헤더 */}
      <div className="flex items-center gap-2 mb-3">
        <span
          className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
            detail.closed ? "bg-bg-tertiary text-text-tertiary" : "bg-accent/15 text-accent"
          }`}
        >
          {status}
        </span>
        <span className="text-xs text-text-tertiary flex items-center gap-1">
          <Clock size={12} /> {remainingLabel(detail.closesAt, detail.closed)}
        </span>
        <span className="text-xs text-text-tertiary ml-auto">👥 {detail.voterCount}명 참여</span>
      </div>

      {/* 선지 */}
      <div className="space-y-2">
        {detail.options.map((o) => (
          <PollOptionRow
            key={o.id}
            option={o}
            showResults={showResults}
            voterCount={detail.voterCount}
            selectable={editing && !detail.closed}
            checked={selected.has(o.id)}
            mine={detail.mySelection.includes(o.id)}
            onToggle={() => toggle(o.id, detail.allowMultiple)}
          />
        ))}
      </div>

      {voteError && <p className="text-sm text-red-500 mt-2">{voteError}</p>}

      {/* 액션 */}
      <div className="mt-3 flex items-center gap-2">
        {detail.closed ? (
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

      {detail.allowMultiple && editing && !detail.closed && (
        <p className="text-[11px] text-text-tertiary mt-2">복수선택 가능한 투표예요</p>
      )}
      {!detail.canSeeResults && editing && !detail.closed && (
        <p className="text-[11px] text-text-tertiary mt-1">투표하면 중간 결과를 볼 수 있어요</p>
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
  const label = option.label ?? (option.kind === "etc" ? "(빈 선지)" : option.refId ?? "");

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
      {/* 아이콘/로고 */}
      {option.image ? (
        <Image
          src={option.image}
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
