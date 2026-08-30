import { NextRequest, NextResponse, after } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { TEAMS, isAllStarGameId } from "@/lib/constants/teams";
import {
  fetchStandings,
  buildRankMap,
  fetchGames,
  fetchBoxScore,
  fetchGameLinescore,
  type KboGame,
  type GameLinescore,
} from "@/lib/crawler/kbo-api";
import { fetchNaverLinescore, hasInningBreakdown } from "@/lib/crawler/naver-record";
import { trackApiDegradation } from "@/lib/monitoring/api-fallback-tracker";
import { STANDINGS_ACCURACY_RULES, STANDINGS_UNAVAILABLE_RULES } from "@/lib/ai/standings-guard";
import { computeSeriesSnapshot, serializeSeriesSnapshot } from "@/lib/series/snapshot";
import { loserClaimedWin } from "@/lib/game-summary/winner-check";
import { hasBaseRunnerContradiction } from "@/lib/game-summary/consistency-check";
import {
  canonicalGate,
  isFingerprintStale,
  shouldSaveGeneratedSummary,
  winnerFieldMismatch,
  type SummaryFingerprint,
} from "@/lib/game-summary/cache-validation";
import {
  classifyGenerationFailure,
  canonicalFailureStage,
  type GenerationFailureStage,
} from "@/lib/game-summary/failure-observability";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const PROMPT_VERSION = 13; // v13: 순위 환각 방지 가드(공식 순위표 기준 규칙 + 조회 실패 fallback) — 기존 캐시 재생성

// (2026-08-29 LG:롯데 콜드게임 인시던트, 삼순 A안) 생성 단계 실패의 durable 관측.
// 기존엔 console.error 만 남아 Vercel 로그 보존창을 놔치면 실패 지점을 소급 판정할 수
// 없었다(22:21 final 전이 → 22:31 복구 사이 생성 실패 2~3회 미확정). 분류(실패축 vs 정상
// 동시요청축 비경보)는 failure-observability 순수 모듈이 담당 — 게이트가 같은 seam 을 태운다.
// after() 로 응답 이후 실행해 latency 무영향, 실패해도 응답에 영향 없음(track 내부 catch).
function reportGenerationFailure(gameId: string, stage: GenerationFailureStage, detail: string) {
  const c = classifyGenerationFailure(stage);
  after(() =>
    trackApiDegradation(
      c.apiName,
      c.reason,
      { errorMessage: `${gameId}: stage=${stage} ${detail}`.slice(0, 500) },
      c.policy,
    ),
  );
}

// ===== Types =====

interface BoxScoreInput {
  gameId: string;
  awayTeam: string;
  homeTeam: string;
  awayScore: number;
  homeScore: number;
  linescore?: {
    away: { innings: (number | null)[]; R?: number; H?: number; E?: number };
    home: { innings: (number | null)[]; R?: number; H?: number; E?: number };
  };
  awayBatters: { name: string; ab: number; r: number; h: number; rbi: number; hr: number; bb: number; so: number; avg: string }[];
  homeBatters: { name: string; ab: number; r: number; h: number; rbi: number; hr: number; bb: number; so: number; avg: string }[];
  awayPitchers: { name: string; ip: string; h: number; r: number; er: number; bb: number; so: number; hr: number; np: number; result?: string }[];
  homePitchers: { name: string; ip: string; h: number; r: number; er: number; bb: number; so: number; hr: number; np: number; result?: string }[];
}

// ===== Team ID helpers =====

const KBO_CODE_TO_ID: Record<string, number> = {
  LG: 1, OB: 2, KT: 3, SK: 4, NC: 5,
  HT: 6, LT: 7, SS: 8, HH: 9, WO: 10,
};

function getTeamShortName(teamId: number): string {
  return TEAMS.find(t => t.id === teamId)?.shortName || `팀${teamId}`;
}

function parseGameMeta(gameId: string): { dateStr: string; awayTeamId: number; homeTeamId: number } | null {
  const m = gameId.match(/^(\d{8})([A-Z]{2})([A-Z]{2})(\d)$/);
  if (!m) return null;
  return {
    dateStr: m[1],
    awayTeamId: KBO_CODE_TO_ID[m[2]] || 0,
    homeTeamId: KBO_CODE_TO_ID[m[3]] || 0,
  };
}

function toBoxScoreInput(game: KboGame, linescore: GameLinescore, boxScore: Awaited<ReturnType<typeof fetchBoxScore>>): BoxScoreInput | null {
  if (!boxScore) return null;
  return {
    gameId: game.gameId,
    awayTeam: getTeamShortName(game.awayTeamId),
    homeTeam: getTeamShortName(game.homeTeamId),
    awayScore: linescore.away.R,
    homeScore: linescore.home.R,
    linescore,
    awayBatters: boxScore.awayBatters.map((b) => ({
      name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
      rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
    })),
    homeBatters: boxScore.homeBatters.map((b) => ({
      name: b.name, ab: b.atBats, r: b.runs, h: b.hits,
      rbi: b.rbi, hr: b.hr, bb: b.bb, so: b.so, avg: b.avg || "",
    })),
    awayPitchers: boxScore.awayPitchers.map((p) => ({
      name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
      er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
      np: p.pitchCount, result: p.decision || undefined,
    })),
    homePitchers: boxScore.homePitchers.map((p) => ({
      name: p.name, ip: p.inningsPitched, h: p.hits, r: p.runs,
      er: p.earnedRuns, bb: p.walks, so: p.strikeouts, hr: p.hr,
      np: p.pitchCount, result: p.decision || undefined,
    })),
  };
}

async function fetchCanonicalSummarySource(gameId: string, includeBoxScore: boolean): Promise<{
  game?: KboGame;
  linescore: GameLinescore | null;
  input: BoxScoreInput | null;
  fingerprint: SummaryFingerprint | null;
  reason: string;
  httpStatus: number;
}> {
  const meta = parseGameMeta(gameId);
  if (!meta) {
    return { linescore: null, input: null, fingerprint: null, reason: "invalid-gameid", httpStatus: 400 };
  }

  try {
    const [games, kboLinescore, boxScore] = await Promise.all([
      fetchGames(meta.dateStr),
      fetchGameLinescore(gameId),
      includeBoxScore ? fetchBoxScore(gameId, meta.dateStr.slice(0, 4)) : Promise.resolve(null),
    ]);
    const game = games.find((candidate) => candidate.gameId === gameId);
    // KBO GetScoreBoard가 '-' 이닝을 주면 linescore=null/이닝 부재 → canonicalGate가
    // canonical-not-settled(409)로 종료 경기 요약을 거부한다(2026-07-28 사고). 경기목록
    // canonical.status가 final인데 이닝표만 없을 때, game-detail과 동일한 Naver record
    // scoreBoard로 이닝표를 fallback한다(스코어 R 교차검증은 canonicalGate가 그대로 수행).
    let linescore = kboLinescore;
    if (game?.status === "final" && !hasInningBreakdown(linescore)) {
      // KBO GetScoreBoard 이닝표 열화(2026-07-28 종료경기 AI요약 전면 중단 사고) 실시간 감지.
      // durable RPC 로 window count + cooldown 을 판정(서버리스 분산에도 경보 1회 보장) 후
      // 임계치 초과 시 텔레그램 자동 경보 + 일일 리포트 반영. 다음 열화를 유저 제보 전에 알기 위함.
      // after() 로 응답 이후 실행을 보장(durable insert·텔레그램 수명 보장)하되, 요약 생성 latency 는 안 늘린다.
      const naver = await fetchNaverLinescore(gameId);
      if (naver) {
        linescore = { status: "final", away: naver.away, home: naver.home };
        // 성공 fallback(KBO 열화 → Naver 로 복구): warning 급, 5분 3회 임계치.
        after(() =>
          trackApiDegradation(
            "kbo-scoreboard-linescore",
            "schema-error",
            { errorMessage: `${gameId}: KBO 이닝표 결측 → Naver record fallback 성공` },
            { windowMinutes: 5, threshold: 3, cooldownMinutes: 30, leaseSeconds: 120 },
          ),
        );
      } else {
        // Naver 우회로도 이닝표를 못 줌 = 전면장애 재발 + 백업 소스 소실 → canonical-not-settled 예상.
        // critical 급: 별도 api명으로 분리(일일 리포트 분리 집계) + 1건 즉시 경보.
        after(() =>
          trackApiDegradation(
            "kbo-scoreboard-linescore-outage",
            "schema-error",
            { errorMessage: `${gameId}: KBO 이닝표 결측 + Naver fallback 실패 → canonical-not-settled 예상` },
            { windowMinutes: 5, threshold: 1, cooldownMinutes: 10, leaseSeconds: 120 },
          ),
        );
      }
    }
    const gate = canonicalGate(game, linescore);
    if (gate.reason !== "ok" || !gate.fingerprint) {
      return {
        game,
        linescore,
        input: null,
        fingerprint: null,
        reason: gate.reason,
        httpStatus: gate.httpStatus,
      };
    }
    const input = includeBoxScore ? toBoxScoreInput(game!, linescore!, boxScore) : null;
    if (includeBoxScore && !input) {
      return {
        game,
        linescore,
        input: null,
        fingerprint: gate.fingerprint,
        reason: "canonical-boxscore-unavailable",
        httpStatus: 503,
      };
    }
    return {
      game,
      linescore,
      input,
      fingerprint: gate.fingerprint,
      reason: "ok",
      httpStatus: 200,
    };
  } catch {
    return {
      linescore: null,
      input: null,
      fingerprint: null,
      reason: "canonical-unavailable",
      httpStatus: 503,
    };
  }
}

// ===== Context helpers (server-side) =====

async function fetchSeriesContext(gameId: string, awayTeamId: number, homeTeamId: number): Promise<{ text: string; status: string } | null> {
  const snap = await computeSeriesSnapshot(gameId, awayTeamId, homeTeamId);
  if (!snap) return null;
  const awayShort = getTeamShortName(awayTeamId);
  const homeShort = getTeamShortName(homeTeamId);
  return {
    text: serializeSeriesSnapshot(snap, awayTeamId, awayShort, homeTeamId, homeShort),
    status: snap.seriesStatus,
  };
}

async function fetchStandingsContext(awayTeamId: number, homeTeamId: number): Promise<string | null> {
  const standings = await fetchStandings();
  if (standings.length === 0) return null;

  const awayShort = getTeamShortName(awayTeamId);
  const homeShort = getTeamShortName(homeTeamId);

  const awaySt = standings.find(s => s.teamName === awayShort);
  const homeSt = standings.find(s => s.teamName === homeShort);
  if (!awaySt || !homeSt) return null;

  // 공동순위 보존 — 원본 ranking 우선(buildRankMap), index+1 단순 방식 금지(삼순 조건)
  const rankMap = buildRankMap(standings);
  const awayRank = rankMap.get(awaySt.teamId) ?? awaySt.ranking ?? 0;
  const homeRank = rankMap.get(homeSt.teamId) ?? homeSt.ranking ?? 0;

  // "선두"는 1위에게만 — 2위가 게임차 0(승률차로만 뒤짐)일 수 있어 gamesBehind 기준은 오라벨 유발
  return `${awayShort}: ${awayRank}위 (${awaySt.wins}승 ${awaySt.losses}패, 승률 ${awaySt.winRate.toFixed(3)}${awayRank === 1 ? ", 선두" : `, ${awaySt.gamesBehind}게임차`})
${homeShort}: ${homeRank}위 (${homeSt.wins}승 ${homeSt.losses}패, 승률 ${homeSt.winRate.toFixed(3)}${homeRank === 1 ? ", 선두" : `, ${homeSt.gamesBehind}게임차`})`;
}

// ===== Prompt builder =====

function buildPrompt(data: BoxScoreInput, seriesCtx: string | null, standingsCtx: string | null): string {
  const { awayTeam, homeTeam, awayScore, homeScore, linescore, awayBatters, homeBatters, awayPitchers, homePitchers } = data;

  // 이닝별 점수 + 득점 흐름 구조화
  let linescoreStr = "";
  let scoringNarrative = "";
  if (linescore) {
    const awayInnings = linescore.away.innings.map((v, i) => `${i + 1}회초: ${v ?? "-"}`).join(", ");
    const homeInnings = linescore.home.innings.map((v, i) => `${i + 1}회말: ${v ?? "-"}`).join(", ");
    linescoreStr = `\n이닝별 점수 (${awayTeam}=원정=초 공격, ${homeTeam}=홈=말 공격):\n${awayTeam}(초): ${awayInnings}\n${homeTeam}(말): ${homeInnings}`;

    // 서버에서 이닝별 득점 흐름 계산 → LLM 환각 방지
    const awayInns = linescore.away.innings;
    const homeInns = linescore.home.innings;
    let aRunning = 0, hRunning = 0;
    const events: string[] = [];
    const maxInn = Math.max(awayInns.length, homeInns.length);
    for (let i = 0; i < maxInn; i++) {
      const aScore = awayInns[i] ?? 0;
      const hScore = homeInns[i] ?? 0;
      if (aScore > 0) {
        aRunning += aScore;
        events.push(`${i + 1}회초: ${awayTeam} ${aScore}점 득점 (누적 ${aRunning}-${hRunning})`);
      }
      if (hScore > 0) {
        hRunning += hScore;
        events.push(`${i + 1}회말: ${homeTeam} ${hScore}점 득점 (누적 ${aRunning}-${hRunning})`);
      }
    }
    if (events.length > 0) {
      scoringNarrative = `\n## 득점 타임라인 (사실 — 이 순서를 절대 바꾸지 마세요)\n${events.join("\n")}`;
    }
  }

  // 에러
  let errorStr = "";
  if (linescore) {
    const awayE = linescore.away.E ?? 0;
    const homeE = linescore.home.E ?? 0;
    if (awayE > 0 || homeE > 0) {
      errorStr = `\n실책: ${awayTeam} ${awayE}개, ${homeTeam} ${homeE}개`;
    }
  }

  // 주요 팩트
  const hrHitters = [
    ...awayBatters.filter(b => b.hr > 0).map(b => `${awayTeam} ${b.name} (${b.hr}홈런 ${b.rbi}타점)`),
    ...homeBatters.filter(b => b.hr > 0).map(b => `${homeTeam} ${b.name} (${b.hr}홈런 ${b.rbi}타점)`),
  ];
  const multiHitters = [
    ...awayBatters.filter(b => b.h >= 2).map(b => `${awayTeam} ${b.name} (${b.ab}타수 ${b.h}안타 ${b.rbi}타점)`),
    ...homeBatters.filter(b => b.h >= 2).map(b => `${homeTeam} ${b.name} (${b.ab}타수 ${b.h}안타 ${b.rbi}타점)`),
  ];

  const awayStarter = awayPitchers[0];
  const homeStarter = homePitchers[0];
  const result = awayScore === homeScore ? "무승부" : awayScore > homeScore ? `${awayTeam} 승리` : `${homeTeam} 승리`;
  const winnerTeam = awayScore > homeScore ? awayTeam : homeScore > awayScore ? homeTeam : null;
  const scoreDiff = Math.abs(awayScore - homeScore);

  // 경기 성격 힌트 (LLM이 서사 방향을 잡는 데 도움)
  let gameCharacter = "";
  if (scoreDiff >= 5) gameCharacter = "대승/대패 경기";
  else if (scoreDiff === 1) gameCharacter = "1점차 접전";
  else if (scoreDiff <= 2) gameCharacter = "박빙 승부";
  if (linescore) {
    // 역전 여부 감지
    const awayInns = linescore.away.innings;
    const homeInns = linescore.home.innings;
    let aRunning = 0, hRunning = 0;
    let leadChanged = 0;
    let prevLeader = "";
    for (let i = 0; i < Math.max(awayInns.length, homeInns.length); i++) {
      aRunning += awayInns[i] ?? 0;
      hRunning += homeInns[i] ?? 0;
      const leader = aRunning > hRunning ? "away" : hRunning > aRunning ? "home" : "tie";
      if (leader !== "tie" && leader !== prevLeader && prevLeader !== "" && prevLeader !== "tie") {
        leadChanged++;
      }
      if (leader !== "tie") prevLeader = leader;
    }
    if (leadChanged >= 1) gameCharacter += " / 역전극";
  }
  const totalK = [...awayPitchers, ...homePitchers].reduce((s, p) => s + p.so, 0);
  const totalH = awayBatters.reduce((s, b) => s + b.h, 0) + homeBatters.reduce((s, b) => s + b.h, 0);
  if (totalK >= 15 && totalH <= 10) gameCharacter += " / 투수전";
  if (hrHitters.length >= 3) gameCharacter += " / 홈런 퍼레이드";

  // 맥락 섹션 — seriesCtx 는 snapshot.ts 가 이미 '## 시리즈 스냅샷' 헤딩 포함해서 바로 append
  let contextSection = "";
  if (seriesCtx) contextSection += `\n${seriesCtx}`;
  if (standingsCtx) contextSection += `\n## 현재 순위\n${standingsCtx}\n${STANDINGS_ACCURACY_RULES}`;
  else contextSection += `\n${STANDINGS_UNAVAILABLE_RULES}`;

  return `당신은 KBO 프로야구를 20년 넘게 현장에서 취재해온 베테란 스포츠 기자입니다.
마감 시간에 쫓기며 오늘 직접 본 경기의 기사를 쓰고 있습니다.
독자는 야구를 사랑하는 팬입니다. 건조한 통계 나열이 아니라, 경기장에 있는 듯한 현장감을 전달하세요.

## 핵심 원칙 — 반드시 따를 것
1. **매 경기가 다른 이야기다.** 경기 성격에 따라 리드문, 서술 순서, 강조점을 완전히 바꿔라.
   - 대승이면 승리팀 타선 폭발에 집중
   - 접전이면 끝까지 손에 땀 쥐는 긴장감
   - 역전극이면 역전 드라마가 중심
   - 투수전이면 투수 대결의 서사
   - 홈런이 결정적이었으면 홈런 장면이 리드
2. **템플릿 금지.** "X팀이 Y팀을 Z-W로 꺾었다"로 시작하는 판에 박은 리드를 쓰지 마라.
3. **팩트만. 창작 절대 금지.** 박스스코어와 이닝별 점수에 있는 것만 사용. 없는 장면, 없는 감정, 없는 관중 반응을 절대 만들지 마라. "선수(숫자)" 형식의 이름은 언급하지 말고 팀명으로 대체.
   **특히 금지하는 창작 유형:**
   - 비디오 판독, 파울 판정, 심판 판정 논란 → 박스스코어에 없음
   - 관중 함성/반응, 감독 표정/작전, 덤아웃 분위기 → 박스스코어에 없음
   - 타구 굤적, 투구 코스, 수비 플레이 세부 → 박스스코어에 없음
   - "홀런성 타구", "담장을 넘긴 타구가 파울", "책사포 데이터" → 수치 확인 불가, 절대 쓰지 마라
   → **확인할 수 없는 세부 장면을 만드는 것보다, 확인된 수치로만 서술하는 것이 100배 낫다.**
   **이닝별 득점 주체 추측 금지:**
   - 박스스코어는 선수별 '총 스탯'만 제공한다. 몇 회에 누가 쳤는지는 없다.
   - 따라서 "문보경의 1회초 2점 홈런" 같은 이닝+선수+타격종류 조합은 추측이며, 틀릴 수 있다.
   - **이닝별 서술은 '팀 단위'("이 이닝에 LG가 2점") 또는 '득점 타임라인 데이터 그대로'만 쓴다.**
   - 선수 이름은 MVP 선정이나 경기 전체 활약 요약에서만 사용하라 ("문보경 3안타 2타점으로 활약" OK / "문보경의 1회 홈런" NG).
   **주자 상황·출루 과정 창작 절대 금지 (박스스코어에 없음 — 이번 사고의 핵심):**
   - 박스스코어에는 '몇 루에 주자가 몇 명 있었는지'(만루/주자 2명/1·3루)와 '주자가 어떻게 출루했는지'(연속 안타/볼넷/진루타)가 **전혀 없다.** 절대 지어내지 마라.
   - 금지 표현 예: "2사 만루에서", "연속 안타로 만루를 채우고", "볼넷과 진루타로 찬스를 잡아". → 같은 장면을 한 문단은 "연속 안타", 다른 문단은 "볼넷·진루타"로 다르게 쓰는 모순이 실제로 발생했다.
   - 홈런/타점은 **타점 수(=그 타석에서 득점한 인원)로만** 서술하라. 솔로=1점, 2점 홈런=2점, 3점 홈런=3점, 만루홈런=4점.
   - **산술 모순 절대 금지: 만루(주자 3명)에서 홈런이면 타자 포함 4명이 들어와 반드시 '만루홈런(4점)'이다. "만루"와 "3점(이하) 홈런"을 한 문장/한 경기 서술에 같이 쓰면 절대 안 된다.** 득점 타임라인과 선수 타점만으로 검증되는 사실만 써라.
4. **이닝 해석 규칙 (경기 구조 반드시 준수).** 원정팀=이닝 초 공격, 홈팀=이닝 말 공격. 득점 타임라인이 주어졌으면 그 순서를 절대 바꾸지 마라. 예: "9회초 원정팀 2점" 다음에 "9회말 홈팀 4점"이라면, 홈팀이 나중에 득점한 것이다. 순서를 뒤집어 "홈팀이 먼저 역전하고 원정팀이 다시 재역전" 같은 물리적으로 불가능한 서사를 쓰면 절대 안 된다.
4. **숫자를 서사로.** "3안타 4타점"을 나열하지 말고, 그 숫자가 경기 흐름에서 왜 중요했는지 해석하라.
5. **빈 칸보다 침묵.** 해당 없는 필드는 null로 두라. 억지로 채우면 품질이 떨어진다.
6. **경기 맥락을 활용하라.** 시리즈 상황(스윕, 위닝시리즈), 순위 영향이 있으면 자연스럽게 녹여서 경기의 의미를 부여하라.
   **시리즈 문구 분기 (아래 '## 시리즈 스냅샷' 섹션의 '상태' 값과 '## 시리즈 문구 규칙'을 반드시 준수):**
   - 상태 in_progress: "원점으로 돌렸다 / 추격의 발판 / 시리즈 리드 / 열세 만회 / 스윕 직전" 같은 진행형 표현 허용.
   - 상태 completed: 확정형만. "원점 / 추격 / 리드 굳힘 / 발판" 금지. "이번 시리즈를 N승 N패로 마쳤다 / 스윕으로 마감" 등.
   - 상태 completed_with_cancellation + 동률: 반드시 "우천 취소로 이번 시리즈는 N승 N패 무승부로 마무리됐다" 패턴. "원점으로 돌렸다" 절대 금지.
   - 상태 completed_with_cancellation + 승패 결정: 결과 중심으로 "이번 시리즈를 N승 N패로 마무리했다". "N경기로 축소된 시리즈" 표현은 필요할 때만 보조로.
   - seriesCanceledCount가 0이면 취소 언급 자체 금지.
   - 시리즈 승수·날짜·스코어는 '## 시리즈 스냅샷'에 있는 값만 사용. 창작 금지.
7. **상투구/클리셰 절대 금지.** 아래 표현은 쓰지 마라. 더 구체적이고 이 경기만의 표현으로 대체:
   - "팽팽한 투수전 양상" → 구체적 상황 ("양 선발이 5회까지 무안타로 맞섰다" 등)
   - "경기의 결정적인 승부처는" → 바로 장면부터 시작 ("5회말 2사 만루, X의 타석에서~")
   - "분위기를 가져왔다/반전에 성공" → 구체적 결과로 ("이 안타로 2점 리드를 만들며~")
   - "흐름을 결정지었다/바꾸었다" → 실제 스코어 변화로 서술
   - "침묵을 깨고/깨뜨렸다" → "X이닝 만에 첫 안타가 나왔고" 등 팩트로
   - "여세를 몰아 갔다/발판을 마련" → 후속 득점의 구체적 전개로
   - "한 치 앞을 알 수 없는" → 실제 스코어 변동으로 긴장감 전달
   - "명승부" → 쓰지 말고 독자가 읽고 느끼게 하라
   핵심: 추상적 평가어 대신 **구체적 장면 + 숫자**로 서술하라.

## 경기 데이터
${awayTeam}(원정) ${awayScore} : ${homeScore} ${homeTeam}(홈) (${result})
★★★ 최종 결과: ${result} (${awayTeam} ${awayScore}점, ${homeTeam} ${homeScore}점) — 헤드라인과 본문에서 승패를 절대 뒤집지 마라 ★★★
경기 성격: ${gameCharacter || "일반"}
${linescoreStr}${scoringNarrative}${errorStr}

## 주요 팩트
- 홈런: ${hrHitters.length > 0 ? hrHitters.join(", ") : "없음"}
- 멀티히트: ${multiHitters.length > 0 ? multiHitters.join(", ") : "없음"}
- ${awayTeam} 선발: ${awayStarter?.name} ${awayStarter?.ip}이닝 ${awayStarter?.er}자책 ${awayStarter?.so}삼진 ${awayStarter?.np}투구${awayStarter?.result ? ` (${awayStarter.result})` : ""}
- ${homeTeam} 선발: ${homeStarter?.name} ${homeStarter?.ip}이닝 ${homeStarter?.er}자책 ${homeStarter?.so}삼진 ${homeStarter?.np}투구${homeStarter?.result ? ` (${homeStarter.result})` : ""}

## ${awayTeam} 타자 상세
${awayBatters.map(b => `${b.name}: ${b.ab}타수 ${b.h}안타 ${b.r}득점 ${b.rbi}타점 ${b.hr}홈런 ${b.bb}볼넷 ${b.so}삼진`).join("\n")}

## ${homeTeam} 타자 상세
${homeBatters.map(b => `${b.name}: ${b.ab}타수 ${b.h}안타 ${b.r}득점 ${b.rbi}타점 ${b.hr}홈런 ${b.bb}볼넷 ${b.so}삼진`).join("\n")}

## ${awayTeam} 투수 상세
${awayPitchers.map(p => `${p.name}: ${p.ip}이닝 피안타${p.h} ${p.er}자책 ${p.bb}볼넷 ${p.so}삼진 ${p.np}투구${p.result ? ` (${p.result})` : ""}`).join("\n")}

## ${homeTeam} 투수 상세
${homePitchers.map(p => `${p.name}: ${p.ip}이닝 피안타${p.h} ${p.er}자책 ${p.bb}볼넷 ${p.so}삼진 ${p.np}투구${p.result ? ` (${p.result})` : ""}`).join("\n")}
${contextSection}

## 출력 형식 (JSON 객체 하나만 출력. 마크다운/설명 텍스트 절대 금지.)
{
  "winner": "${winnerTeam || '무승부'}",
  "headline": "신문 1면 헤드라인. 핵심 이벤트+점수+팀명. 임팩트 있게. 매번 다른 구조로. 반드시 ${result}을 정확히 반영. ★ 시리즈 상태가 completed인 경우: '발판 마련/위닝시리즈/추격의 발판/리드 굳힘/스윕 직전' 같은 진행형 시리즈 표현을 헤드라인에 절대 넣지 마라. 이 경기가 시리즈 마지막 경기면 확정된 결과(승리/패배)만 반영. (예: '오스틴 끝내기 2점포! LG, 9회 대역전극', '원태인 7이닝 1실점 역투, 삼성 투수전 제압')",
  "gameFlow": {
    "early": "초반(1~3회) 경기 흐름. 선발 투수 상태, 선취점 상황. 이닝별 점수 참고. 2~3문장.",
    "mid": "중반(4~6회) 경기 흐름. 전환점, 추가 득점, 투수 교체 등. 2~3문장.",
    "late": "후반(7~9회+) 경기 흐름. 추격/역전/마무리. 2~3문장."
  },
  "turningPoint": "이 경기의 결정적 승부처. 구체적 상황+숫자+왜 경기를 갈랐는지 해석. 무승부여도 가장 팽팽했던 순간. 3~4문장. 반드시 작성. 빈 문자열 절대 금지. ★ 주자 상황(만루/주자 수)·출루 과정(연속 안타/볼넷/진루타)은 박스스코어에 없으니 절대 지어내지 마라. 득점 타임라인의 이닝·팀 득점과 선수 타점/홈런 수로만 서술하라 (예: '8회말 문보경이 3타점 홈런으로 4-2 역전을 만들었다' OK / '2사 만루에서 3점 홈런' NG).",
  "mvpBatter": {
    "name": "선수 이름",
    "stats": "구체적 기록 (예: 4타수 3안타 1홈런 3타점)",
    "reason": "경기 흐름에서의 의미. 결정적 장면. 2~3문장."
  },
  "mvpPitcher": null 또는 { "name": "...", "stats": "...", "reason": "..." },
  "insight": "경기 총평. 양 팀 입장에서 이 경기의 의미. 팬이 기억해야 할 포인트. 시리즈/순위 맥락이 있으면 자연스럽게 포함. 3~4문장.",
  "seriesContext": "시리즈 맥락을 1문장으로 요약. 상태(in_progress/completed/completed_with_cancellation)에 맞는 문구만 사용. 스냅샷의 승수·취소 날짜와 일치해야 함. 시리즈 맥락이 없으면 null. 시리즈 데이터가 1경기 끼리면 null.",
  "standingsImpact": "현재 순위 맥락에서 이 경기의 의미를 한 줄로 (예: '4위 경쟁이 치열한 상황에서 중요한 1승'). 순위 데이터가 없거나 의미 있는 해석이 어려우면 null. 주의: 순위 변동을 단정짓지 마라 — '올라갔다/떨어졌다' 확정은 금지, '~에 유리해졌다/중요한 경기였다' 수준으로."
}`;
}

// ===== Sanitizer =====

function sanitizePlayerNames(data: BoxScoreInput): BoxScoreInput {
  const PLACEHOLDER_RE = /^선수\(\d+\)$/;
  const sanitizeBatters = (batters: BoxScoreInput["awayBatters"], teamName: string) =>
    batters.map((b, i) => PLACEHOLDER_RE.test(b.name) ? { ...b, name: `${teamName} ${i + 1}번째 타자` } : b);
  const sanitizePitchers = (pitchers: BoxScoreInput["awayPitchers"], teamName: string) =>
    pitchers.map((p, i) => PLACEHOLDER_RE.test(p.name) ? { ...p, name: `${teamName} ${i === 0 ? "선발 투수" : `${i + 1}번째 투수`}` } : p);
  return {
    ...data,
    awayBatters: sanitizeBatters(data.awayBatters, data.awayTeam),
    homeBatters: sanitizeBatters(data.homeBatters, data.homeTeam),
    awayPitchers: sanitizePitchers(data.awayPitchers, data.awayTeam),
    homePitchers: sanitizePitchers(data.homePitchers, data.homeTeam),
  };
}

// ===== Cache =====

function cacheKey(gameId: string) {
  return gameId; // pure gameId, no version suffix
}

async function getCached(gameId: string): Promise<{ summary: Record<string, unknown>; outdated: boolean } | null> {
  try {
    const { data } = await supabase
      .from("game_summaries")
      .select("summary, prompt_version")
      .eq("game_id", cacheKey(gameId))
      .maybeSingle(); // cache/optional lookup: no-rowuB294 uC815uC0C1 u2014 406 uBC29uC9C0
    if (!data?.summary) return null;
    const outdated = (data.prompt_version ?? 0) < PROMPT_VERSION;
    return { summary: data.summary as Record<string, unknown>, outdated };
  } catch {
    return null;
  }
}

type GenerationToken = string | number;

async function claimGeneration(gameId: string): Promise<GenerationToken | null> {
  try {
    const { data, error } = await supabase.rpc("claim_game_summary_generation", {
      p_game_id: cacheKey(gameId),
    });
    if (error || (typeof data !== "string" && typeof data !== "number")) return null;
    return data;
  } catch {
    return null;
  }
}

async function saveCache(
  gameId: string,
  summary: Record<string, unknown>,
  generationToken: GenerationToken,
): Promise<"saved" | "superseded" | "error"> {
  try {
    const { data, error } = await supabase.rpc("save_game_summary_if_current", {
      p_game_id: cacheKey(gameId),
      p_generation_token: generationToken,
      p_summary: summary,
      p_prompt_version: PROMPT_VERSION,
    });
    if (error) return "error";
    return data === true ? "saved" : "superseded";
  } catch {
    return "error";
  }
}

// ===== Normalize =====

function cacheFingerprint(s: Record<string, unknown>): SummaryFingerprint | null {
  const value = s._cacheFingerprint as SummaryFingerprint | undefined;
  if (
    value?.status !== "final" ||
    !Number.isFinite(value.awayScore) ||
    !Number.isFinite(value.homeScore) ||
    !Array.isArray(value.awayInnings) ||
    !Array.isArray(value.homeInnings)
  ) {
    return null;
  }
  return value;
}

function normalizeSummary(s: Record<string, unknown>): Record<string, unknown> {
  const gf = s.gameFlow as Record<string, unknown> | undefined;
  if (gf) {
    if (!s.insight && gf.insight) { s.insight = gf.insight; delete gf.insight; }
    if (!s.turningPoint && gf.turningPoint) { s.turningPoint = gf.turningPoint; delete gf.turningPoint; }
    if (!s.mvpBatter && gf.mvpBatter) { s.mvpBatter = gf.mvpBatter; delete gf.mvpBatter; }
    if (!s.mvpPitcher && gf.mvpPitcher) { s.mvpPitcher = gf.mvpPitcher; delete gf.mvpPitcher; }
  }
  return s;
}

function publicSummary(s: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(s);
  delete copy._cacheFingerprint;
  delete copy._cachedAwayScore;
  delete copy._cachedHomeScore;
  return normalizeSummary(copy);
}

// ===== Route handlers =====

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "gameId required" }, { status: 400 });
  // 올스타전은 AI 경기 요약 미제공(팀 기반 분석 무의미 — 승부예측/라인업분석 #544와 일관).
  if (isAllStarGameId(gameId)) return NextResponse.json({ summary: null, source: "allstar" });

  const cached = await getCached(gameId);
  if (cached) {
    return NextResponse.json({
      summary: publicSummary(cached.summary),
      fingerprint: cacheFingerprint(cached.summary),
      source: "cache",
      outdated: cached.outdated,
    });
  }
  return NextResponse.json({ summary: null, source: "none" });
}

export async function POST(req: NextRequest) {
  if (!GEMINI_API_KEY) {
    return NextResponse.json({ error: "GEMINI_API_KEY not configured" }, { status: 500 });
  }

  const requestBody = await req.json() as Partial<BoxScoreInput>;
  if (!requestBody.gameId) {
    return NextResponse.json({ error: "gameId required" }, { status: 400 });
  }
  // 올스타전은 AI 경기 요약 생성 안 함 (#544 AI 비활성화와 일관).
  if (isAllStarGameId(requestBody.gameId)) return NextResponse.json({ summary: null, source: "allstar" });
  // 공개 POST body의 팀/스코어/이닝/박스스코어는 캐시 입력으로 신뢰하지 않는다.
  // gameId만 받아 KBO 경기목록+스코어보드+박스스코어를 서버에서 독립 재조회한다.
  const canonicalSource = await fetchCanonicalSummarySource(requestBody.gameId, true);
  if (canonicalSource.reason !== "ok" || !canonicalSource.input || !canonicalSource.fingerprint) {
    // 삼순 NO-GO ①축: 꼬리 원인 후보였던 *초기 canonical 실패*(final 인데 미수렴·boxscore
    // 불가·조회 실패)도 durable 기록한다. not-final(라이브 중 정상 fail-close)·invalid-gameid 는
    // canonicalFailureStage 가 null 을 돌려 제외된다(지연 경기 유저 POST 노이즈 방지).
    const stage = canonicalFailureStage(canonicalSource.reason);
    if (stage) {
      reportGenerationFailure(requestBody.gameId, stage, `http=${canonicalSource.httpStatus}`);
    }
    return NextResponse.json(
      { error: canonicalSource.reason, source: canonicalSource.reason },
      { status: canonicalSource.httpStatus },
    );
  }
  const body = canonicalSource.input;
  const generationFingerprint = canonicalSource.fingerprint;

  // Canonical boxscore sanity check
  const allBatters = [...(body.awayBatters || []), ...(body.homeBatters || [])];
  const allPitchers = [...(body.awayPitchers || []), ...(body.homePitchers || [])];
  const totalAB = allBatters.reduce((s, b) => s + (b.ab || 0), 0);
  const totalNP = allPitchers.reduce((s, p) => s + (p.np || 0), 0);
  if (allBatters.length > 0 && totalAB === 0 && totalNP === 0) {
    return NextResponse.json({ error: "BoxScore data appears incomplete (all zeros)" }, { status: 422 });
  }

  const finalAwayScore = generationFingerprint.awayScore;
  const finalHomeScore = generationFingerprint.homeScore;

  // prompt_version + final status/score/innings fingerprint가 모두 일치할 때만 캐시를 반환한다.
  const cached = await getCached(body.gameId);
  if (cached && !cached.outdated) {
    if (!isFingerprintStale(cacheFingerprint(cached.summary), generationFingerprint)) {
      return NextResponse.json({
        summary: publicSummary(cached.summary),
        fingerprint: generationFingerprint,
        source: "cache",
      });
    }
    // legacy 또는 fingerprint stale → 아래에서 canonical 데이터로 재생성한다.
  }

  // DB sequence claim이 서버리스 인스턴스 간 생성 순서를 선형화한다.
  // 이후 더 새 claim이 생기면 save RPC의 row-lock token 확인에서 이 요청은 superseded 된다.
  const generationToken = await claimGeneration(body.gameId);
  if (generationToken == null) {
    // 다른 생성이 lease 보유 중 = 정상 backoff 일 수 있으나, 반복되면 "선행 생성이 계속
    // 실패 중" 시그널이라 durable 기록(경보는 임계치 팔터가 걸러줌).
    reportGenerationFailure(body.gameId, "claim-contention", "active lease held by another generation");
    return NextResponse.json(
      { error: "generation-claim-failed", source: "generation-claim" },
      { status: 503 },
    );
  }

  // 맥락 데이터 병렬 조회 (실패해도 진행)
  const meta = parseGameMeta(body.gameId);
  const [seriesCtx, standingsCtx] = await Promise.all([
    meta ? fetchSeriesContext(body.gameId, meta.awayTeamId, meta.homeTeamId).catch(() => null) : Promise.resolve(null),
    meta ? fetchStandingsContext(meta.awayTeamId, meta.homeTeamId).catch(() => null) : Promise.resolve(null),
  ]);

  // Gemini 호출 + 승패 검증 (실패 시 1회 재시도)
  const sanitized = sanitizePlayerNames(body);
  const seriesText = seriesCtx?.text ?? null;
  const seriesStatus = seriesCtx?.status ?? null;
  const prompt = buildPrompt(sanitized, seriesText, standingsCtx);
  const MAX_ATTEMPTS = 2;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const geminiRes = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: attempt === 1 ? 0.7 : 0.3, // 재시도 시 더 보수적으로
            maxOutputTokens: 2560,
            responseMimeType: "application/json",
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      });

      if (!geminiRes.ok) {
        const errText = await geminiRes.text();
        console.error(`Gemini API error (attempt ${attempt}):`, geminiRes.status, errText);
        if (attempt === MAX_ATTEMPTS) {
          reportGenerationFailure(body.gameId, "gemini-api", `http=${geminiRes.status} ${errText.slice(0, 200)}`);
          return NextResponse.json({ error: "Gemini API failed" }, { status: 502 });
        }
        continue;
      }

      const geminiData = await geminiRes.json();
      const parts = geminiData.candidates?.[0]?.content?.parts ?? [];
      const textParts = parts.filter((p: { text?: string }) => p.text);
      const rawText = textParts.length > 0 ? textParts[textParts.length - 1].text : null;

      if (!rawText) {
        if (attempt === MAX_ATTEMPTS) {
          reportGenerationFailure(body.gameId, "gemini-empty", "no text part in response");
          return NextResponse.json({ error: "Empty Gemini response" }, { status: 502 });
        }
        continue;
      }

      let summary;
      try {
        summary = JSON.parse(rawText);
      } catch {
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { summary = JSON.parse(jsonMatch[0]); }
          catch {
            console.error("JSON parse failed:", jsonMatch[0].slice(0, 500));
            if (attempt === MAX_ATTEMPTS) {
              reportGenerationFailure(body.gameId, "gemini-parse", "JSON.parse failed on extracted braces");
              return NextResponse.json({ error: "Invalid Gemini response format" }, { status: 502 });
            }
            continue;
          }
        } else {
          console.error("No JSON found:", rawText.slice(0, 500));
          if (attempt === MAX_ATTEMPTS) {
            reportGenerationFailure(body.gameId, "gemini-parse", "no JSON object in response text");
            return NextResponse.json({ error: "Invalid Gemini response format" }, { status: 502 });
          }
          continue;
        }
      }

      // 정규화
      normalizeSummary(summary);

      // 스코어 검증
      const headlineStr = (summary.headline || "").toLowerCase();
      const isZeroZero = body.awayScore === 0 && body.homeScore === 0;
      const headlineSaysZero = /0대0|0-0/.test(headlineStr) || /득점\s*없/.test(headlineStr);
      if (!isZeroZero && headlineSaysZero) {
        console.error(`Score mismatch (attempt ${attempt}): actual ${body.awayScore}-${body.homeScore}, headline says 0-0.`);
        if (attempt === MAX_ATTEMPTS) {
          reportGenerationFailure(body.gameId, "score-mismatch", `actual ${finalAwayScore}-${finalHomeScore}, headline claims 0-0`);
          return NextResponse.json({ error: "Generated summary score mismatch, discarded" }, { status: 422 });
        }
        continue;
      }

      // 승패 검증 — 패팀을 승자로 잘못 서술한 요약만 reject.
      // 텍스트 스캔은 *헤드라인만* 대상으로 한다. 본문(gameFlow/turningPoint/insight)은
      // 자유 서사라 "롯데의 추격을 꺾기에는 역부족" 같은 부정문·소유격 구문에서
      // 키워드 근접 휴리스틱이 패팀을 승자로 오인 → 정상 요약을 false reject 했다
      // (2026-06-05 한화 9:2 롯데 / 삼성 2:5 KIA 등 다수 경기 "AI 분석 지연").
      // 헤드라인은 단문·구조적이라 신뢰 가능하고, 본문의 구조적 승패 오류는
      // winner 필드 검증(아래)이 백스톱으로 잡는다.
      const llmWinner = summary.winner as string | undefined;
      // winner 필드/무승부 문구 검증(cache-validation, blocker③) + 헤드라인 패팀=승자 서술(winner-check).
      let winnerMismatch = winnerFieldMismatch(
        finalAwayScore, finalHomeScore, body.awayTeam, body.homeTeam, llmWinner, summary.headline,
      );
      if (!winnerMismatch && finalAwayScore !== finalHomeScore) {
        const actualWinner = finalAwayScore > finalHomeScore ? body.awayTeam : body.homeTeam;
        const actualLoser = finalAwayScore > finalHomeScore ? body.homeTeam : body.awayTeam;
        // "롯데, KIA 꼺고 승리"처럼 승팀이 패팀을 타동사로 제압하는 정상 헤드라인은 통과.
        winnerMismatch = loserClaimedWin(summary.headline || "", actualWinner, actualLoser);
      }
      if (winnerMismatch) {
        console.error(`Winner mismatch (attempt ${attempt}): score=${finalAwayScore}-${finalHomeScore}, headline="${summary.headline}", llmWinner=${llmWinner}`);
      }

      if (winnerMismatch) {
        if (attempt === MAX_ATTEMPTS) {
          reportGenerationFailure(body.gameId, "winner-mismatch", `score=${finalAwayScore}-${finalHomeScore} llmWinner=${String(llmWinner)}`);
          return NextResponse.json({ error: "Generated summary winner mismatch after retries, discarded" }, { status: 422 });
        }
        continue;
      }

      // 내부 정합성(산술) 검증 — 주자 상황 환각으로 생긴 모순 reject.
      // 박스스코어엔 주자 상황(만루/주자 수)이 없는데 LLM이 승부처를 극적으로
      // 쓰려고 "2사 만루에서 3점 홈런"처럼 산술 불가능한 장면을 지어내는 사고
      // (2026-06-20 두산 2:4 LG). 본문 전체(자유 서사)를 스캔한다.
      const gfc = summary.gameFlow as Record<string, unknown> | undefined;
      const narrativeParts = [
        summary.headline,
        summary.turningPoint,
        summary.insight,
        gfc?.early, gfc?.mid, gfc?.late,
        (summary.mvpBatter as Record<string, unknown> | undefined)?.reason,
        (summary.mvpPitcher as Record<string, unknown> | undefined)?.reason,
      ].filter((s): s is string => typeof s === "string");
      const consistencyViolation = narrativeParts.some(hasBaseRunnerContradiction);
      if (consistencyViolation) {
        console.error(`Consistency violation (attempt ${attempt}): bases-loaded homer arithmetic. headline="${summary.headline}"`);
        if (attempt === MAX_ATTEMPTS) {
          reportGenerationFailure(body.gameId, "consistency-violation", "bases-loaded homer arithmetic in narrative");
          return NextResponse.json({ error: "Generated summary internal contradiction after retries, discarded" }, { status: 422 });
        }
        continue;
      }

      // 시리즈 완료 상태에서 진행형 표현이 headline에 포함되면 정정
      if (seriesStatus && seriesStatus !== "in_progress" && summary.headline) {
        const progressiveKws = ["발판", "위닝시리즈", "스윕 직전", "리드 굳힘", "추격의"];
        const headlineHasProgressive = progressiveKws.some(kw => summary.headline.includes(kw));
        if (headlineHasProgressive) {
          // headline에서 진행형 시리즈 표현을 포함한 부분 제거 (... 뒤쪽)
          const cleaned = summary.headline.replace(/[.…]{2,3}[^.…]*(?:발판|위닝시리즈|스윕 직전|리드 굳힘|추격의)[^.…]*/g, "").trim();
          console.warn(`Series headline fix (attempt ${attempt}): "${summary.headline}" → "${cleaned}"`);
          summary.headline = cleaned || summary.headline;
        }
      }

      // winner 필드는 내부 검증용이므로 클라이언트에 보내기 전 제거
      delete summary.winner;

      // LLM 호출 중 canonical이 바뀌었으면 이전 요청이 최신 캐시를 덮지 못하게 저장을 거부한다.
      const latestCanonical = await fetchCanonicalSummarySource(body.gameId, false);
      if (
        latestCanonical.reason !== "ok" ||
        !shouldSaveGeneratedSummary(generationFingerprint, latestCanonical.fingerprint)
      ) {
        // final 전이 직후 게임목록↔스코어보드 수렴 시차 구간에서 반복될 수 있는 핵심 관측 대상.
        reportGenerationFailure(
          body.gameId,
          "canonical-race",
          `latest=${latestCanonical.reason} generationFp=${JSON.stringify(generationFingerprint)} latestFp=${JSON.stringify(latestCanonical.fingerprint ?? null)}`,
        );
        return NextResponse.json(
          { error: "canonical-changed-during-generation", source: "canonical-race" },
          { status: 409 },
        );
      }

      // DB JSON 내부에만 보관하고 API 응답에서는 별도 fingerprint 필드로 분리한다.
      summary._cacheFingerprint = generationFingerprint;
      const saveResult = await saveCache(body.gameId, summary, generationToken);
      if (saveResult !== "saved") {
        reportGenerationFailure(
          body.gameId,
          saveResult === "superseded" ? "save-superseded" : "save-failed",
          `token=${String(generationToken)}`,
        );
        return NextResponse.json(
          {
            error: saveResult === "superseded"
              ? "newer-generation-already-saved"
              : "cache-write-failed",
            source: "cache-write-fence",
          },
          { status: saveResult === "superseded" ? 409 : 503 },
        );
      }
      return NextResponse.json({
        summary: publicSummary(summary),
        fingerprint: generationFingerprint,
        source: "generated",
      });
    } catch (err) {
      console.error(`Game summary generation error (attempt ${attempt}):`, err);
      if (attempt === MAX_ATTEMPTS) {
        reportGenerationFailure(body.gameId, "generation-exception", (err as Error)?.message?.slice(0, 200) ?? "unknown");
        return NextResponse.json({ error: "Generation failed" }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ error: "Generation failed after retries" }, { status: 500 });
}
