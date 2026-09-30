import type { GameConversationInput } from "./game-conversation";
import { LIVE_TEAM_BLOCK_MAX_AGE_MS, type StandingsSnapshot } from "./stats/team-record";

export interface AppFactSnapshot {
  tomorrow: { date: string; games: GameConversationInput["games"] };
  standings: StandingsSnapshot | null;
}

export const APP_FACT_PROMPT = `관람 외에도 현재 앱 데이터로 답할 요청은 action=app_facts로 판정합니다. 단어 출현이 아니라 현재 질문 전체의 목적과 직전 문맥을 해석합니다.
appRequest.kind는 schedule(경기 일정), starters(특정 경기 선발투수), standings(현재 순위/전적), postseason(지금의 가을야구 진출 가능성), lineup(현재 경기 타순/타자), prediction(앞으로 경기 승패 예상), none 중 하나입니다.
appRequest.period는 today/tomorrow/current/unsupported입니다. 명시된 오늘·내일을 보존하고, 시점 없는 일정은 current(오늘과 내일 범위), 순위·진출은 current입니다. 그 밖의 날짜/과거 시즌/주간·월간 일정은 unsupported이며 임의로 오늘로 바꾸지 않습니다. 단어 뜻·규칙·과거 기록·사건·감독·행사·불꽃놀이 정보는 app_facts가 아니라 other입니다. 포스트시즌 시작 날짜는 진출 가능성(postseason)이 아닙니다.
appRequest.quote는 현재 발화에서 요청 의도를 드러내는 원문 그대로입니다. 후속이면 생략된 목적만 직전 질문으로 해석하되 quote에는 현재 발화를 인용합니다.
사실 답변·숫자·경기 인덱스는 생성하지 않습니다. target에는 원문에 결속된 대상 조건만 씁니다. 현재 발화에 팀이 있으면 target.source=question이며 모든 현재 팀을 teams/excludedTeams/backgroundTeams 역할 중 하나에 넣습니다. 배경 팬은 조회 조건이 아닙니다. 대상이 생략된 후속이면 context_question, 그 밖의 대상 생략은 profile을 쓸 수 있습니다. 전체 일정/순위 요청이면 target.source=none, teams=[]입니다.
두 팀의 맞대결 요청이면 teams에 두 팀을 모두 넣습니다. 자료가 없거나 선발 미발표여도 요청 종류를 바꾸지 않습니다. 코드는 미조회·빈 일정·미발표를 구별합니다.
lineup은 현재 연결된 데이터에 타순이 없으므로 옛 라인업 대신 확인 불가와 실제 경기만 안내합니다. prediction/postseason은 승패/진출을 단정하지 않고 실제 경기/현재 순위만 안내합니다. 조회 결과가 질문을 바꾸지는 않습니다.
app_facts에서는 attendanceEvidence="", evidenceSource=none입니다. 이 evidenceSource는 관람 근거만 뜻하며 target.source와 무관합니다. 현재 질문의 teamNames.question은 코드가 조회 대상으로 사용합니다. 모델은 제외·배경 역할을 원문에 근거해 구분하며, evidenceSource=none 때문에 target을 비우지 않습니다. 현재 시각·영업시간 등 야구와 무관한 시간 질문은 other이며, 앱 일정이나 프로필을 보고 야구 질문으로 바꾸지 않습니다. 기존 관람 계획은 원래 match/clarify/other 계약을 유지합니다. 행사 정보 요청을 관람 계획으로 간주하지 않습니다. app_facts가 아니면 appRequest={kind:"none",period:"unsupported",quote:""}입니다.`;

export const APP_REQUEST_SCHEMA = { type: "OBJECT", properties: {
  kind: { type: "STRING", enum: ["schedule", "starters", "standings", "postseason", "lineup", "prediction", "none"] },
  period: { type: "STRING", enum: ["today", "tomorrow", "current", "unsupported"] },
  quote: { type: "STRING" },
}, required: ["kind", "period", "quote"] } as const;

/** Source projection, not generated facts. Unknown date/entity/provenance never
 * becomes today's schedule or a claim that a game/team does not exist. */
export function renderAppFacts(value: Record<string, unknown>, input: GameConversationInput):
  { answer: string; source: "kbo_structured" | "context_missing" | "history_hold" } | null {
  const req = value.appRequest as Record<string, unknown> | undefined;
  const target = value.target as Record<string, unknown> | undefined;
  if (!req || !target || typeof req.quote !== "string" || !req.quote.trim() || !input.question.includes(req.quote)) return null;
  if (!["schedule", "starters", "standings", "postseason", "lineup", "prediction"].includes(String(req.kind))
    || !["today", "tomorrow", "current", "unsupported"].includes(String(req.period))) return null;
  const hold = (answer: string) => ({ answer, source: "history_hold" as const });
  const clarify = () => ({ answer: "어느 구단이나 경기의 정보를 원하시나요?", source: "context_missing" as const });
  if (req.period === "unsupported") return hold("현재 이 대화에서 확인할 수 있는 범위는 오늘·내일 경기와 현재 순위입니다. 요청하신 기간을 이 범위로 바꾸어 답하지 않겠습니다.");
  const source = target.source;
  if (!["question", "context_question", "profile", "none"].includes(String(source)) || typeof target.quote !== "string") return null;
  const hasCurrentTeams = input.teamNames.question.length > 0;
  const sourceText = hasCurrentTeams || source === "question" ? input.question : source === "context_question" ? input.context?.question : source === "profile" ? input.favoriteTeam : "";
  if (!hasCurrentTeams && source !== "none" && (!target.quote.trim() || !sourceText?.includes(target.quote))) return null;
  for (const key of ["teams", "excludedTeams", "backgroundTeams", "excludedStadiums"]) {
    if (!Array.isArray(target[key]) || !(target[key] as unknown[]).every((x) => typeof x === "string")) return null;
  }
  if (typeof target.stadium !== "string") return null;
  const proposedTeams = target.teams as string[], excluded = target.excludedTeams as string[], background = target.backgroundTeams as string[];
  const names = hasCurrentTeams ? input.teamNames.question : source === "none" ? [] : input.teamNames[source as keyof typeof input.teamNames];
  if ([...proposedTeams, ...excluded, ...background].some((t) => !names.includes(t))) return clarify();
  if ((excluded.length || background.length) && (!target.quote.trim() || !sourceText?.includes(target.quote))) return clarify();
  if (proposedTeams.some((t) => excluded.includes(t) || background.includes(t)) || excluded.some((t) => background.includes(t))) return clarify();
  // Current lexical entities own the lookup even when the model omits target.
  // Only grounded exclusion/background roles may subtract them.
  const teams = hasCurrentTeams ? names.filter((t) => !excluded.includes(t) && !background.includes(t)) : proposedTeams;
  // Do not turn an unsupported model entity into a lookup of every game.
  if ((hasCurrentTeams || source !== "none") && !teams.length && !excluded.length && !target.stadium) return clarify();
  const stadium = target.stadium;
  const excludedStadiums = target.excludedStadiums as string[];
  if ((stadium && !sourceText?.includes(stadium)) || excludedStadiums.some((s) => !s.trim() || !sourceText?.includes(s))) return clarify();
  if (stadium && excludedStadiums.includes(stadium)) return clarify();
  const currentVenues = [...new Set([...(input.games ?? []), ...(input.appFacts?.tomorrow.games ?? [])].map((g) => g.stadium))]
    .filter((s) => s && input.question.includes(s));
  if (currentVenues.some((s) => s !== stadium && !excludedStadiums.includes(s))) return clarify();
  if (req.kind === "standings" || req.kind === "postseason") {
    if (req.period !== "current" && req.period !== "today") return hold("미래 순위나 진출 여부는 현재 순위표로 확정할 수 없습니다.");
    const snapshot = input.appFacts?.standings;
    const now = input.nowMs;
    const fetchedAt = snapshot?.fetchedAt ? Date.parse(snapshot.fetchedAt) : NaN;
    if (!snapshot || now === undefined || !Number.isFinite(fetchedAt) || fetchedAt > now
      || now - fetchedAt > LIVE_TEAM_BLOCK_MAX_AGE_MS || snapshot.season !== Number(input.date.slice(0, 4))) {
      return hold("현재 시즌의 최신 순위표를 확인하지 못했습니다. 과거 순위를 현재 순위로 안내하지 않겠습니다.");
    }
    const selected = snapshot.rows.filter((r) => (!teams.length || teams.includes(r.teamName)) && !excluded.includes(r.teamName));
    if (!selected.length || teams.some((t) => !selected.some((r) => r.teamName === t))
      || selected.some((r) => !Number.isInteger(r.ranking) || r.ranking < 1 || r.ranking > 10
        || ![r.wins, r.losses, r.draws].every((n) => Number.isInteger(n) && n >= 0))) {
      return hold("요청하신 구단의 현재 순위·전적을 확인하지 못했습니다.");
    }
    const prefix = req.kind === "postseason" ? "현재 순위만으로 포스트시즌 진출 확정이나 탈락을 판단하지 않겠습니다.\n" : "";
    return { answer: prefix + `${input.date} 확인한 앱 순위표입니다.\n` + selected.map((r) =>
      `· ${r.teamName}: ${r.ranking}위, ${r.wins}승 ${r.losses}패 ${r.draws}무`).join("\n"), source: "kbo_structured" };
  }
  const tomorrowDate = new Date(Date.parse(`${input.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const tomorrow = input.appFacts?.tomorrow;
  const slots = req.period === "tomorrow" ? [{ date: tomorrowDate, games: tomorrow?.date === tomorrowDate ? tomorrow.games : null }]
    : req.period === "current" && req.kind === "schedule"
      ? [{ date: input.date, games: input.games }, { date: tomorrowDate, games: tomorrow?.date === tomorrowDate ? tomorrow.games : null }]
      : [{ date: input.date, games: input.games }];
  const lines: string[] = [];
  if (req.kind === "prediction") lines.push("승패를 예측해 단정할 수는 없지만, 확인된 경기 일정과 선발 정보를 안내하겠습니다.");
  if (req.kind === "lineup") lines.push("현재 타순·타자 라인업은 이 답변의 데이터에 연결되어 있지 않아 확인할 수 없습니다. 과거 라인업으로 대신 답하지 않겠습니다.");
  let partial = req.kind === "lineup";
  for (const slot of slots) {
    if (slot.games === null) { lines.push(`${slot.date} 경기 일정을 조회하지 못했습니다.`); partial = true; continue; }
    const games = slot.games.filter((g) => teams.every((t) => t === g.awayName || t === g.homeName)
      && !excluded.some((t) => t === g.awayName || t === g.homeName) && (!stadium || stadium === g.stadium)
      && !excludedStadiums.includes(g.stadium));
    if (!games.length) { lines.push(`${slot.date} 앱 일정에 ${teams.length || stadium ? "요청하신 대상의 " : ""}등록된 경기가 없습니다.`); continue; }
    lines.push(`${slot.date} 경기 일정:`);
    for (const g of games) {
      const status: Record<string, string> = { scheduled: "예정", live: "진행 중", final: "종료", cancelled: "취소" };
      lines.push(`· ${g.awayName} vs ${g.homeName} — ${g.stadium || "구장 확인 중"}, ${g.time || "시각 확인 중"} (${status[g.status] ?? "상태 확인 중"})`);
      if (req.kind === "starters" || req.kind === "prediction") {
        if (g.status === "cancelled") { lines.push("  취소 경기이므로 예고 선발을 출전 예정으로 안내하지 않습니다."); continue; }
        if (!g.starterSourceOk) { lines.push("  선발 정보의 출처를 확인하지 못했습니다."); partial = true; continue; }
        const pair = [[g.awayName, g.awayStarterName], [g.homeName, g.homeStarterName]];
        lines.push("  선발: " + pair.filter(([team]) => req.kind !== "starters" || !teams.length || teams.includes(team!))
          .map(([team, name]) => `${team} ${name || "미발표"}`).join(" / "));
      }
    }
  }
  return { answer: lines.join("\n"), source: partial ? "history_hold" : "kbo_structured" };
}
