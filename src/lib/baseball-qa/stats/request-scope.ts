import { LIVE_TEAM_BLOCK_MAX_AGE_MS, kstSeasonOf, type StandingsSnapshot } from "./team-record";

export interface TransferPeriodContext { version: 1; playerId: string; playerName: string }
export function readTransferPeriodContext(value: unknown): TransferPeriodContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.playerId !== "string" || !/^\d{5}$/.test(row.playerId)
    || typeof row.playerName !== "string" || !/^[가-힣A-Za-z· .-]{2,40}$/.test(row.playerName)) return undefined;
  return { version: 1, playerId: row.playerId, playerName: row.playerName };
}

/** A scope is part of a record request, never permission to substitute a
 * season total. This detects an explicit event boundary, not the truth of the
 * user's transfer premise. No event date or split statistic is invented. */
export function asksTransferPeriod(question: string): boolean {
  const q = question.normalize("NFKC");
  // Explanations/evaluations are not requests for an event-split value.
  if (/(?:뜻|정의|의미|왜|이유|평가|어때|좋|나쁘|나쁜|나빠|잘하|잘해|못하|못해|부진|활약)/.test(q)) return false;
  return /(?:기록|타율|안타|홈런|타점|성적|방어율|평균자책|출루율|장타율|OPS|ERA|WHIP)/i.test(q)
    && /(?:이적|트레이드)(?:한|하고|을\s*한)?\s*(?:이후|후|뒤)|(?:로|으로|에)\s*(?:오고|온|와서|옮기고|옮긴)\s*(?:나서|이후|후|뒤)/.test(q);
}

export function transferPeriodAnswer(playerName?: string): string {
  const subject = playerName ? `${playerName} 선수의 ` : "";
  return `${subject}이적 이후 기록을 따로 물으신 것으로 이해했습니다. 현재 기록 자료에서는 이적일 이후 구간을 분리해 확인할 수 없어 수치를 안내하기 어렵습니다. 시즌 누적 기록은 이적 이후 기록과 같다고 볼 수 없습니다.`;
}

/** A narrow completeness check, not a fact checker or a license for numbers.
 * Grounding validation must still run first. General eligibility is assessed
 * semantically by the official prompt; no FA rule is hard-coded here. */
export function requiredAnswerCounter(question: string): "회" | "위" | null {
  const q = question.normalize("NFKC");
  if (/(?:연장|이닝)/.test(q) && /몇\s*회|최대|한도/.test(q)) return "회";
  if (/몇\s*위.*(?:진출|가을|포스트)|(?:진출|가을|포스트).*몇\s*위|(?:가을야구|포스트시즌)\s*진출\s*(?:기준|조건)/.test(q)) return "위";
  return null;
}

/** A rank cutoff and a number of qualifying teams are equivalent answer
 * forms; unrelated quantities (e.g. hits) do not satisfy this requirement.
 * This runs only AFTER the existing numeric grounding validator. */
export function hasPostseasonCutoff(answer: string): boolean {
  const number = "(?:\\d+|(?<![가-힣])(?:[일이삼사오육칠팔구십]+|한|두|세|네|다섯|여섯|일곱|여덟|아홉|열))";
  return new RegExp(`${number}\\s*(?:위|개\\s*(?:팀|구단)|팀|구단)`).test(answer);
}

/** Location/calendar dimensions are not additional club names. Until this
 * bot has a split-record data seam, don't replace them with season totals. */
export function asksTeamRecordSubscope(question: string): boolean {
  return /전적/.test(question) && /(?:^|\s)(?:홈|원정|\d{1,2}\s*월|주말|주중)(?:\s|전적|의)/.test(question);
}

export interface ScopeTeam {
  canonical: string;
  teamId: number;
  shorts: readonly string[];
  nicks: readonly string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function teamPattern(team: ScopeTeam): string {
  return [...new Set([team.canonical, ...team.shorts, ...team.nicks])]
    .sort((a, b) => b.length - a.length).map(escape).join("|");
}

/** The two noun slots in a terse record request must both bind. An unknown
 * slot is not silently erased (e.g. 힌화 두산 전적). No automatic typo correction. */
export function unresolvedRecordSubject(question: string, teams: readonly ScopeTeam[]): boolean {
  const q = question.normalize("NFKC").toLowerCase().trim();
  const match = q.match(/^(.+?)\s+(?:상대\s*)?전적(?:은|는|이|을)?(?:\s*(?:알려줘|알려주세요|어때|어때요))?[?!.~]*$/);
  if (!match) return false;
  const subjects = match[1].split(/\s+(?:vs\.?\s+)?|\s*(?:와|과|랑|이랑)\s*/i).filter(Boolean);
  if (subjects.length < 2 || subjects.length > 3) return false;
  const isTeam = (s: string) => teams.some((team) => new RegExp(`^(?:${teamPattern(team)})$`, "i").test(s));
  const known = subjects.filter(isTeam);
  const other = subjects.filter((s) => !isTeam(s));
  // These words specify season/league scope, not another subject.
  return known.length === 1 && other.some((s) => !/^(?:현재|지금|오늘|올해|이번|시즌|정규시즌|전체|통산|역대|최근|맞대결|상대|\d{4}년?)$/.test(s));
}

export type AssumedResult = "win" | "loss" | "draw";
export interface StandingAssumption { team: ScopeTeam; result: AssumedResult }
export type CounterfactualIntent = { kind: "none" } | { kind: "incomplete" } |
  { kind: "pair"; assumptions: [StandingAssumption, StandingAssumption] };

/** Only a fully bound pair of explicit, single-game W/L/D clauses is
 * executable. Other conditional ranking questions request missing operands;
 * they must not fall through to the current standings scalar handler. */
export function resolveCounterfactual(question: string, teams: readonly ScopeTeam[]): CounterfactualIntent {
  const q = question.normalize("NFKC").toLowerCase();
  // A general rule ("무승부면 순위는 어떻게 정해?") has no club operands
  // and stays with official-rule answering, not the simulation input form.
  if (!teams.some((team) => new RegExp(`(?:^|[\\s,])(?:${teamPattern(team)})(?:은|는|이|가|와|과|랑|이랑)?(?=$|[\\s,?!])`, "i").test(q))) return { kind: "none" };
  if (!/(?:동률|동룰|승률|게임\s*차|경기\s*차|순위|몇\s*위)/.test(q)
    || !/(?:면|경우|가정)/.test(q)
    || !/(?:이기|이겨|지면|지고|져|패배|승리|비기|비겨|무승부)/.test(q)) return { kind: "none" };
  if (/(?:않|아니|못|말고|거나|또는|만약에라도|연승|연패|전승|전패|남은|남아|통산|작년|지난|내년|어제|포스트|시범|한국시리즈|플레이오프|\d+\s*(?:승|패|무|경기))/.test(q)) return { kind: "incomplete" };
  const assumptions: StandingAssumption[] = [];
  const results: [AssumedResult, string][] = [
    ["win", "(?:이기|이겨|승리하|승리한다)"],
    ["loss", "(?:지|져|패배하|패배한다)"],
    ["draw", "(?:비기|비겨|무승부하|무승부가\s*되|무승부로\s*끝나)"],
  ];
  for (const team of teams) {
    for (const [result, verb] of results) {
      const re = new RegExp(`(?:^|[\\s,])(?:${teamPattern(team)})(?:은|는|이|가)?\\s*${verb}(?:고|면|서|다면|한다면)(?=$|[\\s,?!])`, "gi");
      for (const _match of q.matchAll(re)) { void _match; assumptions.push({ team, result }); }
    }
  }
  if (assumptions.length !== 2 || assumptions[0].team.teamId === assumptions[1].team.teamId) return { kind: "incomplete" };
  if (/(?:19|20)\d{2}/.test(q)) return { kind: "incomplete" };
  const mentioned = teams.filter((team) => new RegExp(`(?:^|[\\s,])(?:${teamPattern(team)})(?:은|는|이|가|와|과|랑|이랑)?(?=$|[\\s,?!])`, "i").test(q));
  if (mentioned.some((team) => !assumptions.some((item) => item.team.teamId === team.teamId))) return { kind: "incomplete" };
  // Preserve clause order rather than registry order.
  assumptions.sort((a, b) => q.search(new RegExp(teamPattern(a.team), "i")) - q.search(new RegExp(teamPattern(b.team), "i")));
  return { kind: "pair", assumptions: assumptions as [StandingAssumption, StandingAssumption] };
}

export const COUNTERFACTUAL_INPUT_ANSWER = "가정 결과를 적용한 비교가 필요합니다. 비교할 두 구단과 각 구단의 한 경기 결과(승리·패배·무승부)를 알려 주세요. 현재 게임차만으로는 가정 이후 승률이 같은지 판단할 수 없습니다.";
export const COUNTERFACTUAL_DATA_ANSWER = "가정 결과는 이해했지만 계산의 기준이 될 최신 승·패·무 기록을 확인하지 못했습니다. 두 구단의 기준 승·패·무 기록이 필요하며, 게임차만으로 승률 동률을 단정할 수 없습니다.";

/** Actual snapshot remains immutable. Equality uses integer cross-products,
 * not rounded display rates. GB=0 and win-rate equality are different facts. */
export function renderCounterfactual(snapshot: StandingsSnapshot, intent: Extract<CounterfactualIntent, { kind: "pair" }>, now: number): string | null {
  const at = Date.parse(snapshot.fetchedAt ?? "");
  if (!Number.isFinite(at) || at > now || now - at > LIVE_TEAM_BLOCK_MAX_AGE_MS
    || snapshot.season !== kstSeasonOf(now) || kstSeasonOf(at) !== snapshot.season) return null;
  const rows = intent.assumptions.map(({ team, result }) => {
    const matches = snapshot.rows.filter((row) => row.teamId === team.teamId);
    if (matches.length !== 1) return null;
    const row = matches[0];
    if (![row.wins, row.losses, row.draws, row.games].every((n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000)
      || row.games !== row.wins + row.losses + row.draws) return null;
    return { name: team.canonical, result, wins: row.wins + Number(result === "win"), losses: row.losses + Number(result === "loss"), draws: row.draws + Number(result === "draw") };
  });
  const [a, b] = rows;
  if (!a || !b || a.wins + a.losses === 0 || b.wins + b.losses === 0) return null;
  const gap = Math.abs((a.wins - a.losses) - (b.wins - b.losses)) / 2;
  const delta = a.wins * (b.wins + b.losses) - b.wins * (a.wins + a.losses);
  const label = { win: "승리", loss: "패배", draw: "무승부" };
  const stamp = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(at));
  const rate = (r: NonNullable<typeof a>) => (r.wins / (r.wins + r.losses)).toFixed(5);
  return `${snapshot.season}시즌 ${stamp} 수집 기록에 ${a.name} ${label[a.result]}·${b.name} ${label[b.result]}를 한 경기씩 추가하는 가정입니다(실제 경기 결과 반영이 아닙니다). ${a.name} ${a.wins}승 ${a.losses}패 ${a.draws}무, ${b.name} ${b.wins}승 ${b.losses}패 ${b.draws}무가 됩니다. 두 팀 게임차는 ${gap}게임이며, 승률은 ${a.name} ${rate(a)}, ${b.name} ${rate(b)}로 ${delta === 0 ? "같습니다" : `${delta > 0 ? a.name : b.name}가 더 높습니다`}. 승률은 무승부를 제외해 계산하며, 게임차가 같아도 승률 동률은 아닐 수 있습니다. 전체 순위는 다른 구단 결과와 동률 규정 확인이 필요합니다.`;
}
