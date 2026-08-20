import type { GameDetailResponse, LineupEntry, PitcherRecord, BatterRecord } from "@/lib/hooks/useGameDetail";
import type { LiveGameData } from "@/lib/hooks/useLiveGame";
import type { FieldingEvent } from "@/app/api/game-relay/route";

interface GameBase {
  inning?: string | null;
  awayScore: number;
  homeScore: number;
  status: string;
  awayTeamId?: number;
  homeTeamId?: number;
}

const FIELD_POSITIONS = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"] as const;
const FIELD_POSITION_SET = new Set<string>(FIELD_POSITIONS);

// 단일 수비 위치 문자 → 필드 코드. 한자/한글 약어(一二三·유좌중우·포) + 숫자.
const POS_CHAR_TO_FIELD: Record<string, string> = {
  "포": "C", "一": "1B", "二": "2B", "三": "3B",
  "유": "SS", "좌": "LF", "중": "CF", "우": "RF",
  "1": "1B", "2": "2B", "3": "3B",
};
// 한글 풀네임 → 필드 코드.
const POS_FULL_TO_FIELD: Record<string, string> = {
  "포수": "C", "1루수": "1B", "2루수": "2B", "3루수": "3B",
  "유격수": "SS", "좌익수": "LF", "중견수": "CF", "우익수": "RF",
};
// 수비 위치가 아직 확정 표기되지 않은 순수 대타/대주 약어(폐쇄집합).
// 이 값 이외의 미지 포지션은 상속 대상이 아니다(기존 fail-safe 유지).
export const PURE_SUB_POSITIONS = new Set(["대", "주", "타", "대타", "대주"]);

/**
 * BoxScore/라인업의 포지션 값을 *최종 수비 위치 코드*로 정규화한다.
 *
 * 소스가 제각각이라 정규화 없이는 매칭이 샌다:
 *  - KBO HTML 파서: 이미 코드(C/1B/…) 또는 지명(DH)
 *  - Naver fallback 파서: 원시 약어(一/二/三, 포/유/좌/중/우) 그대로
 *  - 대타·대주 후 수비 진입: 복합 약어(타二, 주중, 주우, 중우 …) → *마지막 문자가
 *    최종 수비 위치*. 대타/대주(타/주) 접두는 무시하고 실제 수비 위치만 취한다.
 *
 * 투수(P/투)·지명타자(DH/지)·순수 대타·대주(타/주 단독)는 필드 수비수가 아니므로
 * null을 반환한다(필드뷰에서 제외, 투수는 currentPitcher로 별도 렌더).
 */
export function normalizeFieldPosition(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (!t) return null;
  if (FIELD_POSITION_SET.has(t)) return t;              // 이미 필드 코드
  if (t === "P" || t === "DH" || t === "투" || t === "지" || t === "투수" || t === "지명타자") return null;
  if (POS_FULL_TO_FIELD[t]) return POS_FULL_TO_FIELD[t]; // 한글 풀네임
  // 복합/단일 약어 — 뒤에서부터 첫 수비 위치 문자(= 최종 이동 위치) 채택.
  for (let i = t.length - 1; i >= 0; i--) {
    const code = POS_CHAR_TO_FIELD[t[i]];
    if (code) return code;
  }
  return null;
}

/**
 * 교체·수비위치 변경 이벤트(Naver textRelay 원문, 시간순)를 선발 라인업 위에 재생해
 * *확정 수비 맵*(필드 위치 → 선수 이름)을 만든다. 추정이 아니라 소스 진실 기반이다
 * (삼순 재설계 지시 — "독립 소스·교체 타임라인으로 위치가 확정되는 경우만 보정").
 *
 * 규칙:
 *  - 상태 = 이름 → 현재 위치(선발 라인업으로 초기화, DH·투수는 null 유지).
 *  - replace "{posA} A : {posB} B 교체": A가 상태에 있을 때만 적용(팀 귀속 — 상대팀·
 *    투수 교체는 자연 무시). A 제거, B는 posB의 정규화 위치로 진입(대타/대주자는 null
 *    — 이후 reposition이 오면 그때 확정).
 *  - reposition "{posA} A : {posB} 수비위치 변경": A가 상태에 있을 때만 posB로 갱신.
 *  - 좁료 후 역변환: 한 위치에 정확히 1명이면 확정, 2명 이상이면 모순(이벤트 결손)
 *    → 그 위치는 맵에서 제외(fail-close).
 *  - 적용된 이벤트가 0개면 null → 호출측이 기존(boxScore) 로직 사용.
 */
export function replayFieldingTimeline(
  lineupEntries: LineupEntry[] | null | undefined,
  events: FieldingEvent[] | null | undefined,
): Map<string, string> | null {
  if (!lineupEntries || lineupEntries.length === 0 || !events || events.length === 0) return null;
  // 이름 → 현재 위치(null = 재중이나 수비 미배치: DH·대타·대주자 등).
  const posByName = new Map<string, string | null>();
  for (const e of lineupEntries) {
    if (e.name) posByName.set(e.name, normalizeFieldPosition(e.position));
  }
  let applied = 0;
  for (const ev of events) {
    if (ev.kind === "replace") {
      if (!posByName.has(ev.outName)) continue; // 다른 팀/투수 교체 — 무시
      posByName.delete(ev.outName);
      posByName.set(ev.inName, normalizeFieldPosition(ev.inPosKr));
      applied++;
    } else {
      if (!posByName.has(ev.name)) continue;
      posByName.set(ev.name, normalizeFieldPosition(ev.toPosKr));
      applied++;
    }
  }
  if (applied === 0) return null;
  // 역변환 + 모순 감지.
  const namesByPos = new Map<string, string[]>();
  for (const [name, pos] of posByName) {
    if (!pos) continue;
    const arr = namesByPos.get(pos);
    if (arr) arr.push(name);
    else namesByPos.set(pos, [name]);
  }
  const result = new Map<string, string>();
  for (const [pos, names] of namesByPos) {
    if (names.length === 1) result.set(pos, names[0]); // 2명 이상 = 이벤트 결손 → fail-close
  }
  return result;
}

/**
 * 필드뷰 수비 다이어그램용 수비수 목록을 만든다.
 *
 * 선발 라인업(detailLineup)만 보면 대타·대주·수비교체 이후 필드 위치가 선발 선수
 * 그대로 남아 "타순/투수는 바뀌는데 수비 위치만 안 바뀜" 버그가 난다.
 * (주자 이름 해결과 동일한 근거 — BoxScore는 교체 이력을 포함한다.)
 *
 * ⚠️ BoxScore 배열은 *전역 시간순이 아니라 타순별 그룹 순서*다(각 타순 안에서만
 * 시간순: 선발 → 교체 선수). 그래서 "포지션별로 배열 전체를 훑어 마지막 매치"를
 * 하면, 뒤쪽 타순에 남아있는 *이미 교체돼 사라진* 선수(예: 3번 슬롯 안현민 우)가
 * 앞 타순의 현재 선수(1번 슬롯 장진혁 RF)를 덮어써 잘못된 수비수가 나온다.
 *
 * 올바른 순서:
 *  1) 타순별 *마지막 entry* = 그 슬롯의 현재 선수를 먼저 확정한다.
 *  2) 그 현재 선수의 *최종 수비 위치만* 정규화해 8개 필드 위치를 구성한다.
 *  3) BoxScore에 현재 수비수가 없는 위치만 선발 라인업으로 폴백하되, 그 선발이
 *     이미 교체돼(같은 슬롯의 현재 선수가 다른 사람) 사라졌으면 되살리지 않는다
 *     — 순수 대타/대주로 슬롯이 채워져 수비 위치가 아직 불명확(타/주)한 동안 stale
 *     선발이 화면에 남는 것을 막는다.
 * BoxScore가 통째로 비어있으면 전부 선발 라인업으로 폴백 → 기존 동작 유지.
 */
function toDefenders(
  boxBatters: BatterRecord[] | null | undefined,
  lineupEntries: LineupEntry[] | null | undefined,
  teamId?: number,
  fieldingEvents?: FieldingEvent[] | null,
) {
  const timeline = replayFieldingTimeline(lineupEntries, fieldingEvents);

  // BoxScore 미수신/빈 배열 → 타임라인 확정분 우선, 없으면 선발 라인업 폴백 (기존 동작 유지).
  if (!boxBatters || boxBatters.length === 0) {
    return FIELD_POSITIONS.flatMap(pos => {
      const timelineName = timeline?.get(pos);
      if (timelineName) {
        const entry = lineupEntries?.find(e => e.name === timelineName);
        return [{ order: entry?.order ?? 0, name: timelineName, position: pos, avg: "", teamId }];
      }
      if (timeline) return []; // 타임라인 존재 + 미확정/모순 위치 → fail-close
      const entry = lineupEntries?.find(e => normalizeFieldPosition(e.position) === pos);
      return entry
        ? [{ order: entry.order, name: entry.name, position: pos, avg: "", teamId }]
        : [];
    });
  }

  // 1) 타순별 마지막 entry = 현재 그 슬롯 선수. (배열이 타순 그룹 순 + 그룹 내 시간순
  //    이므로 같은 order의 마지막 write = 현재.)
  const currentBySlot = new Map<number, BatterRecord>();
  for (const b of boxBatters) {
    if (!b.name) continue;
    if (typeof b.order === "number" && b.order > 0) currentBySlot.set(b.order, b);
  }

  // 2) 현재 슬롯 선수들의 *최종 수비 위치*만 필드 위치로 매핑. 교체돼 사라진 선수는
  //    애초에 currentBySlot에 없으므로 새지 않는다.
  const byPosition = new Map<string, BatterRecord>();
  for (const b of currentBySlot.values()) {
    const pos = normalizeFieldPosition(b.position);
    if (pos && !byPosition.has(pos)) byPosition.set(pos, b);
  }

  // 3) 순수 대타/대주 슬롯 상속 — 소스가 교체 선수의 수비 위치를 끝까지 '대/주'로
  //    두는 경우가 있다(실측: 20260812LGWO0 KBO BoxScore가 김웅빈 '대'·박채울 '주'를
  //    9회초 수비 내내 미갱신 → 1B/CF 빈 자리 렌더).
  //    1순위 보정은 서버의 Naver 선수별 복합 위치(타一/주중) 병합이다
  //    (mergeNaverSubPositions — 소스 진실 우선, 추정 아님).
  //    여기 휴리스틱 상속은 그 병합 후에도 남은 미확정 entry가 *정확히 1명*일
  //    때만 적용한다. 2명 이상이면 서로 위치를 바꾸는 더블스위치를 데이터로
  //    구분할 수 없으므로 추정하지 않고 기존 fail-empty(#932)를 유지한다.
  //    또한 다른 현재 선수가 이미 차지한 위치는 상속하지 않는다.
  const unresolvedPureSubs: Array<[number, BatterRecord]> = [];
  for (const [order, cur] of currentBySlot) {
    const raw = (cur.position ?? "").trim();
    if (PURE_SUB_POSITIONS.has(raw)) unresolvedPureSubs.push([order, cur]);
  }
  if (unresolvedPureSubs.length === 1) {
    const [order, cur] = unresolvedPureSubs[0];
    // 같은 타순의 직전 entry들(선발 → 중간 교체) 중 마지막으로 확인된 수비 위치.
    let vacated: string | null = null;
    for (let i = boxBatters.length - 1; i >= 0; i--) {
      const b = boxBatters[i];
      if (b === cur || b.order !== order || !b.name) continue;
      const pos = normalizeFieldPosition(b.position);
      if (pos) { vacated = pos; break; }
    }
    // BoxScore에 이전 수비 위치 기록이 없으면 선발 라인업의 같은 타순 위치로 폴백.
    if (!vacated) {
      const entry = lineupEntries?.find(e => e.order === order);
      vacated = entry ? normalizeFieldPosition(entry.position) : null;
    }
    if (vacated && !byPosition.has(vacated)) byPosition.set(vacated, cur);
  }

  // 선발 라인업 폴백 — 단 그 선발 슬롯이 이미 다른 선수로 교체·이동됐으면 억제(stale 방지).
  // 최종 렌더와 4)의 빈자리 판정이 같은 술어를 쓰도록 단일 함수로 묶는다.
  const fallbackFor = (pos: string): LineupEntry | null => {
    const entry = lineupEntries?.find(e => normalizeFieldPosition(e.position) === pos);
    if (!entry) return null;
    if (typeof entry.order === "number") {
      const slotCur = currentBySlot.get(entry.order);
      if (slotCur) {
        const slotPosition = normalizeFieldPosition(slotCur.position);
        if (slotCur.name !== entry.name || slotPosition !== pos) return null; // 교체·포지션 이동 stale 억제
      }
    }
    return entry;
  };

  // 4) 포지션 충돌 해소 — 소스가 수비 이동을 미갱신해 *현재 선수 2명이 같은 위치*로
  //    표기되는 경우(실측: 20260820KTLG0 오윤석 二 + 류현인 二, 三 공석 — 류현인
  //    2B→3B 이동 미반영 → 필드뷰 3루수 실종·류현인 소실).
  //
  //    누가 충돌 위치를 지키고 누가 빈자리로 가는지는 first-wins(타순/배열 순서)로
  //    증명할 수 없다(삼순 NO-GO P0 — 타순이 반대인 동형 케이스에서 두 선수가
  //    뒤바뀜다). 대신 *독립 신호*로만 판별한다:
  //      · fresh = 현재 표기가 본인 선발 슬롯 위치와 다름(이동이 기록됨) 또는 선발
  //        명단에 없음(교체 투입 — 투입 시점에 기록된 위치) → 충돌 위치의 근거가 있다.
  //      · stale-의심 = 현재 표기가 본인 선발 위치 그대로(갱신 이력 없음) → 미갱신
  //        가능성이 있는 쪽.
  //    충돌 위치가 정확히 1곳·후보 정확히 2명·fresh 1명+stale 1명·최종 렌더가 비게
  //    될 필드 위치(폴백 포함)도 정확히 1개일 때만: fresh가 충돌 위치를 갖고(first-wins
  //    결과가 반대면 교정), stale이 빈자리로 간다. 그 외(양쪽 모호·후보 3명 이상·
  //    충돌 2곳 이상·빈자리 2개 이상)는 추정하지 않고 기존 fail-empty(#932) 유지.
  const candidatesByPos = new Map<string, BatterRecord[]>();
  for (const b of currentBySlot.values()) {
    const pos = normalizeFieldPosition(b.position);
    if (!pos) continue;
    const arr = candidatesByPos.get(pos);
    if (arr) arr.push(b);
    else candidatesByPos.set(pos, [b]);
  }
  const contested = [...candidatesByPos.entries()].filter(([, arr]) => arr.length >= 2);
  if (contested.length === 1 && contested[0][1].length === 2) {
    const [pos, pair] = contested[0];
    // 본인 선발 슬롯(타순+이름 일치)의 위치 — 이름 단독 매칭 금지(동명이인 오귀속 방지).
    const startingPosOf = (b: BatterRecord): string | null => {
      const entry = lineupEntries?.find(e => e.order === b.order && e.name === b.name);
      return entry ? normalizeFieldPosition(entry.position) : null;
    };
    const freshOnes = pair.filter(b => startingPosOf(b) !== pos);
    const staleOnes = pair.filter(b => startingPosOf(b) === pos);
    if (freshOnes.length === 1 && staleOnes.length === 1) {
      const vacancies = FIELD_POSITIONS.filter(p => !byPosition.has(p) && !fallbackFor(p));
      if (vacancies.length === 1) {
        byPosition.set(pos, freshOnes[0]);
        byPosition.set(vacancies[0], staleOnes[0]);
      }
    }
  }

  // 0) 타임라인 확정분 최우선 — 단, relay가 끪겨 오래된 타임라인이 이미 교체된 선수를
  //    가리키는 경우를 막기 위해 boxScore 교차검증: 해당 선수가 boxScore상 어떤 타순에
  //    기록돼 있는데 그 타순의 현재 선수가 다른 사람이면(=이미 교체되어 퇴장) 타임라인
  //    배정을 불신하고 기존 로직으로 폴백한다.
  const leftGame = (name: string): boolean => {
    let seen = false;
    for (const b of boxBatters) {
      if (b.name === name && typeof b.order === "number" && b.order > 0) {
        seen = true;
        const cur = currentBySlot.get(b.order);
        if (cur && cur.name === name) return false; // 어느 타순에서든 현재 선수면 재중
      }
    }
    return seen; // 기록은 있는데 어느 타순의 현재도 아님 = 퇴장
  };

  // 퇴장 교차검증을 통과한 타임라인 배정만 유효화하고, 그 선수들은 legacy 경로에서 제외한다
  // — 타임라인이 3B로 확정한 선수를 boxScore stale 표기(二)가 2B에 한 번 더 그리는
  // 이중 노출을 구조적으로 차단.
  const effectiveTimeline = new Map<string, string>();
  if (timeline) {
    for (const [pos, name] of timeline) {
      if (!leftGame(name)) effectiveTimeline.set(pos, name);
    }
  }
  const timelineNames = new Set(effectiveTimeline.values());

  return FIELD_POSITIONS.flatMap(pos => {
    // 0) 교체 타임라인 확정분(소스 진실) 최우선.
    const timelineName = effectiveTimeline.get(pos);
    if (timelineName) {
      const box = boxBatters.find(b => b.name === timelineName);
      const entry = lineupEntries?.find(e => e.name === timelineName);
      return [{
        order: box?.order ?? entry?.order ?? 0,
        name: timelineName,
        position: pos,
        avg: box?.avg ?? "",
        teamId,
      }];
    }
    // 2-1) BoxScore의 현재 수비수 우선 — 타임라인이 다른 위치로 확정한 선수는 제외.
    const cur = byPosition.get(pos);
    if (cur && !timelineNames.has(cur.name)) {
      return [{ order: cur.order, name: cur.name, position: pos, avg: cur.avg ?? "", teamId }];
    }
    // 2-2) 선발 라인업 폴백(위 fallbackFor 계약) — 동일 제외 규칙.
    const entry = fallbackFor(pos);
    if (!entry || timelineNames.has(entry.name)) return [];
    return [{ order: entry.order, name: entry.name, position: pos, avg: "", teamId }];
  });
}

/**
 * 타순 번호로 현재 그 자리에 있는 선수 이름을 해결한다.
 * KBO 라이브 API는 베이스 점유를 *타순 번호*로만 알려주므로 대타/대주자 교체가
 * 일어나면 선발 라인업 룩업으로는 잘못된 이름이 나온다. BoxScore는 교체 이력을
 * 포함하니까 *같은 타순의 마지막 entry* = 현재 그 자리 선수로 본다.
 * 초(top)일 때 공격팀은 원정(away), 말(bottom)일 때 공격팀은 홈(home).
 */
function resolveRunnerName(
  orderNo: number | undefined,
  isTop: boolean,
  lineup: GameDetailResponse["lineup"] | null,
  boxScore: GameDetailResponse["boxScore"] | null,
): string | null {
  if (!orderNo || orderNo <= 0) return null;
  // KBO/Naver 타순은 1~9. Naver 원값이 결손/범위 밖이면 sentinel(99)이
  // 전달되므로 이름 해석을 포기한다(null → UI "주자" 표기).
  if (!Number.isInteger(orderNo) || orderNo > 9) return null;

  // 1) BoxScore 우선 — 교체 이력 반영. 같은 order의 마지막 entry가 현재 주자.
  if (boxScore) {
    const batters = isTop ? boxScore.awayBatters : boxScore.homeBatters;
    for (let i = batters.length - 1; i >= 0; i--) {
      if (batters[i].order === orderNo && batters[i].name) return batters[i].name;
    }
  }

  // 2) 선발 라인업 fallback — BoxScore 미수신 또는 비어있을 때.
  if (lineup) {
    const batters = isTop ? lineup.away : lineup.home;
    const found = batters.find(b => b.order === orderNo);
    if (found?.name) return found.name;
  }

  return null;
}

export function deriveGameState(
  liveGame: LiveGameData | undefined,
  game: GameBase,
  gameDetail: GameDetailResponse | null,
  /** game-relay 응답의 이닝별 교체·수비위치 이벤트. 있으면 필드뷰 수비 배치의 소스 진실로 사용. */
  relayInnings?: Array<{ fielding?: FieldingEvent[] }> | null,
) {
  const currentBalls = liveGame?.balls ?? 0;
  const currentStrikes = liveGame?.strikes ?? 0;
  const currentOuts = liveGame?.outs ?? 0;
  const currentRunner1b = liveGame?.runner1b ?? false;
  const currentRunner2b = liveGame?.runner2b ?? false;
  const currentRunner3b = liveGame?.runner3b ?? false;
  const currentBatter = liveGame?.currentBatter ?? null;
  const currentPitcher = liveGame?.currentPitcher ?? null;
  const currentInning = liveGame?.currentInning || game.inning || "";
  // 점수 소스 우선순위: liveGame > gameDetail linescore > game (static)
  const awayScore = liveGame?.awayScore ?? gameDetail?.linescore?.away?.R ?? game.awayScore;
  const homeScore = liveGame?.homeScore ?? gameDetail?.linescore?.home?.R ?? game.homeScore;
  const isLive = liveGame?.isLive || game.status === "live";
  // liveGame이 있지만 isLive가 false이고 점수가 있으면 → 종료된 경기
  // gameDetail.status도 체크 (과거 경기는 game-live에 없지만 game-detail API는 final 반환)
  const isCancelled = game.status === "cancelled" || gameDetail?.status === "cancelled";
  const isFinal = game.status === "final"
    || gameDetail?.status === "final"
    || (!!liveGame && !liveGame.isLive && (liveGame.awayScore > 0 || liveGame.homeScore > 0));
  const derivedStatus: "live" | "final" | "scheduled" | "cancelled" = isLive ? "live" : isCancelled ? "cancelled" : isFinal ? "final" : "scheduled";

  const isTop = currentInning.includes("초");
  const detailLineup = gameDetail?.lineup ?? null;
  const detailBoxScore = gameDetail?.boxScore ?? null;
  const defensiveTeamId = isTop ? game.homeTeamId : game.awayTeamId;
  const battingTeamId = isTop ? game.awayTeamId : game.homeTeamId;

  const defensiveLineup = detailLineup ? (isTop ? detailLineup.home : detailLineup.away) : null;
  const defensiveBoxBatters = detailBoxScore ? (isTop ? detailBoxScore.homeBatters : detailBoxScore.awayBatters) : null;
  // 이벤트는 이닝 순서대로 평탄화(이닝 내도 시간순). 팀 귀속은 replay가 수비팀 라인업
  // 이름 기준으로 자연 필터링하므로 양팀 이벤트를 섮어 넘겨도 안전하다.
  const fieldingEvents = relayInnings?.flatMap(inn => inn.fielding ?? []) ?? null;
  const defensiveSide = (defensiveLineup || (defensiveBoxBatters && defensiveBoxBatters.length > 0))
    ? toDefenders(defensiveBoxBatters, defensiveLineup, defensiveTeamId, fieldingEvents)
    : null;

  // On-deck batters from lineup
  const onDeckBatters = (() => {
    if (!currentBatter || !detailLineup) return undefined;
    const inAway = detailLineup.away.some((b: LineupEntry) => b.name === currentBatter);
    const batters = inAway ? detailLineup.away : detailLineup.home;
    const currentIndex = batters.findIndex((b: LineupEntry) => b.name === currentBatter);
    if (currentIndex === -1) return undefined;
    const next: { order: number; name: string }[] = [];
    for (let i = 1; i <= 3; i++) {
      const idx = (currentIndex + i) % batters.length;
      next.push({ order: batters[idx].order, name: batters[idx].name });
    }
    return next;
  })();

  // Pitcher today stats from boxScore
  const pitcherToday = (() => {
    if (!currentPitcher || !gameDetail?.boxScore) return null;
    const allPitchers = [
      ...(gameDetail.boxScore.awayPitchers || []),
      ...(gameDetail.boxScore.homePitchers || []),
    ];
    return allPitchers.find((p: PitcherRecord) => p.name === currentPitcher) ?? null;
  })();

  // Batter today stats from boxScore
  const batterToday = (() => {
    if (!currentBatter || !gameDetail?.boxScore) return null;
    const allBatters = [
      ...(gameDetail.boxScore.awayBatters || []),
      ...(gameDetail.boxScore.homeBatters || []),
    ];
    return allBatters.find((b: BatterRecord) => b.name === currentBatter) ?? null;
  })();

  return {
    currentBalls,
    currentStrikes,
    currentOuts,
    currentRunner1b,
    currentRunner2b,
    currentRunner3b,
    currentBatter,
    currentPitcher,
    currentInning,
    awayScore,
    homeScore,
    isLive,
    isCancelled,
    isFinal,
    derivedStatus,
    isTop,
    detailLineup,
    defensiveSide,
    defensiveTeamId,
    battingTeamId,
    currentPitcherTeamId: defensiveTeamId,
    currentBatterTeamId: battingTeamId,
    runnerTeamId: battingTeamId,
    onDeckBatters,
    pitcherToday,
    batterToday,
    pitcherEra: pitcherToday?.era,
    batterAvg: batterToday?.avg,
    runner1bName: liveGame?.runner1bName || resolveRunnerName(liveGame?.runner1bOrder, isTop, detailLineup, detailBoxScore),
    runner2bName: liveGame?.runner2bName || resolveRunnerName(liveGame?.runner2bOrder, isTop, detailLineup, detailBoxScore),
    runner3bName: liveGame?.runner3bName || resolveRunnerName(liveGame?.runner3bOrder, isTop, detailLineup, detailBoxScore),
  };
}
