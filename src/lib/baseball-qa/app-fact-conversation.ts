import { renderAppLineup } from "./app-lineup";
import { bindConversationTeamCandidates } from "./conversation-team-candidates";
import type { GameConversationInput, ConversationEntityResolver } from "./game-conversation";
import { LIVE_TEAM_BLOCK_MAX_AGE_MS, type StandingsSnapshot } from "./stats/team-record";

export interface AppFactSnapshot {
  tomorrow: { date: string; games: GameConversationInput["games"] };
  standings: StandingsSnapshot | null;
}

export const APP_FACT_PROMPT = `관람 외에도 현재 앱 데이터로 답할 요청은 action=app_facts로 판정합니다. 단어 출현이 아니라 현재 질문 전체의 목적과 직전 문맥을 해석합니다.
판정 순서는 현재 발화의 요청 사실 → action/appRequest → 대상(target)입니다. 현재 발화 자체가 아래 지원 사실(game_schedule/starting_pitchers/team_standing/qualification/batting_order/match_prediction)을 요청할 때만 직전 대화가 무관하거나 대상을 식별하지 못해도 action=app_facts, intentSource=question으로 현재 요청을 보존합니다. 웃음이 섞여도 실제 요청을 none으로 지우지 않습니다. 대상 미확정이나 라인업 데이터 미연결은 요청 부재가 아니며 other로 바꾸는 이유가 아닙니다. 코드가 대상과 데이터 가용성을 처리합니다.
appRequest.informationNeed를 kind보다 먼저 판단합니다. 사용자가 원하는 사실은 game_schedule(개별 경기 일정/시간), starting_pitchers(선발투수), team_standing(순위/전적), qualification(구단의 진출 가능성), batting_order(타순), match_prediction(승패 예상), event_date(대회·행사 시작/종료 날짜), player_availability(선수의 부상·재활·복귀·등록 상태/시점), none 중 하나입니다. 대회의 시작 시점을 묻는 요청은 event_date이며 팀의 진출 가능성이나 오늘 경기 일정으로 바꾸지 않습니다. event_date와 player_availability는 action=other로 문서 근거 경로에 양보합니다. 선수가 언제 복귀하거나 등록되는지는 경기 개최 시점이나 그 경기의 선발 명단과 다른 사실입니다. 경기 일정·선발 데이터로 선수의 복귀를 대신 답하지 않습니다. 지원 사실이 아니면 야구 관련 요청이어도 app_facts로 보존하지 않습니다. 짧은 후속도 직전 질문에서 생략된 요청 사실만 보완합니다.
appRequest.kind는 schedule(경기 일정), starters(특정 경기 선발투수), standings(현재 순위/전적), postseason(지금의 가을야구 진출 가능성), lineup(현재 경기 타순/타자), prediction(앞으로 경기 승패 예상), none 중 하나입니다.
appRequest.period는 today/tomorrow/current/unsupported입니다. 명시된 오늘·내일을 보존하고, 시점 없는 일정은 current(오늘과 내일 범위), 순위·진출은 current입니다. 그 밖의 날짜/과거 시즌/주간·월간 일정은 unsupported이며 임의로 오늘로 바꾸지 않습니다. 단어 뜻·규칙·과거 기록·사건·감독·행사·불꽃놀이 정보는 app_facts가 아니라 other입니다. 포스트시즌 시작 날짜는 진출 가능성(postseason)이 아닙니다.
팀/구장 이름만 있고 현재 또는 직전 질문에 앱 데이터 요청이 없으면 action=other입니다. 프로필·games의 존재는 요청 근거가 아닙니다. 단독 구단 소개·이름 정정은 일정 요청이 아닙니다.
appRequest.intentSource는 question/context_question/none이며 intentQuote에는 일정·선발·순위 등 원하는 사실을 드러내는 원문 구절을 복사합니다. 구단명만은 요청 근거가 아닙니다. 생략된 후속의 요청 목적은 직전 질문의 실제 요청에서만 가져오며 이 경우 context_question으로 표시합니다. 요청 근거가 없으면 none, 빈 문자열이며 app_facts로 처리하지 않습니다. 현재 발화가 원하는 사실이 바뀌면 현재 요청이 우선합니다. 출전 선수 전체를 묻는 요청은 선발투수만으로 축소하지 않고 lineup으로 분류합니다.
appRequest.quote는 현재 발화에서 요청 의도를 드러내는 원문 그대로입니다. 후속이면 생략된 목적만 직전 질문으로 해석하되 quote에는 현재 발화를 인용합니다.
사실 답변·숫자·경기 인덱스는 생성하지 않습니다. target에는 원문에 결속된 대상 조건만 씁니다. 현재 발화에 팀이 있으면 target.source=question이며 모든 현재 팀을 teams/excludedTeams/backgroundTeams 역할 중 하나에 넣습니다. 배경 팬은 조회 조건이 아닙니다. 같은 야구 경기에 관한 후속이고 현재 대상이 생략된 경우에만 context_question으로 직전 질문의 구단을 유지합니다. 직전 대화가 회사 등 무관한 주제면 그 대상은 버리되 현재의 명시적 앱 요청은 유지합니다. 사용 가능한 대상·프로필이 없으면 target.source=none과 빈 대상 조건으로 반환합니다. 요청 사실이 선발투수에서 출전 선수로 바뀌어도 같은 경기의 대상은 유지합니다. 현재 명시한 다른 팀이나 전체 경기 요청이 우선이며 무관한 주제에서는 이전 구단을 가져오지 않습니다. 그 밖의 대상 생략은 profile을 쓸 수 있습니다. 전체 일정/순위 요청이면 target.source=none, teams=[]입니다.
지시어(거기/그 경기/그 팀)는 새 구단명이 아닙니다. 같은 경기의 후속이면 target.source=context_question으로 두고 직전 사용자 질문이 명시한 조회 대상만 유지합니다. 직전 답변이나 games에 나온 상대팀·구장을 target.teams/stadium에 추가하지 않습니다. 한 구단을 물었던 후속은 그 구단 조건 하나로 실제 경기를 찾고, 두 구단의 맞대결을 명시했던 후속만 두 조건을 유지합니다. target.quote도 직전 사용자 질문의 원문이며 답변에서 가져오지 않습니다. 현재 명시한 구단·전체 요청·주제 전환은 이 계승보다 우선합니다.
기간만 바꾼 짧은 후속은 직전 사용자 질문의 지원 요청 사실과 조회 대상을 유지하고 현재의 기간만 적용합니다. 이때 intentSource=context_question, intentQuote는 직전 질문의 요청 원문, appRequest.quote는 현재 기간 발화입니다. 직전 요청이 무관하거나 없으면 경기 요청을 만들어내지 않으며, 지원하지 않는 기간은 unsupported를 유지합니다.
두 팀의 맞대결 요청이면 teams에 두 팀을 모두 넣습니다. 자료가 없거나 선발 미발표여도 요청 종류를 바꾸지 않습니다. 코드는 미조회·빈 일정·미발표를 구별합니다.
lineup은 요청한 날짜·경기에 결속된 선발 타순만 코드가 조회합니다. 현재 타석·경기 중 교체 선수 요청은 선발 타순으로 대체하지 않고 action=other, informationNeed=none으로 양보합니다. 모델은 타자명이나 타순을 생성하지 않습니다. prediction/postseason은 승패/진출을 단정하지 않고 실제 경기/현재 순위만 안내합니다. 조회 결과가 질문을 바꾸지는 않습니다.
app_facts에서는 attendanceEvidence="", evidenceSource=none입니다. 이 evidenceSource는 관람 근거만 뜻하며 target.source와 무관합니다. 현재 질문의 teamNames.question은 코드가 조회 대상으로 사용합니다. 모델은 제외·배경 역할을 원문에 근거해 구분하며, evidenceSource=none 때문에 target을 비우지 않습니다. 현재 시각·영업시간 등 야구와 무관한 시간 질문은 other이며, 앱 일정이나 프로필을 보고 야구 질문으로 바꾸지 않습니다. 기존 관람 계획은 원래 match/clarify/other 계약을 유지합니다. 행사 정보 요청을 관람 계획으로 간주하지 않습니다. app_facts가 아니면 kind="none", period="unsupported", intentSource="none", intentQuote=""입니다. event_date/player_availability 요청은 각각의 informationNeed와 현재 요청 원문 quote를 유지하며, 그 외에는 informationNeed="none", quote=""입니다.`;

export const APP_REQUEST_SCHEMA = { type: "OBJECT", properties: {
  informationNeed: { type: "STRING", enum: ["game_schedule", "starting_pitchers", "team_standing", "qualification", "batting_order", "match_prediction", "event_date", "player_availability", "none"] },
  kind: { type: "STRING", enum: ["schedule", "starters", "standings", "postseason", "lineup", "prediction", "none"] },
  period: { type: "STRING", enum: ["today", "tomorrow", "current", "unsupported"] },
  quote: { type: "STRING" },
  intentSource: { type: "STRING", enum: ["question", "context_question", "none"] },
  intentQuote: { type: "STRING" },
}, required: ["informationNeed", "kind", "period", "quote", "intentSource", "intentQuote"] } as const;

/** Source projection, not generated facts. Unknown date/entity/provenance never
 * becomes today's schedule or a claim that a game/team does not exist. */
export function renderAppFacts(value: Record<string, unknown>, input: GameConversationInput, entities?: ConversationEntityResolver):
  { answer: string; source: "kbo_structured" | "context_missing" | "history_hold" } | null {
  const req = value.appRequest as Record<string, unknown> | undefined;
  const target = value.target as Record<string, unknown> | undefined;
  if (!req || !target || typeof req.quote !== "string" || !req.quote.trim() || !input.question.includes(req.quote)) return null;
  const intentText = req.intentSource === "question" ? input.question
    : req.intentSource === "context_question" ? input.context?.question : undefined;
  if (typeof req.intentQuote !== "string" || !req.intentQuote.trim() || !intentText?.includes(req.intentQuote)) return null;
  // The request and its entity have independent provenance; a team mention
  // alone cannot authorize a schedule inferred from the available snapshot.
  if (entities?.isBare(req.intentQuote)) return null;
  if (!["schedule", "starters", "standings", "postseason", "lineup", "prediction"].includes(String(req.kind))
    || !["today", "tomorrow", "current", "unsupported"].includes(String(req.period))) return null;
  // Project the requested fact onto the app capability. A date request cannot
  // be served by standings even if the model proposes kind=postseason.
  const capability: Record<string, string> = {
    game_schedule: "schedule", starting_pitchers: "starters", team_standing: "standings",
    qualification: "postseason", batting_order: "lineup", match_prediction: "prediction",
  };
  if (typeof req.informationNeed !== "string"
    || !Object.hasOwn(capability, req.informationNeed) || capability[req.informationNeed] !== req.kind) return null;
  const hold = (answer: string) => ({ answer, source: "history_hold" as const });
  const clarify = () => ({ answer: "어느 구단이나 경기의 정보를 원하시나요?", source: "context_missing" as const });
  if (req.period === "unsupported") return hold("현재 이 대화에서 확인할 수 있는 범위는 오늘·내일 경기와 현재 순위입니다. 요청하신 기간을 이 범위로 바꾸어 답하지 않겠습니다.");
  const source = target.source;
  if (!["question", "context_question", "profile", "none"].includes(String(source)) || typeof target.quote !== "string") return null;
  for (const key of ["teams", "excludedTeams", "backgroundTeams", "excludedStadiums"]) {
    if (!Array.isArray(target[key]) || !(target[key] as unknown[]).every((x) => typeof x === "string")) return null;
  }
  if (typeof target.stadium !== "string") return null;
  const proposedTeams = target.teams as string[], excluded = target.excludedTeams as string[], background = target.backgroundTeams as string[];
  // Current resolver evidence keeps precedence independently of mention quality.
  const bindingSource = input.teamNames.question.length ? "question" : source;
  // Missing prior context yields to the general path, before candidate binding.
  if (bindingSource === "context_question" && !input.context?.question) return null;
  const lexicalNames = bindingSource === "none" ? [] : input.teamNames[bindingSource as keyof typeof input.teamNames];
  const bound = bindConversationTeamCandidates(input.teamCandidates ?? [], target.mentions,
    input.question, input.context?.question, bindingSource, lexicalNames,
    { target: proposedTeams, excluded, background });
  if (!bound) return clarify();
  const teamNames = { ...input.teamNames,
    question: [...new Set([...input.teamNames.question, ...bound.question])],
    context_question: [...new Set([...input.teamNames.context_question, ...bound.context_question])],
  };
  const candidateBound = bound.question.length + bound.context_question.length > 0;
  const hasCurrentTeams = teamNames.question.length > 0;
  const sourceText = hasCurrentTeams || source === "question" ? input.question : source === "context_question" ? input.context?.question : source === "profile" ? input.favoriteTeam : "";
  if (!hasCurrentTeams && !candidateBound && source !== "none" && (!target.quote.trim() || !sourceText?.includes(target.quote))) return null;
  const names = hasCurrentTeams ? teamNames.question : source === "none" ? [] : teamNames[source as keyof typeof teamNames];
  for (const [role, selected] of [["target", proposedTeams], ["excluded", excluded], ["background", background]] as const) {
    if (bound.roles[role].some((team) => !selected.includes(team))) return clarify();
  }
  if ([...proposedTeams, ...excluded, ...background].some((t) => !names.includes(t))) return clarify();
  const allRolesBound = excluded.every((team) => bound.roles.excluded.includes(team))
    && background.every((team) => bound.roles.background.includes(team));
  if (!allRolesBound && (excluded.length || background.length) && (!target.quote.trim() || !sourceText?.includes(target.quote))) return clarify();
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
  let partial = false;
  for (const slot of slots) {
    if (slot.games === null) { lines.push(`${slot.date} 경기 일정을 조회하지 못했습니다.`); partial = true; continue; }
    const games = slot.games.filter((g) => teams.every((t) => t === g.awayName || t === g.homeName)
      && !excluded.some((t) => t === g.awayName || t === g.homeName) && (!stadium || stadium === g.stadium)
      && !excludedStadiums.includes(g.stadium));
    if (!games.length) { lines.push(`${slot.date} 앱 일정에 ${teams.length || stadium ? "요청하신 대상의 " : ""}등록된 경기가 없습니다.`); continue; }
    if (req.kind === "lineup") entities?.onLineupGames?.(games.filter((g) => g.status !== "cancelled"), slot.date);
    lines.push(`${slot.date} 경기 일정:`);
    for (const g of games) {
      const status: Record<string, string> = { scheduled: "예정", live: "진행 중", final: "종료", cancelled: "취소" };
      lines.push(`· ${g.awayName} vs ${g.homeName} — ${g.stadium || "구장 확인 중"}, ${g.time || "시각 확인 중"} (${status[g.status] ?? "상태 확인 중"})`);
      if (req.kind === "lineup") {
        if (g.status === "cancelled") {
          lines.push("  취소 경기이므로 타순을 출전 예정으로 안내하지 않습니다.");
          continue;
        }
        const lineup = renderAppLineup(g.gameId ? input.lineups?.[g.gameId] : undefined, g, slot.date, input.nowMs, teams);
        if (lineup) {
          lines.push(...lineup);
          lines.push("  경기 시작 선발 타순이며, 경기 중 교체·현재 타석을 뜻하지 않습니다.");
        } else {
          lines.push("  해당 경기의 확정 타순을 확인하지 못했습니다. 과거 라인업으로 대신 답하지 않겠습니다.");
          partial = true;
        }
      }
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
