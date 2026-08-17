"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Plus, Trash2, Users, User, Type as TypeIcon } from "lucide-react";
import Image from "next/image";
import TeamTagger from "./TeamTagger";
import PlayerTagger from "./PlayerTagger";
import PlayerPickerSheet from "./PlayerPickerSheet";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import { useAuth } from "@/lib/supabase/AuthContext";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { getPlayerPhotoByKboId } from "@/lib/constants/player-photos";
import { formatPlayerTag } from "@/lib/utils/player-tags";
import { createPoll, type PollOptionInput } from "@/lib/community/poll-client";
import { hasRequiredTeamTag, isAllTeamsSelected } from "@/lib/utils/post-scope";
import { useAllTeamsScopeConfirm } from "./useAllTeamsScopeConfirm";

/**
 * 커뮤니티 투표 작성 컴포저 (spec: specs/community-poll.md §6, S2).
 *
 * - 선지는 작성순(배열 순서 = position)으로 유지. 팀=TeamTagger, 선수=PlayerPickerSheet
 *   를 재사용해 기존 커뮤니티 태그 UX 와 동일하게 고른다. 기타는 자유 텍스트 행.
 * - 한 투표에 팀 선지와 선수 선지 공존을 UI 에서 원천 차단(기타는 항상 허용).
 * - 라벨/이미지(팀 로고·선수 사진)는 서버(create_poll route)가 canonical 파생하므로,
 *   여기서는 미리보기용으로만 로컬 SSOT(teams.ts / roster+photo map)를 참조한다.
 * - 개수(2~10)·마감범위(10분~30일)·공존금지 등 권위 검증은 서버 RPC 가 재수행.
 */

interface WritePollProps {
  isOpen: boolean;
  onClose: () => void;
  /** 생성 성공 시 새 postId 전달(호스트가 상세로 이동/피드 갱신). */
  onCreated: (postId: number) => void;
}

type DraftOption =
  | { kind: "team"; refId: string; label: string; image: string | null }
  | { kind: "player"; refId: string; label: string; image: string | null }
  | { kind: "etc"; label: string };

// 기존 커뮤니티 태그(PlayerTagger)와 동일 모델.
type PlayerTag = { kboId: string; name: string; teamId: number };

const MAX_OPTIONS = 10;
const MIN_MINUTES = 10;
const MAX_DAYS = 30;

const ROSTER_NAME_BY_KBOID = new Map(
  (PLAYERS_ROSTER as { kboId: string; name: string }[]).map((p) => [String(p.kboId), p.name]),
);

// 마감 프리셋(분 단위). 커스텀 datetime-local 도 병행 제공.
const DURATION_PRESETS: { label: string; minutes: number }[] = [
  { label: "1시간", minutes: 60 },
  { label: "6시간", minutes: 360 },
  { label: "1일", minutes: 1440 },
  { label: "3일", minutes: 4320 },
  { label: "7일", minutes: 10080 },
  { label: "30일", minutes: 43200 },
];

function toLocalInputValue(d: Date): string {
  // datetime-local 은 로컬 타임존 'YYYY-MM-DDTHH:mm' 문자열을 기대.
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 16);
}

export default function WritePoll({ isOpen, onClose, onCreated }: WritePollProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [options, setOptions] = useState<DraftOption[]>([]);
  // 기본 마감 = 1일 후
  const [closesAtLocal, setClosesAtLocal] = useState<string>(() =>
    toLocalInputValue(new Date(Date.now() + 1440 * 60000)),
  );
  // datetime-local 경계(마운트 시각 기준). 권위 마감범위 검증은 서버 RPC 가 재수행하므로
  // 마운트 기준 경계로 충분(렌더 중 Date.now 재호출 회피).
  const [minLocal] = useState<string>(() => toLocalInputValue(new Date(Date.now() + MIN_MINUTES * 60000)));
  const [maxLocal] = useState<string>(() => toLocalInputValue(new Date(Date.now() + MAX_DAYS * 86400000)));
  const [teamSheetOpen, setTeamSheetOpen] = useState(false);
  const [playerSheetOpen, setPlayerSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasTeam = options.some((o) => o.kind === "team");
  const hasPlayer = options.some((o) => o.kind === "player");
  const teamOptionSlugs = useMemo(
    () => options.filter((o): o is Extract<DraftOption, { kind: "team" }> => o.kind === "team").map((o) => o.refId),
    [options],
  );
  const full = options.length >= MAX_OPTIONS;

  // 기존 일반/사진글과 동일한 팀·선수 태그 설정(피드 노출용). 선지에서 자동 파생되는
  // 태그와 서버에서 union 된다(etc만 있는 투표도 원하는 피드에 노출 가능).
  const [tagTeamSlugs, setTagTeamSlugs] = useState<string[]>([]);
  const [taggedPlayers, setTaggedPlayers] = useState<PlayerTag[]>([]);

  // 최애팀(profile.team_id) — 전체공개 확인창 "아니요" 시 축소 대상.
  const { profile } = useAuth();
  const favoriteSlug = (() => {
    const id = (profile as Record<string, unknown> | null)?.team_id as number | undefined;
    return id ? getTeamById(id)?.slug : undefined;
  })();
  // 전체공개(10구단 전부 선택) 시 예/아니요 확인창.
  const { confirmAllTeamsScope, allTeamsScopeDialog } = useAllTeamsScopeConfirm();

  // 게시글은 **명시적 team_tags 1개 이상** 필수(하린아빠 2026-08-06 / 삼순 정정).
  // 팀/선수 선지가 서버에서 team_tags 로 union 되긴 하지만, 그건 파생이지 글쓴이의 명시적
  // 공개범위 선택이 아니다 — 필수조건을 대신하지 않는다.
  const hasTeamScope = hasRequiredTeamTag(tagTeamSlugs);

  // 설명 textarea 자동 세로 확장(엔터·긴 글 대응). content 변경·열림 시 height 재계산.
  // max(약 10줄) 도달 후에는 내부 스크롤 허용(overflow-y-auto) — cap 되었다고 스크롤까지
  // 막히지 않게 한다(삼순 지적). 254px ≈ max-h-64(256px) - 상하 경계.
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const CONTENT_MAX_PX = 256;
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = el.scrollHeight;
    if (next > CONTENT_MAX_PX) {
      el.style.height = `${CONTENT_MAX_PX}px`;
      el.style.overflowY = "auto";
    } else {
      el.style.height = `${next}px`;
      el.style.overflowY = "hidden";
    }
  }, [content, isOpen]);

  function reset() {
    setTitle("");
    setContent("");
    setAllowMultiple(false);
    setOptions([]);
    setTagTeamSlugs([]);
    setTaggedPlayers([]);
    setClosesAtLocal(toLocalInputValue(new Date(Date.now() + 1440 * 60000)));
    setError(null);
    setSubmitting(false);
  }

  function close() {
    reset();
    onClose();
  }

  // 팀 토글: 선택되면 옵션 추가(작성순 append), 해제되면 제거.
  function toggleTeam(slug: string) {
    setError(null);
    setOptions((prev) => {
      const exists = prev.some((o) => o.kind === "team" && o.refId === slug);
      if (exists) return prev.filter((o) => !(o.kind === "team" && o.refId === slug));
      if (prev.length >= MAX_OPTIONS) return prev;
      const team = TEAMS.find((t) => t.slug === slug);
      if (!team) return prev;
      return [...prev, { kind: "team", refId: slug, label: team.name, image: team.logoPath }];
    });
  }

  function addPlayer(kboId: string) {
    setError(null);
    setOptions((prev) => {
      if (prev.some((o) => o.kind === "player" && o.refId === kboId)) return prev; // 중복 방지
      if (prev.length >= MAX_OPTIONS) return prev;
      const name = ROSTER_NAME_BY_KBOID.get(kboId) ?? kboId;
      return [...prev, { kind: "player", refId: kboId, label: name, image: getPlayerPhotoByKboId(kboId) }];
    });
    setPlayerSheetOpen(false);
  }

  function addEtc() {
    setError(null);
    setOptions((prev) => (prev.length >= MAX_OPTIONS ? prev : [...prev, { kind: "etc", label: "" }]));
  }

  function updateEtc(idx: number, label: string) {
    setOptions((prev) => prev.map((o, i) => (i === idx && o.kind === "etc" ? { ...o, label } : o)));
  }

  function removeOption(idx: number) {
    setError(null);
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  function applyPreset(minutes: number) {
    // eslint-disable-next-line react-hooks/purity -- 프리셋 버튼(이벤트) 핸들러, 렌더 순수성과 무관
    setClosesAtLocal(toLocalInputValue(new Date(Date.now() + minutes * 60000)));
  }

  function validate(): { closesAtIso: string; opts: PollOptionInput[] } | null {
    if (!title.trim()) {
      setError("질문을 입력해 주세요");
      return null;
    }
    if (options.length < 2) {
      setError("선지는 2개 이상이어야 해요");
      return null;
    }
    if (options.length > MAX_OPTIONS) {
      setError(`선지는 최대 ${MAX_OPTIONS}개까지예요`);
      return null;
    }
    if (hasTeam && hasPlayer) {
      setError("한 투표에 팀과 선수를 함께 넣을 수 없어요");
      return null;
    }
    // 게시글은 명시적 team_tags 1개 이상 필수(하린아빠 2026-08-06 / 삼순 정정).
    if (!hasTeamScope) {
      setError("팀을 최소 1개 선택해주세요 (모든 팀에 공개하려면 10개 구단을 모두 선택)");
      return null;
    }
    for (const o of options) {
      if (o.kind === "etc" && !o.label.trim()) {
        setError("기타 선지의 내용을 입력해 주세요");
        return null;
      }
    }
    const closes = new Date(closesAtLocal);
    if (Number.isNaN(closes.getTime())) {
      setError("마감시간이 올바르지 않아요");
      return null;
    }
    const now = Date.now();
    if (closes.getTime() < now + MIN_MINUTES * 60000) {
      setError(`마감은 지금부터 최소 ${MIN_MINUTES}분 뒤여야 해요`);
      return null;
    }
    if (closes.getTime() > now + MAX_DAYS * 86400000) {
      setError(`마감은 최대 ${MAX_DAYS}일 이내여야 해요`);
      return null;
    }
    const opts: PollOptionInput[] = options.map((o) =>
      o.kind === "etc"
        ? { kind: "etc", label: o.label.trim() }
        : { kind: o.kind, refId: o.refId },
    );
    return { closesAtIso: closes.toISOString(), opts };
  }

  async function handleSubmit() {
    if (submitting) return;
    const v = validate();
    if (!v) return;

    // 전체공개(10구단 전부 선택) 시도 → 확인창. 예=그대로 등록 / 아니요=초안 유지 + 최애팀 1개 축소.
    if (isAllTeamsSelected(tagTeamSlugs)) {
      const yes = await confirmAllTeamsScope();
      if (!yes) {
        if (favoriteSlug) setTagTeamSlugs([favoriteSlug]);
        return; // 등록하지 않고 작성중 유지.
      }
    }

    setSubmitting(true);
    setError(null);
    try {
      const postId = await createPoll({
        title: title.trim(),
        content: content.trim(),
        allowMultiple,
        closesAt: v.closesAtIso,
        options: v.opts,
        teamTags: tagTeamSlugs,
        playerTags: taggedPlayers.map((p) => formatPlayerTag(p.kboId, p.name)),
      });
      const created = postId;
      reset();
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : "투표 생성에 실패했어요");
      setSubmitting(false);
    }
  }

  if (!isOpen) return null;

  return (
    <>
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[10000] flex items-end"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="absolute inset-0 bg-black/60" onClick={close} />
        <motion.div
          className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl max-h-[92vh] flex flex-col"
          initial={{ y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "100%" }}
          transition={{ type: "spring", damping: 25 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-none">
            <button onClick={close} aria-label="닫기">
              <X size={22} className="text-text-secondary" />
            </button>
            <h2 className="text-lg font-bold text-text-primary">투표 만들기</h2>
            <button
              onClick={handleSubmit}
              disabled={submitting || !hasTeamScope}
              className="text-sm font-semibold text-accent disabled:text-text-tertiary"
            >
              {submitting ? "등록 중..." : "등록"}
            </button>
          </div>

          {/* Body (scroll) */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            {/* 질문 */}
            <div>
              <label className="block text-xs font-semibold text-text-tertiary mb-1.5">질문</label>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="무엇을 투표할까요?"
                maxLength={200}
                className="w-full px-3 py-2.5 rounded-xl bg-bg-tertiary text-text-primary placeholder:text-text-tertiary outline-none"
              />
            </div>

            {/* 설명(선택) */}
            <div>
              <label className="block text-xs font-semibold text-text-tertiary mb-1.5">설명 (선택)</label>
              <textarea
                ref={contentRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="투표에 대한 설명을 적어주세요 (엔터로 줄바꿈)"
                rows={2}
                maxLength={2000}
                className="w-full px-3 py-2.5 rounded-xl bg-bg-tertiary text-text-primary placeholder:text-text-tertiary outline-none resize-none min-h-[3rem]"
              />
            </div>

            {/* 선지 — 추가 토글(팀/선수/기타)을 리스트 위에 배치(더 직관적) */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold text-text-tertiary">
                  선지 <span className="text-text-tertiary">({options.length}/{MAX_OPTIONS})</span>
                </label>
              </div>

              {/* 추가 버튼들 (선지 리스트 위) */}
              <div className="grid grid-cols-3 gap-2">
                <button
                  onClick={() => setTeamSheetOpen(true)}
                  disabled={hasPlayer || full}
                  className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-bg-tertiary active:scale-95 transition-transform disabled:opacity-40"
                >
                  <Users size={18} className="text-accent" />
                  <span className="text-xs font-medium text-text-primary">팀</span>
                </button>
                <button
                  onClick={() => setPlayerSheetOpen(true)}
                  disabled={hasTeam || full}
                  className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-bg-tertiary active:scale-95 transition-transform disabled:opacity-40"
                >
                  <User size={18} className="text-accent" />
                  <span className="text-xs font-medium text-text-primary">선수</span>
                </button>
                <button
                  onClick={addEtc}
                  disabled={full}
                  className="flex flex-col items-center gap-1 py-2.5 rounded-xl bg-bg-tertiary active:scale-95 transition-transform disabled:opacity-40"
                >
                  <Plus size={18} className="text-accent" />
                  <span className="text-xs font-medium text-text-primary">기타</span>
                </button>
              </div>
              {(hasTeam || hasPlayer) && (
                <p className="text-[11px] text-text-tertiary mt-2">
                  한 투표에는 {hasTeam ? "팀" : "선수"} 선지만 넣을 수 있어요 (기타는 함께 가능)
                </p>
              )}

              {options.length === 0 && (
                <p className="text-xs text-text-tertiary py-3 text-center">
                  위에서 팀·선수·기타 선지를 추가하세요 (2~10개)
                </p>
              )}

              <div className="space-y-2 mt-3">
                {options.map((o, idx) => (
                  <div key={`${o.kind}-${idx}-${o.kind === "etc" ? "etc" : o.refId}`} className="flex items-center gap-2">
                    {o.kind === "etc" ? (
                      <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl bg-bg-tertiary">
                        <TypeIcon size={16} className="text-text-tertiary flex-none" />
                        <input
                          value={o.label}
                          onChange={(e) => updateEtc(idx, e.target.value)}
                          placeholder="직접 입력"
                          maxLength={60}
                          className="flex-1 bg-transparent text-sm text-text-primary placeholder:text-text-tertiary outline-none"
                        />
                      </div>
                    ) : (
                      <div className="flex-1 flex items-center gap-2.5 px-3 py-2 rounded-xl bg-bg-tertiary">
                        {o.image ? (
                          <Image
                            src={o.image}
                            alt={o.label}
                            width={28}
                            height={28}
                            className="rounded-full object-cover w-7 h-7 flex-none bg-bg-secondary"
                          />
                        ) : (
                          <span className="w-7 h-7 rounded-full bg-bg-secondary flex-none" />
                        )}
                        <span className="flex-1 text-sm text-text-primary truncate">{o.label}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary text-text-tertiary flex-none">
                          {o.kind === "team" ? "팀" : "선수"}
                        </span>
                      </div>
                    )}
                    <button
                      onClick={() => removeOption(idx)}
                      aria-label="선지 삭제"
                      className="p-2 text-text-tertiary active:scale-90 transition-transform flex-none"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* 태그 설정 — 일반/사진글과 동일(팀 칩 + 선수 태그). 팀 태그는 공개범위라 필수,
                선수 태그는 선택. 선지 파생 태그와 서버에서 union 돼 피드 노출을 결정한다. */}
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-text-tertiary mb-1.5">
                  공개범위 <span className="text-[#FF453A]">*</span>
                </label>
                <p className="text-[11px] text-text-tertiary mb-2">
                  팀을 최소 1개 선택해주세요. 태그한 팀·선수 피드에 이 투표가 노출돼요
                </p>
                {!hasTeamScope && (
                  <p className="text-xs text-[#FF453A] mb-2">
                    팀을 최소 1개 선택해주세요 (모든 팀에 공개하려면 10개 구단을 모두 선택).
                  </p>
                )}
                <TeamTagger
                  selectedSlugs={tagTeamSlugs}
                  onToggle={(slug) =>
                    setTagTeamSlugs((prev) =>
                      prev.includes(slug) ? prev.filter((s) => s !== slug) : [...prev, slug],
                    )
                  }
                />
              </div>
              <PlayerTagger
                game={null}
                selectedPlayers={taggedPlayers}
                onToggle={(player) =>
                  setTaggedPlayers((prev) =>
                    prev.some((p) => p.kboId === player.kboId)
                      ? prev.filter((p) => p.kboId !== player.kboId)
                      : [...prev, player],
                  )
                }
              />
            </div>

            {/* 복수선택 */}
            <label className="flex items-center justify-between py-1 cursor-pointer">
              <span className="text-sm text-text-primary">복수선택 허용</span>
              <button
                type="button"
                onClick={() => setAllowMultiple((v) => !v)}
                className={`relative w-11 h-6 rounded-full transition-colors ${allowMultiple ? "bg-accent" : "bg-bg-tertiary"}`}
                aria-pressed={allowMultiple}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${allowMultiple ? "translate-x-5" : ""}`}
                />
              </button>
            </label>

            {/* 마감시간 */}
            <div>
              <label className="block text-xs font-semibold text-text-tertiary mb-1.5">마감시간</label>
              <div className="flex flex-wrap gap-1.5 mb-2">
                {DURATION_PRESETS.map((p) => (
                  <button
                    key={p.minutes}
                    onClick={() => applyPreset(p.minutes)}
                    className="px-2.5 py-1 rounded-lg bg-bg-tertiary text-xs text-text-secondary active:scale-95 transition-transform"
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                type="datetime-local"
                value={closesAtLocal}
                min={minLocal}
                max={maxLocal}
                onChange={(e) => setClosesAtLocal(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-bg-tertiary text-text-primary outline-none"
              />
              <p className="text-[11px] text-text-tertiary mt-1">지금부터 10분 ~ 30일 사이</p>
            </div>

            {error && <p className="text-sm text-red-500">{error}</p>}
          </div>
        </motion.div>
      </motion.div>

      {/* 팀 선택 시트 (TeamTagger 재사용, 다중 토글) */}
      {teamSheetOpen && (
        <div className="fixed inset-0 z-[10001] flex items-end">
          <div className="absolute inset-0 bg-black/60" onClick={() => setTeamSheetOpen(false)} />
          <div className="relative w-full max-w-lg mx-auto bg-bg-secondary rounded-t-3xl p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-bold text-text-primary">팀 선지 선택</h3>
              <button onClick={() => setTeamSheetOpen(false)} className="text-sm font-semibold text-accent">완료</button>
            </div>
            <TeamTagger selectedSlugs={teamOptionSlugs} onToggle={toggleTeam} />
          </div>
        </div>
      )}

      {/* 선수 선택 시트 (PlayerPickerSheet 재사용). 컴포저(z-[10000])·팀 시트(z-[10001]) 위로 올린다. */}
      <PlayerPickerSheet
        open={playerSheetOpen}
        onClose={() => setPlayerSheetOpen(false)}
        players={[]}
        onSelect={addPlayer}
        overlayZClassName="z-[10002]"
        title="어느 선수를 추가할까요?"
      />
    </AnimatePresence>
      {allTeamsScopeDialog}
    </>
  );
}
