import batterStats2026 from "@/lib/constants/stats-2026-batters.json";
import pitcherStats2026 from "@/lib/constants/stats-2026-pitchers.json";
import { canonicalKboId } from "@/lib/utils/resolve-player";

/**
 * `/api/stats?type=batter&full=1` 의 **완전성 기준 = merge 입력 선수 ID 전집합**.
 *
 * ⚠️ 왜 별도 모듈인가 (삼순 #1100 3차 P0-3 계약 준수).
 * `served-record.ts` 는 **값**의 정본을 `/api/stats` 로 못박은 모듈이라 static JSON 을
 * 직접 import 하면 안 된다(이주형 sb 4 vs 0 회귀). 그런데 "full 응답이 리그 전체인가"를
 * 판정하려면 merge 에 투입되는 명단이 필요하다 — 값이 아니라 **명단**이다.
 * 그래서 명단만 여기서 만들고, 이 모듈은 **ID 문자열 배열 외에는 아무것도 내보내지 않는다**.
 * 값(sb·avg…)이 이 경로로 새어 들어오면 위 계약이 우회되므로 게이트로 잠근다.
 */
export const FULL_ENTRY_BATTER_IDS: readonly string[] = Object.freeze(
  (batterStats2026 as Array<Record<string, unknown>>).map((row) =>
    canonicalKboId(row.kboId as string | number | null),
  ),
);

/** 투수 `full=1` 응답도 같은 방식으로 exact current-universe ID 전집합에 결속한다. */
export const FULL_ENTRY_PITCHER_IDS: readonly string[] = Object.freeze(
  (pitcherStats2026 as Array<Record<string, unknown>>).map((row) =>
    canonicalKboId(row.kboId as string | number | null),
  ),
);
