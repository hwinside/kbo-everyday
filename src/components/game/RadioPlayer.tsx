"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { Volume2, VolumeX, Play, Pause, Radio } from "lucide-react";

const CHANNELS = [
  { id: "mbc", name: "MBC 스포츠" },
  { id: "sbs", name: "SBS 스포츠" },
];

export default function RadioPlayer() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(70);
  const [channelIndex, setChannelIndex] = useState(0);

  const channel = CHANNELS[channelIndex];

  return (
    <div className="flex items-center gap-4 px-4 py-3 rounded-xl bg-bg-glass border border-border backdrop-blur-xl">
      <Radio className="w-10 h-10 text-accent shrink-0" />

      {/* Channel name — tap to switch */}
      <button
        onClick={() => setChannelIndex((i) => (i + 1) % CHANNELS.length)}
        className="text-base font-medium text-text-primary whitespace-nowrap"
      >
        {channel.name}
      </button>

      {/* Play/Pause */}
      <motion.button
        whileTap={{ scale: 0.9 }}
        onClick={() => setIsPlaying(!isPlaying)}
        className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center shrink-0"
      >
        {isPlaying ? (
          <Pause className="w-5 h-5 text-accent" />
        ) : (
          <Play className="w-5 h-5 text-accent ml-0.5" />
        )}
      </motion.button>

      {/* Volume slider */}
      <div className="flex items-center gap-4 flex-1 min-w-0">
        <button
          onClick={() => setVolume(volume === 0 ? 70 : 0)}
          className="shrink-0"
        >
          {volume === 0 ? (
            <VolumeX className="w-5 h-5 text-text-tertiary" />
          ) : (
            <Volume2 className="w-5 h-5 text-text-secondary" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          className="w-full h-1 rounded-full appearance-none bg-bg-tertiary cursor-pointer
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:w-3
            [&::-webkit-slider-thumb]:h-3
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-text-primary
            [&::-webkit-slider-thumb]:shadow-sm"
        />
      </div>
    </div>
  );
}
