"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import TeamSelectModal from "./TeamSelectModal";
import PlayerSelectModal from "./PlayerSelectModal";
import { getMyTeamId, setMyTeamId } from "@/lib/store/myteam";
import { getFavoritePlayers, setFavoritePlayers, type FavoritePlayer } from "@/lib/store/favorites";
import {
  getOnboardingStatus,
  setOnboardingStatus,
  getGuestId,
  type OnboardingStatus,
} from "@/lib/store/onboarding";
import { trackEvent, OnboardingEvents } from "@/lib/analytics";

interface OnboardingFlowProps {
  onComplete: (teamId: number, players: FavoritePlayer[]) => void;
}

export default function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const [step, setStep] = useState<"team" | "player" | "done">("done");
  const [teamId, setTeamId] = useState<number | null>(null);

  useEffect(() => {
    // guest_id 발급 (첫 방문 시)
    getGuestId();

    const status = getOnboardingStatus();
    const savedTeam = getMyTeamId();

    if (status === "completed" || status === "skipped") {
      // 이미 완료/스킵 → 홈 표시
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStep("done");
      return;
    }

    if (savedTeam && status === "team_selected") {
      // 팀 선택 후 이탈 → 선수 선택으로 복귀
      setTeamId(savedTeam);
      setStep("player");
      return;
    }

    // 처음 → 팀 선택
    setStep("team");
    trackEvent(OnboardingEvents.TEAM_SELECT_VIEW);
  }, []);

  function handleTeamSelect(selectedTeamId: number) {
    setMyTeamId(selectedTeamId);
    setTeamId(selectedTeamId);
    setOnboardingStatus("team_selected");
    trackEvent(OnboardingEvents.TEAM_SELECTED, { team_id: selectedTeamId });
    setStep("player");
  }

  function handlePlayerComplete(players: FavoritePlayer[]) {
    setFavoritePlayers(players);
    setOnboardingStatus("completed");
    trackEvent(OnboardingEvents.PLAYER_SELECTED, {
      player_count: players.length,
      player_ids: players.map((p) => p.playerId),
    });
    trackEvent(OnboardingEvents.ONBOARDING_COMPLETE, {
      team_id: teamId,
      player_count: players.length,
    });
    setStep("done");
    onComplete(teamId!, players);
  }

  function handlePlayerSkip() {
    setOnboardingStatus("skipped");
    trackEvent(OnboardingEvents.ONBOARDING_SKIPPED, {
      step: "player",
      team_id: teamId,
    });
    setStep("done");
    onComplete(teamId!, []);
  }

  if (step === "done") return null;

  return (
    <AnimatePresence mode="wait">
      {/* Progress indicator */}
      <motion.div
        key="progress"
        className="fixed top-0 left-0 right-0 z-[110] px-6 pt-[calc(env(safe-area-inset-top,0px)+12px)] pb-4"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
      >
        <div className="mx-auto max-w-lg flex gap-2">
          <div
            className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
              step === "team" || step === "player" ? "bg-accent" : "bg-bg-tertiary"
            }`}
          />
          <div
            className={`h-1 flex-1 rounded-full transition-colors duration-300 ${
              step === "player" ? "bg-accent" : "bg-bg-tertiary"
            }`}
          />
        </div>
      </motion.div>

      {step === "team" && (
        <TeamSelectModal
          key="team"
          isOpen={true}
          onSelect={handleTeamSelect}
        />
      )}

      {step === "player" && teamId && (
        <PlayerSelectModal
          key="player"
          isOpen={true}
          teamId={teamId}
          onComplete={handlePlayerComplete}
          onSkip={handlePlayerSkip}
        />
      )}
    </AnimatePresence>
  );
}
