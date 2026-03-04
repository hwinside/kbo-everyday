"use client";

import { useState } from "react";
import { Music, Play, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

interface CheerSongData {
  title: string;
  lyrics: string;
  youtubeUrl?: string;
  note?: string;
}

const CHEER_SONGS: Record<string, CheerSongData> = {};

interface Props {
  playerName: string;
  teamColor: string;
}

export default function CheerSong({ playerName, teamColor }: Props) {
  const song = CHEER_SONGS[playerName];
  const [showLyrics, setShowLyrics] = useState(true);

  if (!song) return null;

  return (
    <GlassCard className="p-4 mb-4">
      <button
        onClick={() => setShowLyrics(!showLyrics)}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: teamColor + "20" }}>
            <Music size={16} style={{ color: teamColor }} />
          </div>
          <div className="text-left">
            <h3 className="text-sm font-bold text-text-primary">{song.title}</h3>
            {song.note && <p className="text-xs text-text-tertiary">{song.note}</p>}
          </div>
        </div>
        {showLyrics ? <ChevronUp size={18} className="text-text-tertiary" /> : <ChevronDown size={18} className="text-text-tertiary" />}
      </button>

      {showLyrics && (
        <div className="mt-3 space-y-3">
          {/* 가사 */}
          <div className="bg-bg-tertiary rounded-xl p-4">
            <p className="text-sm text-text-primary whitespace-pre-line leading-relaxed text-center font-medium">
              {song.lyrics}
            </p>
          </div>

          {/* YouTube 링크 */}
          {song.youtubeUrl && (
            <a
              href={song.youtubeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white transition-all active:scale-95"
              style={{ backgroundColor: teamColor }}
            >
              <Play size={16} fill="white" />
              응원가 검색하기
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      )}
    </GlassCard>
  );
}
