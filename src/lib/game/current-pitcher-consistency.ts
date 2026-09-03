/**
 * 현재타석 카드 투수-하프 정합성 가드 (클라 폴링 skew 방어).
 *
 * 근인(2026-09-03 실측): 경기룸은 두 소스를 서로 다른 주기로 폴링한다.
 *  - 타자(현재타석 batterName) = game-relay → 라이브 3초 폴링(빠름, 하프 전환 즉시 반영)
 *  - 투수(currentPitcher)        = game-live(useLiveGame) → 10초 폴링(느림)
 * 하프가 바뀌면 relay가 새 하프의 타자를 먼저 반영하는데, game-live 는 최대 ~10초간
 * 이전 하프의 투수(= 새 하프에선 공격팀 소속)를 유지한다. 그 window 에 현재타석 카드가
 * "신선한 타자 + stale 투수"를 섞으면 *같은 팀 타자 vs 투수*(교차팀)라는 불가능한
 * 매치업이 렌더된다(실측: 7회초 롯데 전민재 vs 롯데 비슬리).
 *
 * KBO 소스 자체는 원자적이다(라이브 raw 15분 폴링, 이닝 전환 다수 포함 → 교차팀 0건).
 * 따라서 소스가 아니라 *렌더 시점 두 소스의 하프 정합성*을 결속해 방어한다.
 *
 * 규칙(fail-close + fail-safe):
 *  - relay half 가 SSOT. half === "top" 이면 수비(투수)팀 = home, "bottom" 이면 away.
 *  - currentPitcher 이름이 boxScore 상 *공격팀(=현재 타자팀) 투수 명단*에 있고
 *    *수비팀 투수 명단엔 없으면* → 이전 하프 stale 확정 → null(카드 투수칸 미표시).
 *  - 그 외(수비팀 명단에 있음 / 어느 쪽에도 없음 / half·명단 미상)는 폐기하지 않는다
 *    — 외국인 표기 흔들림·명단 결측으로 인한 과억제를 막는 fail-safe.
 *
 * 순수 함수(node 직접 실행·결함주입 게이트 대상). 렌더 컴포넌트 밖에 둔다.
 */

export type RelayHalf = "top" | "bottom";

export interface PitcherConsistencyInput {
  /** game-live(느린 소스)에서 온 현재 투수명. null/빈값이면 그대로 통과. */
  currentPitcher: string | null | undefined;
  /** game-relay(빠른 소스, SSOT)의 최신 이닝 하프. 미상이면 가드 미적용. */
  relayHalf: RelayHalf | null | undefined;
  /** boxScore 원정팀 투수명 목록. */
  awayPitcherNames: readonly string[] | null | undefined;
  /** boxScore 홈팀 투수명 목록. */
  homePitcherNames: readonly string[] | null | undefined;
}

function norm(name: string | null | undefined): string {
  // 공백 제거 정규화. 외국인 단축형(game-live `비슬리`) vs 풀네임(boxScore `제러미 비슬리`)
  // 비교를 위해 공백까지 지운다.
  return (name ?? "").replace(/\s+/g, "").trim();
}

/**
 * 이름 매칭. exact 불가(실측: game-live `비슬리` ≠ boxScore `제러미 비슬리`) →
 * 공백 제거 후 양방향 containment(짧은 쪽이 긴 쪽에 포함). 비어있는 토큰은 불및.
 */
function nameMatches(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function hasName(list: readonly string[] | null | undefined, target: string): boolean {
  if (!list || list.length === 0) return false;
  const t = norm(target);
  if (!t) return false;
  return list.some((n) => nameMatches(n, t));
}

/**
 * 하프 정합성 위반(이전 하프 stale 투수)이면 true.
 * 판정 불가·정합이면 false(= 폐기하지 않음, fail-safe).
 */
export function isPitcherHalfStale(input: PitcherConsistencyInput): boolean {
  const pitcher = norm(input.currentPitcher);
  if (!pitcher) return false; // 투수명 없음 → 판정 대상 아님
  const half = input.relayHalf;
  if (half !== "top" && half !== "bottom") return false; // 하프 미상 → 가드 미적용

  // 수비(투수)팀 = top 이면 home, bottom 이면 away. 공격(타자)팀 = 반대.
  const defenseNames = half === "top" ? input.homePitcherNames : input.awayPitcherNames;
  const attackNames = half === "top" ? input.awayPitcherNames : input.homePitcherNames;

  const inDefense = hasName(defenseNames, pitcher);
  const inAttack = hasName(attackNames, pitcher);

  // 공격팀 명단에만 있으면(수비팀엔 없음) 이전 하프 stale 확정.
  return inAttack && !inDefense;
}

/**
 * 하프 정합성 결속을 적용한 현재 투수명.
 * stale(이전 하프 공격팀 투수)이면 null, 그 외엔 입력값 유지.
 */
export function resolveConsistentPitcher(
  input: PitcherConsistencyInput,
): string | null {
  const pitcher = norm(input.currentPitcher);
  if (!pitcher) return null;
  return isPitcherHalfStale(input) ? null : pitcher;
}
