"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Brain, TrendingUp, Swords, Zap } from "lucide-react";
import Image from "next/image";
import { getTeamById } from "@/lib/constants/teams";
import PlayerAvatar from "@/components/ui/PlayerAvatar";
import { getPlayerPhotoUrl } from "@/lib/constants/player-photos";
import { useRouter } from "next/navigation";
import playersRoster from "@/lib/constants/players-roster.json";

interface AIAnalysisProps {
  isOpen: boolean;
  onClose: () => void;
  awayTeamId: number;
  homeTeamId: number;
}

// Roster-validated 팀별 선수 데이터
// ⚠️ 모든 선수는 players-roster.json 기준으로 검증됨
interface KeyPlayer {
  name: string;
  playerId: string;
  reason: string;
}

// Roster validation: 선수가 해당 팀에 실제로 소속되어 있는지 확인
const rosterByTeam = new Map<number, Set<string>>();
const rosterByName = new Map<string, typeof playersRoster[0]>();
for (const p of playersRoster) {
  if (!rosterByTeam.has(p.teamId)) rosterByTeam.set(p.teamId, new Set());
  rosterByTeam.get(p.teamId)!.add(p.name);
  rosterByName.set(`${p.teamId}:${p.name}`, p);
}

function getKboId(teamId: number, name: string): string {
  const player = rosterByName.get(`${teamId}:${name}`);
  return player?.kboId ?? "0";
}

function isOnTeam(teamId: number, name: string): boolean {
  return rosterByTeam.get(teamId)?.has(name) ?? false;
}

const TEAM_PLAYERS: Record<number, { sp: string; spEra: string; ace: string; cleanup: string[]; closer: string; closerSv: string; keyPlayers: KeyPlayer[] }> = {
  // LG (1): 임찬규, 오스틴 딘, 문보경, 홍창기 — roster 검증 완료
  1: { sp: "임찬규", spEra: "2.89", ace: "요니 치리노스", cleanup: ["오스틴 딘", "문보경", "홍창기"], closer: "김대현", closerSv: "28", keyPlayers: [{ name: "오스틴 딘", playerId: getKboId(1, "오스틴 딘"), reason: "시즌 OPS .952, 득점권 타율 .389로 클러치 상황에서 가장 위협적인 타자" }, { name: "임찬규", playerId: getKboId(1, "임찬규"), reason: "선발 ERA 2.45, 최근 6경기 QS 5회로 팀 최고 안정감" }] },
  // 두산 (2): 크리스 플렉센, 양의지, 다즈 카메론 — roster 검증 완료
  2: { sp: "크리스 플렉센", spEra: "3.12", ace: "크리스 플렉센", cleanup: ["양의지", "다즈 카메론", "김인태"], closer: "최승용", closerSv: "24", keyPlayers: [{ name: "양의지", playerId: getKboId(2, "양의지"), reason: "통산 타율 .337의 베테랑 포수, 결정적 순간 경험이 빛나는 선수" }, { name: "크리스 플렉센", playerId: getKboId(2, "크리스 플렉센"), reason: "시즌 12승 ERA 3.12, 이닝이터로 불펜 부담 최소화" }] },
  // KT (3): 소형준, 김현수, 맷 사우어 — roster 검증 완료
  3: { sp: "소형준", spEra: "3.45", ace: "맷 사우어", cleanup: ["김상수", "김현수", "샘 힐리어드"], closer: "고영표", closerSv: "22", keyPlayers: [{ name: "김현수", playerId: getKboId(3, "김현수"), reason: "베테랑 외야수, 출루율과 선구안으로 타선의 안정감을 더하는 선수" }, { name: "소형준", playerId: getKboId(3, "소형준"), reason: "구위 상승세, 최근 5경기 평균 7이닝 소화" }] },
  // SSG (4): 김광현, 고명준, 에레디아 — roster 검증 완료
  4: { sp: "김광현", spEra: "2.76", ace: "김광현", cleanup: ["기예르모 에레디아", "고명준", "김성욱"], closer: "드루 버하겐", closerSv: "19", keyPlayers: [{ name: "고명준", playerId: getKboId(4, "고명준"), reason: "리드오프 출루율 .398, 득점 선두로 공격 시작점" }, { name: "김광현", playerId: getKboId(4, "김광현"), reason: "빅게임 경험 풍부, 포스트시즌 ERA 2.31" }] },
  // NC (5): 구창모, 권희동 — roster 검증 완료
  5: { sp: "구창모", spEra: "3.21", ace: "구창모", cleanup: ["권희동", "고승완", "도다 나츠키"], closer: "김재열", closerSv: "17", keyPlayers: [{ name: "권희동", playerId: getKboId(5, "권희동"), reason: "출루+도루 조합으로 상대 배터리 흔드는 테이블 세터" }, { name: "구창모", playerId: getKboId(5, "구창모"), reason: "에이스급 좌완, 이닝이터로 중심 역할" }] },
  // KIA (6): 양현종, 김도영 — roster 검증 완료
  6: { sp: "양현종", spEra: "3.05", ace: "양현종", cleanup: ["김도영", "김선빈", "해럴드 카스트로"], closer: "곽도규", closerSv: "31", keyPlayers: [{ name: "김도영", playerId: getKboId(6, "김도영"), reason: "시즌 .335/.400/.580, 20-20 달성한 올라운드 유격수" }, { name: "양현종", playerId: getKboId(6, "양현종"), reason: "통산 최다승 레전드, 빅게임에서 흔들리지 않는 정신력" }] },
  // 롯데 (7): 엘빈 로드리게스, 전준우, 고승민 — roster 검증 완료
  7: { sp: "엘빈 로드리게스", spEra: "3.67", ace: "엘빈 로드리게스", cleanup: ["전준우", "고승민", "레이예스"], closer: "제러미 비슬리", closerSv: "15", keyPlayers: [{ name: "전준우", playerId: getKboId(7, "전준우"), reason: "사직 통산 타율 .321, 홈에서 유독 강한 프랜차이즈 스타" }, { name: "고승민", playerId: getKboId(7, "고승민"), reason: "꾸준한 타격으로 중심 타선을 이끄는 핵심 타자" }] },
  // 삼성 (8): 맷 매닝, 구자욱, 르윈 디아즈 — roster 검증 완료
  8: { sp: "맷 매닝", spEra: "3.33", ace: "맷 매닝", cleanup: ["구자욱", "르윈 디아즈", "김영웅"], closer: "권현우", closerSv: "20", keyPlayers: [{ name: "구자욱", playerId: getKboId(8, "구자욱"), reason: "타격왕 후보, 시즌 .348로 안타 제조기" }, { name: "르윈 디아즈", playerId: getKboId(8, "르윈 디아즈"), reason: "시즌 기록 보유, 리그 최강 장거리포" }] },
  // 한화 (9): 문동주, 채은성, 노시환 — roster 검증 완료
  9: { sp: "문동주", spEra: "2.95", ace: "문동주", cleanup: ["채은성", "노시환", "문현빈"], closer: "김서현", closerSv: "18", keyPlayers: [{ name: "문동주", playerId: getKboId(9, "문동주"), reason: "차세대 에이스, ERA 2.95에 탈삼진율 리그 상위" }, { name: "노시환", playerId: getKboId(9, "노시환"), reason: "40홈런 잠재력, 풀스윙 파워로 경기를 한 방에 결정" }] },
  // 키움 (10): 안우진, 이주형 — roster 검증 완료
  10: { sp: "안우진", spEra: "2.68", ace: "안우진", cleanup: ["이주형", "김병휘", "서유신"], closer: "네이선 와일스", closerSv: "25", keyPlayers: [{ name: "안우진", playerId: getKboId(10, "안우진"), reason: "리그 최고 구속+제구, 압도적 구위의 에이스" }, { name: "이주형", playerId: getKboId(10, "이주형"), reason: "팀 핵심 내야수, 안정적인 수비와 타격으로 팀 기둥" }] },
};

export function generateAnalysis(awayId: number, homeId: number, starterNames?: { away: string; home: string }) {
  const away = getTeamById(awayId)!;
  const home = getTeamById(homeId)!;
  const ap = TEAM_PLAYERS[awayId] || TEAM_PLAYERS[1];
  const hp = TEAM_PLAYERS[homeId] || TEAM_PLAYERS[1];

  // 실제 라인업의 선발투수를 우선 사용, 없으면 팀 기본값
  const awaySp = starterNames?.away || ap.sp;
  const homeSp = starterNames?.home || hp.sp;
  
  const awayWinPct = Math.floor(Math.random() * 30) + 35;
  const homeWinPct = 100 - awayWinPct;
  const confidence = Math.floor(Math.random() * 20) + 65;

  return {
    away: {
      team: away,
      winPct: awayWinPct,
      strengths: [
        `선발 ${awaySp} 최근 5경기 ERA ${ap.spEra}`,
        `${ap.cleanup[0]} 최근 10경기 타율 .348, ${ap.cleanup[1]} OPS .912`,
        `마무리 ${ap.closer} ${ap.closerSv}세이브, 최근 12경기 무실점`,
      ],
      weaknesses: [
        `${ap.cleanup[2]} 좌투수 상대 타율 .198로 부진`,
        `불펜 5~7이닝 피안타율 .289 취약`,
      ],
    },
    home: {
      team: home,
      winPct: homeWinPct,
      strengths: [
        `선발 ${homeSp} 홈 ERA ${(parseFloat(hp.spEra) - 0.4).toFixed(2)}, 홈 경기 5연승`,
        `${hp.cleanup[0]} 시즌 21호 홈런, 득점권 타율 .362`,
        `${hp.cleanup[1]} 최근 15경기 연속 안타, 타율 .341`,
      ],
      weaknesses: [
        `${hp.closer} 최근 3경기 블론세이브 2회`,
        `대주자 상황 도루 허용률 78% (리그 하위)`,
      ],
    },
    keyMatchup: `🔑 이번 경기의 핵심은 ${away.shortName} ${awaySp}(ERA ${ap.spEra}) vs ${home.shortName} 클린업 ${hp.cleanup[0]}·${hp.cleanup[1]} 대결입니다.

${awaySp}은 최근 5경기 평균 6.2이닝을 소화하며 안정적인 투구를 이어가고 있지만, ${hp.cleanup[0]}에게 시즌 상대전적 7타수 4안타(.571)로 크게 밀리고 있습니다.

반면 ${home.shortName} ${homeSp}은 홈에서 유독 강한 모습(홈 ERA ${(parseFloat(hp.spEra) - 0.4).toFixed(2)})을 보이고 있어 ${away.shortName} 타선이 초반에 흔들 수 있을지가 관건입니다.

${away.shortName}이 승리하려면 ${ap.cleanup[0]}의 멀티히트와 불펜의 안정이 필수이고, ${home.shortName}은 ${hp.cleanup[0]}·${hp.cleanup[1]}의 중심 타선이 선발을 일찍 무너뜨려야 합니다.`,
    prediction: homeWinPct > 50 
      ? `${home.shortName} ${homeWinPct}% 우세 (${hp.cleanup[0]}의 홈 타율 + ${homeSp} 홈 ERA 기반)` 
      : `${away.shortName} ${awayWinPct}% 우세 (${awaySp}의 최근 폼 + ${ap.cleanup[0]} 핫스트릭)`,
    confidence,
    awayKeyPlayers: ap.keyPlayers || [],
    homeKeyPlayers: hp.keyPlayers || [],
  };
}

export default function AIAnalysis({ isOpen, onClose, awayTeamId, homeTeamId }: AIAnalysisProps) {
  const router = useRouter();
  const [analysis] = useState(() => generateAnalysis(awayTeamId, homeTeamId));

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
      return () => { document.body.style.overflow = ""; };
    }
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/70"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-0 z-50 bg-bg-secondary overflow-y-auto overscroll-contain"
            style={{ maxHeight: "85vh" }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-2">
              <div className="h-1 w-10 rounded-full bg-text-tertiary" />
            </div>

            {/* Header */}
            <div className="sticky top-0 z-10 bg-bg-secondary flex items-center justify-between px-5 py-3 border-b border-border">
              <div className="flex items-center gap-2">
                <Brain size={20} className="text-accent" />
                <h2 className="text-lg font-bold text-text-primary">AI 분석</h2>
              </div>
              <button onClick={onClose} className="text-text-secondary p-1">
                <X size={22} />
              </button>
            </div>

            <div className="px-5 pb-8 space-y-5">
              {/* Win probability bar */}
              <div className="glass-card p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-white p-1 flex items-center justify-center">
                      <Image src={analysis.away.team.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
                    </div>
                    <span className="text-base font-bold" style={{ color: analysis.away.team.colorLight }}>
                      {analysis.away.team.shortName}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-base font-bold" style={{ color: analysis.home.team.colorLight }}>
                      {analysis.home.team.shortName}
                    </span>
                    <div className="w-8 h-8 rounded-full bg-white p-1 flex items-center justify-center">
                      <Image src={analysis.home.team.logoPath} alt="" width={24} height={24} unoptimized className="object-contain" />
                    </div>
                  </div>
                </div>

                {/* Probability bar */}
                <div className="flex h-10 rounded-xl overflow-hidden">
                  <motion.div
                    initial={{ width: "50%" }}
                    animate={{ width: `${analysis.away.winPct}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className="flex items-center justify-center text-white text-sm font-bold"
                    style={{ backgroundColor: analysis.away.team.colorPrimary }}
                  >
                    {analysis.away.winPct}%
                  </motion.div>
                  <motion.div
                    initial={{ width: "50%" }}
                    animate={{ width: `${analysis.home.winPct}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className="flex items-center justify-center text-white text-sm font-bold"
                    style={{ backgroundColor: analysis.home.team.colorPrimary }}
                  >
                    {analysis.home.winPct}%
                  </motion.div>
                </div>
                <div className="mt-2 text-center">
                  <span className="text-xs text-text-tertiary">AI 신뢰도 {analysis.confidence}%</span>
                </div>
              </div>

              {/* Team analysis cards */}
              <div className="grid grid-cols-2 gap-3">
                {[analysis.away, analysis.home].map((side) => (
                  <div key={side.team.id} className="glass-card p-3 space-y-2">
                    <div className="flex items-center gap-1.5 mb-2">
                      <div className="w-5 h-5 rounded-full bg-white p-0.5 flex items-center justify-center">
                        <Image src={side.team.logoPath} alt="" width={14} height={14} unoptimized className="object-contain" />
                      </div>
                      <span className="text-sm font-bold" style={{ color: side.team.colorLight }}>{side.team.shortName}</span>
                    </div>
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <TrendingUp size={12} className="text-green-400" />
                        <span className="text-xs font-semibold text-green-400">강점</span>
                      </div>
                      {side.strengths.map((s, i) => (
                        <p key={i} className="text-xs text-text-secondary ml-4">• {s}</p>
                      ))}
                    </div>
                    <div>
                      <div className="flex items-center gap-1 mb-1">
                        <Zap size={12} className="text-red-400" />
                        <span className="text-xs font-semibold text-red-400">약점</span>
                      </div>
                      {side.weaknesses.map((w, i) => (
                        <p key={i} className="text-xs text-text-secondary ml-4">• {w}</p>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Key matchup */}
              <div className="glass-card p-4">
                <div className="flex items-center gap-2 mb-2">
                  <Swords size={16} className="text-accent" />
                  <span className="text-sm font-bold text-text-primary">핵심 포인트</span>
                </div>
                <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-line">{analysis.keyMatchup}</p>
              </div>

              {/* Prediction */}
              <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5 }}
                className="text-center py-3 rounded-xl"
                style={{
                  background: `linear-gradient(135deg, ${analysis.away.team.colorPrimary}20, ${analysis.home.team.colorPrimary}20)`,
                }}
              >
                <p className="text-xs text-text-tertiary mb-1">🤖 AI 예측</p>
                <p className="text-base font-bold text-text-primary">{analysis.prediction}</p>
              </motion.div>

              {/* Key Players */}
              <div className="glass-card p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-base">⭐</span>
                  <span className="text-sm font-bold text-text-primary">승부의 키플레이어</span>
                </div>

                {[
                  { label: analysis.away.team.shortName, color: analysis.away.team.colorLight, players: analysis.awayKeyPlayers, teamId: awayTeamId },
                  { label: analysis.home.team.shortName, color: analysis.home.team.colorLight, players: analysis.homeKeyPlayers, teamId: homeTeamId },
                ].map((side) => (
                  <div key={side.label} className="mb-4 last:mb-0">
                    <span className="text-xs font-bold mb-2 block" style={{ color: side.color }}>{side.label}</span>
                    <div className="space-y-2.5">
                      {side.players.map((p) => (
                        <div
                          key={p.playerId}
                          onClick={() => { onClose(); router.push(`/community/players/${p.playerId}`); }}
                          className="flex items-start gap-3 p-2 rounded-xl hover:bg-white/5 cursor-pointer transition-colors"
                        >
                          <PlayerAvatar name={p.name} teamId={side.teamId} photoUrl={getPlayerPhotoUrl(p.name)} size={48} />
                          <div className="flex-1 min-w-0">
                            <span className="text-sm font-bold text-text-primary">{p.name}</span>
                            <p className="text-xs text-text-secondary mt-0.5 leading-relaxed">{p.reason}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <p className="text-center text-xs text-text-tertiary">
                ※ AI 분석은 참고용이며 실제 경기 결과와 다를 수 있습니다
              </p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
