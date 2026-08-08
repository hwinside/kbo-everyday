"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import PostCard from "./PostCard";
import type { Post } from "@/lib/types";
import { fetchPollSummaries, type PollSummary } from "@/lib/community/poll-client";

interface PostListProps {
  posts: Post[];
  /** 선수 게시판: post별 playerLabel 맵 (postId → {teamId, playerName}) */
  playerLabels?: Record<number, { teamId: number; playerName: string }>;
}

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.03 } },
};

const item = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

export default function PostList({ posts, playerLabels }: PostListProps) {
  const router = useRouter();

  // 목록의 poll 글만 모아 요약을 배치 조회(배지·참여수·선지 미리보기). poll 이 없으면 no-op.
  const pollIds = useMemo(
    () => posts.filter((p) => p.boardType === "poll").map((p) => p.id),
    [posts],
  );
  const [pollSummaries, setPollSummaries] = useState<Record<number, PollSummary>>({});
  const [pollResolved, setPollResolved] = useState<Set<number>>(new Set()); // 응답 받은 poll id(없으면 terminal)
  const [pollRetry, setPollRetry] = useState(0);
  const pollIdsKey = pollIds.join(",");
  useEffect(() => {
    if (pollIds.length === 0) return; // 남은 요약은 메모리에만 잔존(poll 아닌 글은 조회 안 함)
    let alive = true;
    fetchPollSummaries(pollIds)
      .then((s) => {
        if (!alive) return;
        setPollSummaries((prev) => ({ ...prev, ...s })); // 부분 결과도 누적 merge(실패 chunk 카드만 terminal)
        setPollResolved((prev) => new Set([...prev, ...pollIds])); // 응답 받은 id 는 resolved
      })
      .catch(() => {}); // fetchPollSummaries 는 chunk별 격리로 reject 안 하지만 방어적 catch
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pollIdsKey 로 목록 변경만 감지(pollIds 배열 참조 안정화)
  }, [pollIdsKey, pollRetry]);

  // terminal 카드 재시도: 해당 id 를 로딩으로 되돌리고 배치 재조회 트리거.
  const retryPoll = useCallback((postId: number) => {
    setPollResolved((prev) => {
      const n = new Set(prev);
      n.delete(postId);
      return n;
    });
    setPollRetry((n) => n + 1);
  }, []);

  if (posts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-text-tertiary">
        <p className="text-base">아직 글이 없습니다</p>
        <p className="mt-1 text-base">첫 번째 글을 작성해보세요!</p>
      </div>
    );
  }

  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="space-y-3"
    >
      {posts.map((post) => (
        <motion.div key={post.id} variants={item}>
          <PostCard
            post={post}
            playerLabel={playerLabels?.[post.id] ?? null}
            pollSummary={post.boardType === "poll" ? pollSummaries[post.id] ?? null : null}
            pollLoaded={post.boardType === "poll" ? pollResolved.has(post.id) : false}
            onPollRetry={() => retryPoll(post.id)}
            onPress={() => {
              if (post.boardType === "player") {
                router.push(`/community/players/${post.boardId}/posts/${post.id}`);
              } else if (post.boardType === "team") {
                router.push(`/community/teams/${post.boardId}/posts/${post.id}`);
              } else {
                router.push(`/community/free/${post.id}`);
              }
            }}
          />
        </motion.div>
      ))}
    </motion.div>
  );
}
