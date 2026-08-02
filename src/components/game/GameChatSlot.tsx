"use client";

import { Eye, LoaderCircle, RotateCcw } from "lucide-react";
import GameChat from "@/components/game/GameChat";
import { canRenderGameChat } from "@/lib/game-chat-visibility";
import { useGameChatVisibility } from "@/hooks/useGameChatVisibility";

interface GameChatSlotProps {
  gameId: string;
  homeTeamId: number;
  awayTeamId: number;
}

export default function GameChatSlot(props: GameChatSlotProps) {
  const { state, saving, setVisible, reload } = useGameChatVisibility();

  if (canRenderGameChat(state)) {
    return <GameChat {...props} onHide={() => void setVisible(false)} toggleDisabled={saving} />;
  }

  return (
    <div className="flex min-h-14 items-center justify-end border-b border-border px-4 py-2.5">
      {state.status === "loading" ? (
        <span className="flex items-center gap-1.5 text-xs text-text-tertiary" aria-live="polite">
          <LoaderCircle size={14} className="animate-spin" /> 채팅 설정 확인 중
        </span>
      ) : state.status === "error" ? (
        <button
          type="button"
          onClick={() => void reload()}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-text-secondary"
        >
          <RotateCcw size={14} /> 채팅 설정 다시 불러오기
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void setVisible(true)}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-lg border border-accent/50 px-3 py-1.5 text-xs font-medium text-accent disabled:opacity-50"
          aria-label="전체 채팅 켜기"
        >
          <Eye size={14} /> 채팅 켜기
        </button>
      )}
    </div>
  );
}
