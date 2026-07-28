"use client";

import { MoreHorizontal, Flag, Ban } from "lucide-react";

/**
 * 게시글 ⋯ 액션 메뉴 (수정/신고/차단/삭제) — 소유권 게이트 presentational 컴포넌트.
 *
 * 삼순 4차 NO-GO(P1-2): 메뉴 owner/other 노출을 source-regex 대신 실제 DOM 렌더로 검증하기
 * 위해 PostDetail 인라인 드롭다운을 그대로 추출한다(마크업·클래스·게이트 로직 동일).
 *   - isOwner  → '수정'(작성자 전용), '삭제'(작성자 또는 운영자)
 *   - !isOwner → '신고'·'차단'
 * 실제 강제(작성자 200 / 타인 403)는 서버 PATCH route + DB 트리거가 SSOT. 이 메뉴는 UX 게이트.
 */
export interface PostActionsMenuProps {
  isOwner: boolean;
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
  isOwner,
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
