import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase/admin";
import { TEAMS } from "@/lib/constants/teams";
import { fetchStandings } from "@/lib/crawler/kbo-api";
import { computeSeriesSnapshot, serializeSeriesSnapshot } from "@/lib/series/snapshot";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const PROMPT_VERSION = 11; // v11: 시리즈 게임 순번 명시 (gamePosition) — "첫 경기" 환각 방지

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

  const awayRank = standings.indexOf(awaySt) + 1;
  const homeRank = standings.indexOf(homeSt) + 1;

  return `${awayShort}: ${awayRank}위 (${awaySt.wins}승 ${awaySt.losses}패, 승률 ${awaySt.winRate.toFixed(3)}${awaySt.gamesBehind > 0 ? `, ${awaySt.gamesBehind}게임차` : ", 선두"})
${homeShort}: ${homeRank}위 (${homeSt.wins}승 ${homeSt.losses}패, 승률 ${homeSt.winRate.toFixed(3)}${homeSt.gamesBehind > 0 ? `, ${homeSt.gamesBehind}게임차` : ", 선두"})`;
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
  const loserTeam = awayScore > homeScore ? homeTeam : homeScore > awayScore ? awayTeam : null;
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
  if (standingsCtx) contextSection += `\n## 현재 순위\n${standingsCtx}`;

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
  "turningPoint": "이 경기의 결정적 승부처. 구체적 상황+숫자+왜 경기를 갈랐는지 해석. 무승부여도 가장 팽팽했던 순간. 3~4문장. 반드시 작성. 빈 문자열 절대 금지.",
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
      .single();
    if (!data?.summary) return null;
    const outdated = (data.prompt_version ?? 0) < PROMPT_VERSION;
    return { summary: data.summary as Record<string, unknown>, outdated };
  } catch {
    return null;
  }
}

async function saveCache(gameId: string, summary: Record<string, unknown>) {
  try {
    await supabase
      .from("game_summaries")
      .upsert(
        { game_id: cacheKey(gameId), summary, prompt_version: PROMPT_VERSION, created_at: new Date().toISOString() },
        { onConflict: "game_id" }
      );
  } catch { /* ignore */ }
}

// ===== Normalize =====

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

// ===== Route handlers =====

export async function GET(req: NextRequest) {
  const gameId = req.nextUrl.searchParams.get("gameId");
  if (!gameId) return NextResponse.json({ error: "gameId required" }, { status: 400 });

  const cached = await getCached(gameId);
  if (cached) {
    return NextResponse.json({
      summary: normalizeSummary(cached.summary),
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

  const body: BoxScoreInput = await req.json();
  if (!body.gameId || !body.awayTeam || !body.homeTeam) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Sanity check
  const allBatters = [...(body.awayBatters || []), ...(body.homeBatters || [])];
  const allPitchers = [...(body.awayPitchers || []), ...(body.homePitchers || [])];
  const totalAB = allBatters.reduce((s, b) => s + (b.ab || 0), 0);
  const totalNP = allPitchers.reduce((s, p) => s + (p.np || 0), 0);
  if (allBatters.length > 0 && totalAB === 0 && totalNP === 0) {
    return NextResponse.json({ error: "BoxScore data appears incomplete (all zeros)" }, { status: 422 });
  }

  // 캐시 확인
  const cached = await getCached(body.gameId);
  if (cached && !cached.outdated) {
    return NextResponse.json({ summary: normalizeSummary(cached.summary), source: "cache" });
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
        if (attempt === MAX_ATTEMPTS) return NextResponse.json({ error: "Gemini API failed" }, { status: 502 });
        continue;
      }

      const geminiData = await geminiRes.json();
      const parts = geminiData.candidates?.[0]?.content?.parts ?? [];
      const textParts = parts.filter((p: { text?: string }) => p.text);
      const rawText = textParts.length > 0 ? textParts[textParts.length - 1].text : null;

      if (!rawText) {
        if (attempt === MAX_ATTEMPTS) return NextResponse.json({ error: "Empty Gemini response" }, { status: 502 });
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
            if (attempt === MAX_ATTEMPTS) return NextResponse.json({ error: "Invalid Gemini response format" }, { status: 502 });
            continue;
          }
        } else {
          console.error("No JSON found:", rawText.slice(0, 500));
          if (attempt === MAX_ATTEMPTS) return NextResponse.json({ error: "Invalid Gemini response format" }, { status: 502 });
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
        if (attempt === MAX_ATTEMPTS) return NextResponse.json({ error: "Generated summary score mismatch, discarded" }, { status: 422 });
        continue;
      }

      // 승패 검증 — headline + 본문 전체(insight/turningPoint/gameFlow/standingsImpact)에서 패팀을 승자로 언급하면 reject
      let winnerMismatch = false;
      if (body.awayScore !== body.homeScore) {
        const actualWinner = body.awayScore > body.homeScore ? body.awayTeam : body.homeTeam;
        const actualLoser = body.awayScore > body.homeScore ? body.homeTeam : body.awayTeam;
        const gf = summary.gameFlow as Record<string, string> | undefined;
        const fullText = [
          summary.headline || "",
          summary.insight || "",
          summary.turningPoint || "",
          gf?.early || "",
          gf?.mid || "",
          gf?.late || "",
          summary.standingsImpact || "",
        ].join(" ");
        const winKws = ["승리", "신승", "대승", "완승", "역전승", "끝내기", "이기", "꺾", "잡았", "제압", "대파", "격파", "등극", "위닝시리즈"];
        // 패팀이 목적격 조사(에/를/을/한테/에게) 뒤에 승리 키워드가 오면 패팀은 목적어(오탐 방지)
        // 예: "KIA, 한화에 역전승" = KIA가 이김 (한화는 진 팀)
        const loserClaimedWin = winKws.some(kw => {
          const re = new RegExp(`${actualLoser}(?!에|를|을|한테|에게)[^.!?]{0,20}${kw}`);
          return re.test(fullText);
        });
        // winner 필드 검증
        const llmWinner = summary.winner;
        const winnerFieldWrong = llmWinner && llmWinner !== "무승부" && llmWinner !== actualWinner;

        if (loserClaimedWin || winnerFieldWrong) {
          console.error(`Winner mismatch (attempt ${attempt}): actual=${actualWinner}, headline="${summary.headline}", llmWinner=${llmWinner}`);
          winnerMismatch = true;
        }
      }

      if (winnerMismatch) {
        if (attempt === MAX_ATTEMPTS) {
          return NextResponse.json({ error: "Generated summary winner mismatch after retries, discarded" }, { status: 422 });
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

      await saveCache(body.gameId, summary);
      return NextResponse.json({ summary, source: "generated" });
    } catch (err) {
      console.error(`Game summary generation error (attempt ${attempt}):`, err);
      if (attempt === MAX_ATTEMPTS) {
        return NextResponse.json({ error: "Generation failed" }, { status: 500 });
      }
    }
  }

  return NextResponse.json({ error: "Generation failed after retries" }, { status: 500 });
}
