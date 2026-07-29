"use client";

import { MoreHorizontal, Flag, Ban } from "lucide-react";
import { canEditOwnPost } from "@/lib/community/post-permissions";

/**
 * 게시글 ⋯ 액션 메뉴 (수정/신고/차단/삭제) — 노출 게이트 + 소유권 계산까지 포함한 유닛.
 *
 * 삼순 4·5차 NO-GO(P1-2): 메뉴 노출을 source-regex나 standalone 렌더가 아니라 실제 DOM 렌더로
 * 검증하되, PostDetail이 걸던 노출 게이트(`user && !postEditing`)와 소유권 계산
 * (`canEditOwnPost`)을 이 컴포넌트 *안으로* 흡수해, 게이트/소유권 배선을 깨는 fault-injection이
 * 반드시 렌더 결과를 바꾸게 한다(PostDetail은 raw user/postEditing/authorId/userId만 전달).
 *   - 비로그인(user 없음)·편집 중(postEditing) → 아무것도 렌더하지 않음(null).
 *   - isOwner(=canEditOwnPost(authorId, userId)) → '수정'(작성자), '삭제'(작성자 또는 운영자).
 *   - !isOwner → '신고'·'차단'.
 * 실제 강제(작성자 200 / 타인 403)는 서버 PATCH route + DB 트리거가 SSOT. 이 메뉴는 UX 게이트.
 */
export interface PostActionsMenuProps {
  /** 로그인 유저(없으면 메뉴 자체 미노출). PostDetail의 useAuth().user 를 그대로 전달. */
  user: { id: string } | null | undefined;
  /** 게시글 편집 중이면 메뉴 미노출(편집 UI로 대체). */
  postEditing: boolean;
  /** 글 작성자 id. */
  authorId: string | null | undefined;
  /** 현재 로그인 유저 id(소유권 판정용). */
  userId: string | null | undefined;
  canDeleteAny: boolean;
  open: boolean;
  disabled?: boolean;
  onToggle: () => void;
  onClose: () => void;
  onEdit: () => void;
  onReport: () => void;
  onBlock: () => void;
  onDelete: () => void;
}

export default function PostActionsMenu({
  user,
  postEditing,
  authorId,
  userId,
  canDeleteAny,
  open,
  disabled,
  onToggle,
  onClose,
  onEdit,
  onReport,
  onBlock,
  onDelete,
}: PostActionsMenuProps) {
  // 노출 게이트: 비로그인 또는 편집 중이면 메뉴 자체를 렌더하지 않는다(PostDetail 인라인 게이트 흡수).
  if (!user || postEditing) return null;
  const isOwner = canEditOwnPost(authorId, userId);
  return (
    <div className="relative">
      <button
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
        className="p-1 text-text-tertiary hover:text-text-primary"
        aria-label="게시글 메뉴"
        disabled={disabled}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={onClose} />
          <div className="absolute right-0 top-8 z-20 min-w-[112px] rounded-lg border border-border bg-bg-primary shadow-lg overflow-hidden">
            {isOwner && (
              <button
                onClick={onEdit}
                className="block w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary"
              >
                수정
              </button>
            )}
            {!isOwner && (
              <button
                onClick={onReport}
                className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary"
              >
                <Flag size={14} /> 신고
              </button>
            )}
            {!isOwner && (
              <button
                onClick={onBlock}
                className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm text-text-primary hover:bg-bg-tertiary"
              >
                <Ban size={14} /> 차단
              </button>
            )}
            {(isOwner || canDeleteAny) && (
              <button
                onClick={onDelete}
                className="block w-full px-3 py-2 text-left text-sm text-[#FF453A] hover:bg-bg-tertiary"
              >
                삭제
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
