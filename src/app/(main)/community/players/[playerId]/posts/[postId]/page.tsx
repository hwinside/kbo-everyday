"use client";

import { useParams } from "next/navigation";
import PostDetail from "@/components/community/PostDetail";
import PLAYERS_ROSTER from "@/lib/constants/players-roster.json";
import { PLAYER_PHOTO_MAP } from "@/lib/constants/player-photos";
import { FOREIGN_NUMERIC_TO_ALPHA } from "@/lib/constants/foreign-id-map";

const LEGACY_MAP: Record<string, string> = {
  p1: "67430", p2: "77162", p3: "62404", p4: "69650", p5: "68571",
  p6: "64643", p7: "63905", p8: "61478", p9: "75003", p10: "67100",
  p11: "55500", p12: "68300", p13: "69200", p14: "67800", p15: "65400",
};

const ID_TO_NAME: Record<string, string> = {};
for (const p of PLAYERS_ROSTER) {
  ID_TO_NAME[p.kboId] = p.name;
}
for (const [name, id] of Object.entries(PLAYER_PHOTO_MAP)) {
  if (!ID_TO_NAME[id]) ID_TO_NAME[id] = name;
}

export default function PlayerPostDetailPage() {
  const { playerId, postId } = useParams();
  const rawId = playerId as string;
  const rosterDirect = PLAYERS_ROSTER.some((p) => p.kboId === rawId);
  const kboId = rosterDirect
    ? rawId
    : LEGACY_MAP[rawId] || FOREIGN_NUMERIC_TO_ALPHA[rawId] || rawId;
  const playerName = ID_TO_NAME[kboId];
  const headerTitle = playerName ? `${playerName} 선수 게시판` : "선수 게시판";

  return <PostDetail postId={Number(postId)} headerTitle={headerTitle} />;
}
