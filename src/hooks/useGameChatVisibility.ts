"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import type { GameChatVisibilityState } from "@/lib/game-chat-visibility";

const GUEST_STORAGE_KEY = "kbo-game-chat-visible:guest";
export const GAME_CHAT_VISIBILITY_EVENT = "game-chat-visibility-changed";

function readGuestPreference(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(GUEST_STORAGE_KEY) !== "0";
}

export function useGameChatVisibility() {
  const { user, profile, loading: authLoading, refreshProfile } = useAuth();
  const [state, setState] = useState<GameChatVisibilityState>({ status: "loading", visible: false });
  const [saving, setSaving] = useState(false);
  const requestGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    if (authLoading) {
      setState({ status: "loading", visible: false });
      return;
    }

    if (!user) {
      setState({ status: "ready", visible: readGuestPreference() });
      return;
    }

    // PR④: game_chat_enabled 는 profiles 컴럼이라 AuthContext profile 에서 파생 —
    // 부트·늦은 경기방 진입 모두 추가 fetch 0. 신선도는 profile ledger 계약을 따른다
    // (TTL 10분 + visibility 복귀 재동기화; 종전은 마운트마다 fetch = 타기기 변경 즉시 반영).
    // 토글(PUT) 성공 시 refreshProfile 로 컨텍스트 재동기화해 stale 재파생 차단.
    if (profile && profile.id === user.id) {
      if (generation !== requestGeneration.current) return;
      setState({ status: "ready", visible: profile.game_chat_enabled !== false });
      return;
    }

    setState({ status: "loading", visible: false });

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("missing session");
      const res = await fetch("/api/game-chat/prefs", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error("preference load failed");
      const data = await res.json() as { visible?: unknown };
      if (generation !== requestGeneration.current) return;
      setState({ status: "ready", visible: data.visible !== false });
    } catch {
      if (generation === requestGeneration.current) {
        // 계정 설정을 확인하지 못했으면 채팅과 focus target을 노출하지 않는다.
        setState({ status: "error", visible: false });
      }
    }
  }, [authLoading, user, profile]);

  useEffect(() => {
    void load();
    return () => { requestGeneration.current += 1; };
  }, [load]);

  useEffect(() => {
    if (user || authLoading) return;
    const sync = () => setState({ status: "ready", visible: readGuestPreference() });
    window.addEventListener("storage", sync);
    window.addEventListener(GAME_CHAT_VISIBILITY_EVENT, sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener(GAME_CHAT_VISIBILITY_EVENT, sync);
    };
  }, [authLoading, user]);

  const setVisible = useCallback(async (visible: boolean) => {
    if (saving || state.status !== "ready") return;
    const previous = state.visible;
    setState({ status: "ready", visible });

    if (!user) {
      localStorage.setItem(GUEST_STORAGE_KEY, visible ? "1" : "0");
      window.dispatchEvent(new Event(GAME_CHAT_VISIBILITY_EVENT));
      return;
    }

    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error("missing session");
      const res = await fetch("/api/game-chat/prefs", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ visible }),
      });
      if (!res.ok) throw new Error("preference save failed");
      // PR④: 컨텍스트 profile 재동기화 — 다음 마운트가 stale game_chat_enabled 를 파생하지 않게
      void refreshProfile();
    } catch {
      setState({ status: "ready", visible: previous });
    } finally {
      setSaving(false);
    }
  }, [saving, state, user]);

  return { state, saving, setVisible, reload: load };
}
