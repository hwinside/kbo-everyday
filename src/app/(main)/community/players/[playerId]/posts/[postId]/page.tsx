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

type PlayerInfo = { name: string; team?: string };
const ID_TO_INFO: Record<string, PlayerInfo> = {};
for (const p of PLAYERS_ROSTER) {
  ID_TO_INFO[p.kboId] = { name: p.name, team: (p as { team?: string }).team };
}
for (const [name, id] of Object.entries(PLAYER_PHOTO_MAP)) {
  if (!ID_TO_INFO[id]) ID_TO_INFO[id] = { name };
}

export default function PlayerPostDetailPage() {
  const { playerId, postId } = useParams();
  const rawId = playerId as string;
  const rosterDirect = PLAYERS_ROSTER.some((p) => p.kboId === rawId);
  const kboId = rosterDirect
    ? rawId
    : LEGACY_MAP[rawId] || FOREIGN_NUMERIC_TO_ALPHA[rawId] || rawId;
  const info = ID_TO_INFO[kboId];
  const headerTitle = info
    ? info.team
      ? `${info.team} ${info.name} 선수 게시판`
      : `${info.name} 선수 게시판`
    : "선수 게시판";

  return <PostDetail postId={Number(postId)} headerTitle={headerTitle} />;
}
