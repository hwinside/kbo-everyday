"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";
import { isAllStarGame } from "@/lib/constants/teams";
import { allStarSideOfTeam } from "@/lib/constants/allstar-2026";

/**
 * 팬 분위기 게이지 — 하이브리드 방식
 *
 * Primary: 최근 10분 채팅 메시지의 team_id 비율
 * Fallback: Supabase Realtime Presence 접속자 team_id 비율
 * 블렌딩: 채팅 수가 늘수록 fallback 가중치 감소
 *
 * @returns homePct (0~100, home 팀 비율)
 */
export function useMoodGauge(
  gameId: string,
  homeTeamId: number,
  awayTeamId: number,
) {
  const { profile } = useAuth();
  const [homePct, setHomePct] = useState(50);
  const [chatCount, setChatCount] = useState(0);
  const presenceRef = useRef<{ home: number; away: number }>({ home: 0, away: 0 });
  const chatRef = useRef<{ home: number; away: number }>({ home: 0, away: 0 });

  // 올스타전: 유저 team_id(정규 10구단)가 나눔/드림(101/102)과 직접 매칭이 안 돼
  // 게이지가 50:50 고정 → 소속 구단→올스타 사이드 매핑으로 판정. *팬 분위기 계산
  // 전용* — 유저 team_id/팬방/알림 로직은 불변 (2026-07-11 하린아빠·삼순 GO).
  const isAllStar = isAllStarGame(awayTeamId, homeTeamId);
  const effectiveTeamId = useCallback(
    (tid: number | null | undefined) => (isAllStar ? allStarSideOfTeam(tid) : tid),
    [isAllStar],
  );

  // ── 1) Presence: 접속자 팀 비율 (fallback) ──
  useEffect(() => {
    const channelName = `mood:${gameId}`;
    const teamId = profile?.team_id ?? null;

    const channel = supabase.channel(channelName, {
      config: { presence: { key: "viewers" } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<{ team_id: number | null }>();
        let home = 0;
        let away = 0;

        // state is Record<string, PresenceState[]>
        for (const key of Object.keys(state)) {
          for (const p of state[key]) {
            const tid = effectiveTeamId(p.team_id);
            if (tid === homeTeamId) home++;
            else if (tid === awayTeamId) away++;
          }
        }

        presenceRef.current = { home, away };
        recalc();
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED" && teamId) {
          await channel.track({ team_id: teamId });
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, homeTeamId, awayTeamId, profile?.team_id]);

  // ── 2) 최근 10분 채팅 메시지 team_id 집계 (primary) ──
  const fetchChatMood = useCallback(async () => {
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    // query-guard: bounded -- 분위기 비율은 최근 채팅 500건 표본이면 충분함
    const { data } = await supabase
      .from("chat_messages")
      .select("user_id, profiles!user_id(team_id)")
      .eq("room_id", `game:${gameId}`)
      .gte("created_at", tenMinAgo)
      .order("created_at", { ascending: false })
      .limit(500);

    let home = 0;
    let away = 0;

    if (data) {
      for (const row of data as Array<{ user_id: string; profiles?: { team_id?: number } }>) {
        const tid = effectiveTeamId(row.profiles?.team_id);
        if (tid === homeTeamId) home++;
        else if (tid === awayTeamId) away++;
      }
    }

    chatRef.current = { home, away };
    setChatCount(home + away);
    recalc();
  }, [gameId, homeTeamId, awayTeamId, effectiveTeamId]);

  // 초기 로드 + 30초 폴링
  useEffect(() => {
    fetchChatMood();
    const interval = setInterval(fetchChatMood, 30_000);
    return () => clearInterval(interval);
  }, [fetchChatMood]);

  // ── 3) 블렌딩 ──
  // eslint-disable-next-line react-hooks/exhaustive-deps
  function recalc() {
    const chat = chatRef.current;
    const pres = presenceRef.current;

    const chatTotal = chat.home + chat.away;
    const presTotal = pres.home + pres.away;

    // 아무 데이터도 없으면 50:50
    if (chatTotal === 0 && presTotal === 0) {
      setHomePct(50);
      return;
    }

    // 채팅 비율
    const chatHomePct = chatTotal > 0 ? chat.home / chatTotal : 0.5;
    // Presence 비율
    const presHomePct = presTotal > 0 ? pres.home / presTotal : 0.5;

    // 채팅 가중치: 메시지 수에 따라 0→1 (20개 이상이면 거의 1)
    // sigmoid-ish: w = min(chatTotal / 20, 1)
    const chatWeight = Math.min(chatTotal / 20, 1);

    // 블렌딩
    const blended = chatHomePct * chatWeight + presHomePct * (1 - chatWeight);
    const pct = Math.round(blended * 100);

    // 극단 방지: 최소 5%, 최대 95%
    setHomePct(Math.max(5, Math.min(95, pct)));
  }

  return { homePct, chatCount };
}
