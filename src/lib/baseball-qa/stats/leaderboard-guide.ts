import { SUPPORTED_SEASON } from "./season-record";

/** A navigation fallback, never a claim that a ranking was fetched. */
export const LEADERBOARD_GUIDE_URL = "https://keubo.fan/players/records";
export const KBO_HITTER_GUIDE_URL = "https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx";
export interface LeaderboardGuide { answer: string; sourceUrl: string }

// Longest composite terms must be checked before their substrings (장타율/타율,
// 도루저지율/도루). Only explicitly exposed RecordRoom chips may route to the app.
const METRIC = /도루\s*저지율|장타율|안타|홈런|타[율률]|타점|도루|탈삼진|평균자책(?:점)?|방어율|출루율|ops|war/gi;
const OFFICIAL_ONLY = new Set(["안타", "장타율", "도루저지율"]);

export function leaderboardGuide(question: string): LeaderboardGuide | null {
  const q = question.normalize("NFKC").toLowerCase();
  // Keep career, dated/split, definition and narrative ownership unchanged.
  if (/통산|역대|올타임|작년|지난|내년|최근|오늘|어제|전반기|후반기|월간|주간|득점권|상대|맞대결|포스트|플레이오프|한국.?시리즈|가을야구|시범|퓨처스|메이저|mlb|wbc|아시안|올스타|국대|뜻|정의|의미|유래|계산|산식|왜|방법|기준|규정|했|였|던|팀|구단|한\s*경기|경기당|연타석|연속/.test(q)) return null;
  if (/최고의/.test(q) && !new RegExp(`올해|이번\\s*시즌|${SUPPORTED_SEASON}`).test(q)) return null;
  if (/\S+전(?:에서|의|\s|$)/.test(q)) return null;
  const metrics = [...q.matchAll(METRIC)].map(([metric]) => metric.replace(/\s/g, ""));
  if (!metrics.length) return null;
  if (!/순위|랭킹|상위|top\s*\d|\d+\s*(?:위|등)|최다|최고|(?:가장|제일).*(?:많|높|낮)|(?:많|높|낮).*?(?:선수|타자|투수)/.test(q)) return null;
  const years = q.match(/(?:19|20)\d{2}/g) ?? [];
  if (years.some((year) => Number(year) !== SUPPORTED_SEASON)) return null;
  const absent = [...new Set(metrics.filter((metric) => OFFICIAL_ONLY.has(metric)))];
  if (absent.length) return {
    answer: `요청하신 선수 순위를 이 답변에서 직접 확인하지 못했습니다. 현재 크보팬 선수기록실에는 ${absent.join("·")} 정렬 항목이 없습니다. KBO 공식 홈페이지의 기록실 → 선수 기록에서 해당 기록과 시즌을 확인해 주세요.`,
    // Catcher rate is not a hitter stat: link the official site rather than a
    // hitter table and do not promise a sorting control we have not verified.
    sourceUrl: absent.includes("도루저지율") ? "https://www.koreabaseball.com" : KBO_HITTER_GUIDE_URL,
  };
  return {
    answer: "요청하신 선수 순위를 이 답변에서 직접 확인하지 못했습니다. 크보팬 선수 → 선수기록실에서 타자·투수를 선택하고 원하는 지표를 누르면 현재 시즌 순위 목록을 볼 수 있습니다."
      + (metrics.includes("war") ? " WAR는 기록실의 ‘예측 WAR’를 선택해 주세요. 자체 산식의 추정치이며 공식 WAR 순위가 아닙니다." : " 홈런·타율 등 제공되는 지표를 선택해 주세요."),
    sourceUrl: LEADERBOARD_GUIDE_URL,
  };
}
