"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { takeBootGameChatVisible, invalidateBootCache } from "@/lib/boot-cache";
import type { GameChatVisibilityState } from "@/lib/game-chat-visibility";

const GUEST_STORAGE_KEY = "kbo-game-chat-visible:guest";
export const GAME_CHAT_VISIBILITY_EVENT = "game-chat-visibility-changed";

function readGuestPreference(): boolean {
  if (typeof window === "undefined") return true;
  return localStorage.getItem(GUEST_STORAGE_KEY) !== "0";
}

export function useGameChatVisibility() {
  const { user, loading: authLoading } = useAuth();
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

    setState({ status: "loading", visible: false });

    // PR④: 부트 번들 캠시 1회 소비(60s TTL·userId 결속) — 부트 직후 첫 마운트만 커버,
    // 이후 마운트/reload 는 종전 fetch 그대로(타기기 변경 반영 계약 보존).
    const bootVisible = takeBootGameChatVisible(user.id);
    if (typeof bootVisible === "boolean") {
      if (generation !== requestGeneration.current) return;
      setState({ status: "ready", visible: bootVisible });
      return;
    }

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
  }, [authLoading, user]);

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
      invalidateBootCache(); // PR④: 토글 성공 → 부트 창 내 stale 재사용 방지
    } catch {
      setState({ status: "ready", visible: previous });
    } finally {
      setSaving(false);
    }
  }, [saving, state, user]);

  return { state, saving, setVisible, reload: load };
}
