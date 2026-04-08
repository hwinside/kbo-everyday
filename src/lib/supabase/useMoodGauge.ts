"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { supabase } from "./client";
import { useAuth } from "./AuthContext";

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
            if (p.team_id === homeTeamId) home++;
            else if (p.team_id === awayTeamId) away++;
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
    // 전체 + 홈팬방 + 어웨이팬방 모두 집계
    const roomIds = [
      `game:${gameId}`,
      `game:${gameId}:home`,
      `game:${gameId}:away`,
    ];

    const { data } = await supabase
      .from("chat_messages")
      .select("user_id, profiles(team_id)")
      .in("room_id", roomIds)
      .gte("created_at", tenMinAgo);

    let home = 0;
    let away = 0;

    if (data) {
      for (const row of data as Array<{ user_id: string; profiles?: { team_id?: number } }>) {
        const tid = row.profiles?.team_id;
        if (tid === homeTeamId) home++;
        else if (tid === awayTeamId) away++;
      }
    }

    chatRef.current = { home, away };
    setChatCount(home + away);
    recalc();
  }, [gameId, homeTeamId, awayTeamId]);

  // 초기 로드 + 30초 폴링
  useEffect(() => {
    fetchChatMood();
    const interval = setInterval(fetchChatMood, 30_000);
    return () => clearInterval(interval);
  }, [fetchChatMood]);

  // Realtime INSERT 시에도 갱신 (전체 + 팬방)
  useEffect(() => {
    const channel = supabase
      .channel(`mood-chat:${gameId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "chat_messages",
          filter: `room_id=like.game:${gameId}%`,
        },
        () => {
          fetchChatMood();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [gameId, fetchChatMood]);

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
