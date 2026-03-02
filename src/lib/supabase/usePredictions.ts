"use client";

import { useState, useEffect, useCallback } from "react";
import { supabase } from "./client";

interface PredictionStat {
  category: string;
  pick: string;
  vote_count: number;
}

export function usePredictions(userId?: string) {
  const [myPredictions, setMyPredictions] = useState<Record<string, string>>({});
  const [communityVotes, setCommunityVotes] = useState<Record<string, Record<string, number>>>({});
  const [loading, setLoading] = useState(true);

  // 로드
  useEffect(() => {
    async function load() {
      // 내 예측
      if (userId) {
        const { data } = await supabase
          .from("season_predictions")
          .select("category, pick")
          .eq("user_id", userId)
          .eq("season", 2026);
        if (data) {
          const map: Record<string, string> = {};
          data.forEach(d => { map[d.category] = d.pick; });
          setMyPredictions(map);
        }
      }

      // 커뮤니티 집계
      const { data: stats } = await supabase
        .from("prediction_stats")
        .select("*");
      if (stats) {
        const grouped: Record<string, Record<string, number>> = {};
        (stats as PredictionStat[]).forEach(s => {
          if (!grouped[s.category]) grouped[s.category] = {};
          grouped[s.category][s.pick] = s.vote_count;
        });
        setCommunityVotes(grouped);
      }

      setLoading(false);
    }
    load();
  }, [userId]);

  // 예측 저장 (upsert)
  const savePrediction = useCallback(async (category: string, pick: string) => {
    if (!userId) return false;
    const { error } = await supabase
      .from("season_predictions")
      .upsert({
        user_id: userId,
        season: 2026,
        category,
        pick,
      }, { onConflict: "user_id,season,category" });

    if (!error) {
      setMyPredictions(prev => ({ ...prev, [category]: pick }));
      return true;
    }
    return false;
  }, [userId]);

  return { myPredictions, communityVotes, loading, savePrediction };
}
