"use client";

import { useState, useEffect, useLayoutEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { motion } from "framer-motion";
import GlassCard from "@/components/ui/GlassCard";
import TeamBadge from "@/components/ui/TeamBadge";
import { TEAMS, getTeamById } from "@/lib/constants/teams";
import { getMyTeamId } from "@/lib/store/myteam";

const container = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };
const item = { hidden: { opacity: 0, y: 12 }, show: { opacity: 1, y: 0 } };

export default function CommunityTeamsPage() {
  const router = useRouter();
  const [myTeamId, setMyTeamId] = useState<number | null>(null);
  const [redirecting, setRedirecting] = useState(false);

  // 가능한 한 "paint" 전에 리다이렉트해서 팀 선택 화면이 깜빡이는 느낌을 줄임
  useLayoutEffect(() => {
    const pick =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("pick");
    const id = getMyTeamId();
    setMyTeamId(id);

    // myTeam 설정 시 바로 해당 팀 게시판으로 (pick=true면 팀 선택 모드이므로 건너뜀)
    if (id && !pick) {
      const team = getTeamById(id);
      if (team) {
        setRedirecting(true);
        router.replace(`/community/teams/${team.slug}`);
      }
    }
  }, [router]);

  // hydration 이후에도 myTeamId는 계속 세팅해둠 (다른 UI에서 필요)
  useEffect(() => {
    if (myTeamId !== null) return;
    const id = getMyTeamId();
    setMyTeamId(id);
  }, [myTeamId]);

  const myTeam = myTeamId ? getTeamById(myTeamId) : null;

  if (redirecting) {
    return (
      <div className="mx-auto max-w-lg px-5 pb-24">
        <div className="mt-8 text-sm text-text-tertiary">내 팀 게시판으로 이동 중…</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-lg px-5 pb-24">
      {/* 내 팀 */}
      {myTeam && (
        <div className="mt-4 mb-6">
          <h2 className="mb-3 text-base font-bold text-text-primary">내 팀</h2>
          <Link href={`/community/teams/${myTeam.slug}`}>
            <GlassCard
              pressable
              className="overflow-hidden p-5"
              style={{
                background: `linear-gradient(135deg, ${myTeam.colorPrimary}40 0%, ${myTeam.colorPrimary}10 100%)`,
              }}
            >
              <div className="flex items-center gap-4">
                <TeamBadge teamId={myTeam.id} size="lg" />
                <div className="flex-1">
                  <p className="text-base font-bold text-text-primary">{myTeam.name}</p>
                  <p className="text-sm text-text-secondary">팀 게시판 바로가기</p>
                </div>
              </div>
            </GlassCard>
          </Link>
        </div>
      )}

      {/* 전체 구단 */}
      <div className="mt-4 mb-6">
        <h2 className="mb-3 text-base font-bold text-text-primary">전체 구단</h2>
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid grid-cols-5 gap-3"
        >
          {TEAMS.map((team) => (
            <motion.div key={team.id} variants={item}>
              <Link href={`/community/teams/${team.slug}`}>
                <div className="flex flex-col items-center gap-1.5 rounded-xl py-3 transition-colors hover:bg-bg-secondary">
                  <div className="flex h-11 w-11 items-center justify-center rounded-full bg-white p-1">
                    <Image
                      src={team.logoPath}
                      alt={team.name}
                      width={28}
                      height={28}
                      unoptimized
                      className="object-contain"
                    />
                  </div>
                  <span
                    className="text-xs font-semibold"
                    style={{ color: team.colorLight }}
                  >
                    {team.shortName}
                  </span>
                </div>
              </Link>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </div>
  );
}
