"use client";

import { motion, AnimatePresence } from "framer-motion";
import Image from "next/image";
import { TEAMS } from "@/lib/constants/teams";

interface TeamSelectModalProps {
  isOpen: boolean;
  onSelect: (teamId: number) => void;
}

export default function TeamSelectModal({ isOpen, onSelect }: TeamSelectModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
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
              className="text-center mb-8"
            >
              <h1 className="text-2xl font-bold text-text-primary mb-2">⚾ 응원 구단을 선택하세요</h1>
              <p className="text-sm text-text-tertiary">선택한 구단 중심으로 홈 화면이 구성됩니다</p>
            </motion.div>

            <motion.div
              initial={{ y: 30, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="grid grid-cols-2 gap-3"
            >
              {TEAMS.map((team, i) => (
                <motion.button
                  key={team.id}
                  initial={{ scale: 0.8, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  transition={{ delay: 0.3 + i * 0.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => onSelect(team.id)}
                  className="flex items-center gap-3 rounded-2xl p-4 transition-colors hover:bg-white/10"
                  style={{ background: `${team.colorPrimary}15`, border: `1px solid ${team.colorPrimary}30` }}
                >
                  <div className="w-12 h-12 rounded-full bg-white p-1.5 flex items-center justify-center flex-shrink-0">
                    <Image src={team.logoPath} alt={team.name} width={36} height={36} unoptimized className="object-contain" />
                  </div>
                  <div className="text-left">
                    <p className="text-sm font-bold whitespace-nowrap" style={{ color: team.colorLight }}>{team.name}</p>
                    <p className="text-xs text-text-tertiary">{team.shortName}</p>
                  </div>
                </motion.button>
              ))}
            </motion.div>

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.8 }}
              className="text-center text-xs text-text-tertiary mt-6"
            >
              나중에 MY 페이지에서 변경할 수 있어요
            </motion.p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
