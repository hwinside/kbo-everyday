"use client";

import { useEffect, useMemo, useRef, type ReactNode } from "react";
import CommentSheet, { type CommentSheetSource } from "@/components/community/CommentSheet";
import type { Comment } from "@/lib/supabase/usePosts";
import { COMMENT_LIMIT, validateText } from "@/lib/game-reviews/domain";

type CommentRow = {
  id: number; author_id: string; nickname: string; content: string;
  created_at: string; edited_at?: string | null; team_id: number | null; avatar_url?: string | null;
};
type CommentResponse = { viewerId: string | null; feed?: { review?: { id: number }; rows: CommentRow[]; next: number | null } };

/** Only the data adapter differs: the community sheet owns layout/keyboard/menu UX. */
export default function GameReviewCommentSheet({ gameId, reviewId, viewerId, teamId, request, onClose, onChanged, onReport, context, onNavigate }: {
  context?: ReactNode; onNavigate: () => void;
  gameId: string; reviewId: number; viewerId: string | null; teamId: number | null;
  request: (path: string, body?: unknown) => Promise<unknown>;
  onClose: () => void; onChanged: () => void; onReport: (id: number) => void;
}) {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const callbacks = useRef({ onChanged, onReport });
  useEffect(() => { callbacks.current = { onChanged, onReport }; }, [onChanged, onReport]);
  const source = useMemo<CommentSheetSource>(() => {
    const endpoint = `/api/games/${gameId}/reviews`;
    const mutate = async (op: string, extra: Record<string, unknown>) => {
      await request(endpoint, { op, reviewId, ...extra });
      if (mounted.current) callbacks.current.onChanged();
    };
    return {
      load: async before => {
        const result = await request(`${endpoint}?review=${reviewId}${before ? `&before=${before}` : ""}`) as CommentResponse;
        if (result.viewerId !== viewerId || result.feed?.review?.id !== reviewId) throw new Error("현재 댓글을 볼 수 없어요");
        return { rows: result.feed.rows.map((row): Comment => ({
          ...row, post_id: reviewId, parent_id: null, updated_at: row.edited_at,
          team_id: row.team_id ?? undefined, avatar_url: row.avatar_url ?? undefined,
        })), next: result.feed.next };
      },
      create: content => mutate("comment", { content }),
      update: (commentId, content) => mutate("comment_edit", { commentId, content }),
      remove: commentId => mutate("comment_delete", { commentId }),
      report: id => callbacks.current.onReport(id),
      validate: content => { validateText(content, COMMENT_LIMIT); },
    };
  }, [gameId, reviewId, viewerId, request]);
  return <CommentSheet isOpen postId={reviewId} teamId={teamId} source={source} context={context} onClose={onClose} onNavigate={onNavigate} />;
}
