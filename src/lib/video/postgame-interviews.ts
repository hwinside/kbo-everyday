import type { RssVideoEntry } from "@/lib/video/rss-parser";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const POSTGAME_INTERVIEW_START_MS = 30 * MINUTE_MS;
export const POSTGAME_INTERVIEW_WINDOW_MS = 24 * HOUR_MS;

export interface InterviewChannel {
  channelId: string;
  name: string;
  sourceKind: "broadcaster" | "team" | "curated";
  teamId: number | null;
  dedicatedInterviewChannel?: boolean;
}

/**
 * 2026-07-31 각 handle의 canonical channel URL과 RSS feed title을 직접 대조했다.
 * SPOTV는 지속적인 KBO 인터뷰 공급 여부가 아직 미확정이라 확인군으로만 포함한다.
 */
const BROADCASTER_CHANNELS: InterviewChannel[] = [
  { channelId: "UCqsKWTIu7IhBjLFZS2s1ULQ", name: "SBS Sports", sourceKind: "broadcaster", teamId: null },
  { channelId: "UCdkrHEDb1xT3gts9lct12Ug", name: "KBS N SPORTS", sourceKind: "broadcaster", teamId: null },
  { channelId: "UCDHIto3v5jKVLMaVlaMF-Gg", name: "야구는 엠스플", sourceKind: "broadcaster", teamId: null },
  { channelId: "UCtm_QoN2SIxwCE-59shX7Qg", name: "SPOTV", sourceKind: "broadcaster", teamId: null },
];

const TEAM_CHANNELS: InterviewChannel[] = [
  { channelId: "UCL6QZZxb-HR4hCh_eFAnQWA", name: "LGTWINSTV", sourceKind: "team", teamId: 1 },
  { channelId: "UCsebzRfMhwYfjeBIxNX1brg", name: "BEARS TV", sourceKind: "team", teamId: 2 },
  { channelId: "UCvScyjGkBUx2CJDMNAi9Twg", name: "kt wiz", sourceKind: "team", teamId: 3 },
  { channelId: "UCt8iRtgjVqm5rJHNl1TUojg", name: "SSG랜더스", sourceKind: "team", teamId: 4 },
  { channelId: "UC8_FRgynMX8wlGsU6Jh3zKg", name: "엔튜브", sourceKind: "team", teamId: 5 },
  { channelId: "UCKp8knO8a6tSI1oaLjfd9XA", name: "KIA타이거즈", sourceKind: "team", teamId: 6 },
  { channelId: "UCAZQZdSY5_YrziMPqXi-Zfw", name: "Giants TV", sourceKind: "team", teamId: 7 },
  { channelId: "UCMWAku3a3h65QpLm63Jf2pw", name: "LionsTV", sourceKind: "team", teamId: 8 },
  { channelId: "UCdq4Ji3772xudYRUatdzRrg", name: "Eagles TV", sourceKind: "team", teamId: 9 },
  { channelId: "UC_MA8-XEaVmvyayPzG66IKg", name: "키움히어로즈", sourceKind: "team", teamId: 10 },
];

const CURATED_INTERVIEW_CHANNELS: InterviewChannel[] = [
  {
    channelId: "UCUB0bLq2AIOzE9EX9oyokTQ",
    name: "[크보인터뷰]",
    sourceKind: "curated",
    teamId: null,
    dedicatedInterviewChannel: true,
  },
  {
    channelId: "UCYKUMtgU-lfM7PnclPkFXfQ",
    name: "위닝트윈스",
    sourceKind: "curated",
    teamId: 1,
  },
];

export const APPROVED_INTERVIEW_CHANNELS: readonly InterviewChannel[] = [
  ...BROADCASTER_CHANNELS,
  ...TEAM_CHANNELS,
  ...CURATED_INTERVIEW_CHANNELS,
];

export interface InterviewMatchContext {
  gameId: string;
  gameDate: string; // YYYY-MM-DD
  awayTeamName: string | null;
  homeTeamName: string | null;
  awayScore: number | null;
  homeScore: number | null;
  winnerTeamId: number;
  winnerPlayerNames: string[];
  isDoubleheader: boolean;
  endedAt: string;
  expiresAt: string;
}

export interface InterviewMatch {
  gameId: string;
  playerNames: string[];
}

/** 현재 시도 뒤 다음 탐색 시각. null이면 24시간 창 종료. */
export function nextPostgameInterviewCollectionAt(
  endedAtMs: number,
  attemptedAtMs: number,
): number | null {
  const ageMs = attemptedAtMs - endedAtMs;
  if (ageMs < POSTGAME_INTERVIEW_START_MS) {
    return endedAtMs + POSTGAME_INTERVIEW_START_MS;
  }
  if (ageMs >= POSTGAME_INTERVIEW_WINDOW_MS) return null;

  const intervalMs =
    ageMs < 3 * HOUR_MS
      ? 15 * MINUTE_MS
      : ageMs < 8 * HOUR_MS
        ? 30 * MINUTE_MS
        : HOUR_MS;
  return Math.min(attemptedAtMs + intervalMs, endedAtMs + POSTGAME_INTERVIEW_WINDOW_MS);
}

export function isPostgameInterviewTitle(title: string): boolean {
  return /(인터뷰|엔터뷰|수훈선수)/i.test(title);
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 제목 자체에 경기 날짜가 명시됐을 때만 통과한다. 업로드 날짜 추정만으로는 매핑하지 않는다. */
export function titleMatchesGameDate(title: string, gameDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(gameDate);
  if (!match) return false;
  const [, year, monthRaw, dayRaw] = match;
  const year2 = year.slice(2);
  const month = String(Number(monthRaw));
  const day = String(Number(dayRaw));
  const yyyy = escaped(year);
  const yy = escaped(year2);
  const mm = `0?${escaped(month)}`;
  const dd = `0?${escaped(day)}`;

  return [
    new RegExp(`(?:^|\\D)${yyyy}[./-]${mm}[./-]${dd}(?!\\d)`),
    new RegExp(`(?:^|\\D)${yy}[./-]${mm}[./-]${dd}(?!\\d)`),
    new RegExp(`(?:^|\\D)${yy}${monthRaw}${dayRaw}(?!\\d)`),
    new RegExp(`(?:^|\\D)${monthRaw}${dayRaw}(?!\\d)`),
    new RegExp(`(?:^|\\D)${mm}[./-]${dd}[./-]${yy}(?!\\d)`),
    new RegExp(`[([]\\s*${mm}[./]${dd}\\s*[)\\]]`),
    new RegExp(`(?:^|\\D)${mm}월\\s*${dd}일`),
  ].some((pattern) => pattern.test(title));
}

export function titleMatchesMatchupAndScore(
  title: string,
  context: Pick<
    InterviewMatchContext,
    "awayTeamName" | "homeTeamName" | "awayScore" | "homeScore"
  >,
): boolean {
  const { awayTeamName, homeTeamName, awayScore, homeScore } = context;
  if (
    !awayTeamName
    || !homeTeamName
    || awayScore === null
    || homeScore === null
  ) {
    return false;
  }
  const pattern = new RegExp(
    `(?:^|[^0-9A-Za-z가-힣])${escaped(awayTeamName)}\\s*${awayScore}\\s*(?:vs\\.?|대)\\s*${escaped(homeTeamName)}\\s*${homeScore}(?!\\d)`,
    "i",
  );
  return pattern.test(title);
}

/**
 * 한 영상이 정확히 한 종료 경기에만 대응할 때 반환한다.
 * 같은 날짜·같은 선수의 더블헤더는 candidate가 2개가 되어 fail-closed 된다.
 */
export function matchPostgameInterview(
  entry: Pick<RssVideoEntry, "title" | "published_at">,
  channel: InterviewChannel,
  contexts: InterviewMatchContext[],
): InterviewMatch | null {
  if (!channel.dedicatedInterviewChannel && !isPostgameInterviewTitle(entry.title)) return null;
  const publishedAtMs = Date.parse(entry.published_at);
  if (!Number.isFinite(publishedAtMs)) return null;

  const candidates = contexts.flatMap((context) => {
    if (context.isDoubleheader) return [];
    if (!titleMatchesGameDate(entry.title, context.gameDate)) return [];
    if (channel.dedicatedInterviewChannel && !titleMatchesMatchupAndScore(entry.title, context)) return [];
    if (channel.teamId !== null && channel.teamId !== context.winnerTeamId) return [];

    const endedAtMs = Date.parse(context.endedAt);
    const expiresAtMs = Date.parse(context.expiresAt);
    if (
      !Number.isFinite(endedAtMs)
      || !Number.isFinite(expiresAtMs)
      || publishedAtMs < endedAtMs
      || publishedAtMs > expiresAtMs
    ) {
      return [];
    }

    const playerNames = [...new Set(
      context.winnerPlayerNames
        .filter((name) => name.length >= 2 && entry.title.includes(name)),
    )];
    return playerNames.length > 0 ? [{ gameId: context.gameId, playerNames }] : [];
  });

  const uniqueGameIds = new Set(candidates.map((candidate) => candidate.gameId));
  return uniqueGameIds.size === 1 ? candidates[0] : null;
}
