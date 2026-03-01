"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Check, Star } from "lucide-react";
import Image from "next/image";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { getTeamById, TEAMS } from "@/lib/constants/teams";
import { type FavoritePlayer } from "@/lib/store/favorites";

// 팀별 주요 선수 목록
const TEAM_PLAYERS: Record<number, { id: string; name: string; number: number; position: string }[]> = {
  1: [ // LG
    { id: "p1", name: "오스틴", number: 31, position: "외야수" },
    { id: "p7", name: "박동원", number: 27, position: "포수" },
    { id: "p16", name: "임찬규", number: 29, position: "투수" },
    { id: "p17", name: "김현수", number: 22, position: "외야수" },
    { id: "p18", name: "홍창기", number: 51, position: "외야수" },
    { id: "p19", name: "문보경", number: 52, position: "내야수" },
  ],
  2: [ // 두산
    { id: "p10", name: "김하성", number: 7, position: "내야수" },
    { id: "p15", name: "이의리", number: 17, position: "투수" },
    { id: "p20", name: "양의지", number: 25, position: "포수" },
    { id: "p21", name: "호잉", number: 33, position: "외야수" },
    { id: "p22", name: "배정대", number: 61, position: "내야수" },
  ],
  3: [ // KT
    { id: "p8", name: "나성범", number: 47, position: "외야수" },
    { id: "p23", name: "소형준", number: 11, position: "투수" },
    { id: "p24", name: "안현민", number: 6, position: "내야수" },
    { id: "p25", name: "강백호", number: 50, position: "내야수" },
    { id: "p26", name: "쿠에바스", number: 49, position: "투수" },
  ],
  4: [ // SSG
    { id: "p11", name: "페르난데스", number: 37, position: "투수" },
    { id: "p27", name: "김재환", number: 32, position: "내야수" },
    { id: "p28", name: "최정", number: 14, position: "내야수" },
    { id: "p29", name: "추신수", number: 17, position: "외야수" },
    { id: "p30", name: "문승원", number: 21, position: "투수" },
  ],
  5: [ // NC
    { id: "p12", name: "소형준", number: 11, position: "투수" },
    { id: "p31", name: "박건우", number: 7, position: "외야수" },
    { id: "p32", name: "권희동", number: 23, position: "외야수" },
    { id: "p33", name: "디아즈", number: 8, position: "내야수" },
    { id: "p34", name: "손아섭", number: 37, position: "외야수" },
  ],
  6: [ // KIA
    { id: "p4", name: "김도영", number: 5, position: "내야수" },
    { id: "p2", name: "양현종", number: 1, position: "투수" },
    { id: "p9", name: "최형우", number: 34, position: "지명타자" },
    { id: "p14", name: "안우진", number: 26, position: "투수" },
    { id: "p35", name: "나성범", number: 47, position: "외야수" },
  ],
  7: [ // 롯데
    { id: "p13", name: "한석현", number: 18, position: "외야수" },
    { id: "p36", name: "레이예스", number: 53, position: "외야수" },
    { id: "p37", name: "윤성빈", number: 17, position: "투수" },
    { id: "p38", name: "전준우", number: 27, position: "외야수" },
    { id: "p39", name: "안치홍", number: 13, position: "내야수" },
  ],
  8: [ // 삼성
    { id: "p3", name: "구자욱", number: 10, position: "외야수" },
    { id: "p40", name: "김성윤", number: 31, position: "외야수" },
    { id: "p41", name: "오재일", number: 30, position: "내야수" },
    { id: "p42", name: "강민호", number: 65, position: "포수" },
    { id: "p43", name: "원태인", number: 20, position: "투수" },
  ],
  9: [ // 한화
    { id: "p5", name: "문동주", number: 29, position: "투수" },
    { id: "p44", name: "문현빈", number: 8, position: "내야수" },
    { id: "p45", name: "노시환", number: 52, position: "내야수" },
    { id: "p46", name: "폰세", number: 43, position: "투수" },
    { id: "p47", name: "채은성", number: 37, position: "내야수" },
  ],
  10: [ // 키움
    { id: "p6", name: "이정후", number: 51, position: "외야수" },
    { id: "p48", name: "김혜성", number: 3, position: "내야수" },
    { id: "p49", name: "서건창", number: 7, position: "내야수" },
    { id: "p50", name: "이용찬", number: 18, position: "투수" },
    { id: "p51", name: "송성문", number: 8, position: "내야수" },
  ],
};

interface PlayerSelectModalProps {
  isOpen: boolean;
  teamId: number;
  onComplete: (players: FavoritePlayer[]) => void;
  onSkip: () => void;
}

export default function PlayerSelectModal({ isOpen, teamId, onComplete, onSkip }: PlayerSelectModalProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const team = getTeamById(teamId);
  const players = TEAM_PLAYERS[teamId] ?? [];

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 3) {
        next.add(id);
      }
      return next;
    });
  };

  const handleComplete = () => {
    const favs: FavoritePlayer[] = players
      .filter(p => selected.has(p.id))
      .map(p => ({ playerId: p.id, name: p.name, teamId, position: p.position, number: p.number }));
    onComplete(favs);
  };

  if (!isOpen || !team) return null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center bg-bg-primary"
    >
      <div className="w-full max-w-lg px-6">
        <motion.div
          initial={{ y: 20, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.1 }}
          className="text-center mb-6"
        >
          <div className="flex items-center justify-center gap-2 mb-2">
            <Image src={team.logoPath} alt="" width={32} height={32} unoptimized className="object-contain" />
            <h1 className="text-xl font-bold text-text-primary">최애 선수를 골라주세요</h1>
          </div>
          <p className="text-sm text-text-tertiary">최대 3명 · 선택한 선수 중심으로 피드가 구성됩니다</p>
          <div className="flex justify-center gap-1 mt-3">
            {[0, 1, 2].map(i => (
              <Star
                key={i}
                size={20}
                fill={i < selected.size ? team.colorLight : "none"}
                className={i < selected.size ? "" : "text-text-tertiary"}
                style={i < selected.size ? { color: team.colorLight } : {}}
              />
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ y: 30, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="space-y-2 max-h-[50vh] overflow-y-auto"
        >
          {players.map((player, i) => {
            const isSelected = selected.has(player.id);
            return (
              <motion.button
                key={player.id}
                initial={{ x: -20, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                transition={{ delay: 0.3 + i * 0.05 }}
                onClick={() => toggle(player.id)}
                className="w-full flex items-center gap-3 p-3 rounded-2xl transition-all"
                style={{
                  background: isSelected ? `${team.colorPrimary}20` : "rgba(255,255,255,0.03)",
                  border: `2px solid ${isSelected ? team.colorLight : "transparent"}`,
                }}
              >
                <PlayerAvatar
                  name={player.name}
                  teamId={teamId}
                  photoUrl={getPlayerPhotoUrl(player.name)}
                  number={player.number}
                  size={48}
                />
                <div className="flex-1 text-left">
                  <p className="text-sm font-bold text-text-primary">{player.name}</p>
                  <p className="text-xs text-text-tertiary">#{player.number} · {player.position}</p>
                </div>
                {isSelected ? (
                  <div className="w-7 h-7 rounded-full flex items-center justify-center" style={{ backgroundColor: team.colorLight }}>
                    <Check size={16} className="text-white" />
                  </div>
                ) : (
                  <div className="w-7 h-7 rounded-full border-2 border-text-tertiary/30" />
                )}
              </motion.button>
            );
          })}
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
          className="mt-6 space-y-2"
        >
          <button
            onClick={handleComplete}
            disabled={selected.size === 0}
            className="w-full py-3 rounded-xl text-sm font-bold text-white transition-opacity disabled:opacity-30"
            style={{ backgroundColor: team.colorLight }}
          >
            {selected.size}명 선택 완료
          </button>
          <button
            onClick={onSkip}
            className="w-full py-2 text-sm text-text-tertiary"
          >
            나중에 할게요
          </button>
        </motion.div>
      </div>
    </motion.div>
  );
}
