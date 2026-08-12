/**
 * 로스터 **신원 지문**(identity fingerprint) — census 유효성 판정의 단일 기준.
 *
 * ⚠️ 왜 파일 해시가 아닌가 (2026-08-12, #1162 실측):
 *   census 는 로스터에서 **(name, kboId, birthDate) 세 값만** 소비한다
 *   (`corpus-identity-census.ts` 의 `byName` 후보 계산 + verdict 입력).
 *   그런데 종전 게이트는 로스터 **파일 전체의 SHA-256** 을 비교했다. 로스터 파일은
 *   봇이 매일 갱신한다(스탯·사진·팀·등번호) — 신원과 무관한 갱신에도 해시가 어긋나
 *   자동 업데이트 PR 이 **전건 빌드 FAIL** 이었다(8/9 도입 후 8/11 #1162 에서 실측).
 *
 * 계약:
 *   - 지문 입력은 census/loader 가 실제 결속하는 값 전체: `(name, kboId, birthDate)`.
 *     이 중 하나라도 빼면 그 필드의 변경이 stale census 를 통과시킨다(과소).
 *   - `teamId`·`position`·`backNo`·`team` 등 신원 무관 필드는 **넣지 않는다**(과대 —
 *     넣는 순간 매일 갱신이 다시 전건 FAIL 로 돌아간다).
 *   - **raw exact** 다 (삼순 재리뷰 blocker, 2026-08-12): census/loader 는 필드 값을
 *     trim·정규화 없이 그대로 쓴다(`byName` 키 = raw name). 그러므로 지문도 값을
 *     **일절 가공하지 않는다** — trim 을 넣으면 `"가나쿠보 유토"` → `"가나쿠보 유토 "` 같은
 *     변경이 loader 귀속을 바꾸는데 지문은 그대로라 stale census 가 false-GREEN 된다.
 *   - **무충돌 직렬화**: 튜플은 JSON 배열로 직렬화한다. JSON 이 제어문자·따옴표·구분자를
 *     전부 escape 하므로, 직렬화 결과에 raw 개행이 존재할 수 없고 튜플 join("\n") 이
 *     필드 경계 조작으로 충돌하지 않는다(NUL join 같은 "필드에 안 나올 것" 가정이 없다).
 *   - **multiset** 이다: 순서·JSON 포맷은 무시하고(정렬·canonical 직렬화), 중복 행은
 *     보존한다(동명이인 multiplicity 변화도 지문이 바뀌어야 한다).
 */
import { createHash } from "node:crypto";

export type RosterIdentitySource = {
  name?: unknown;
  kboId?: unknown;
  birthDate?: unknown;
};

/**
 * 한 선수의 신원 튜플을 canonical 문자열로 만든다 — **raw 값의 JSON 배열**.
 * 가공 금지: trim·소문자화·포맷 통일뿐 아니라 **타입 강제변환도 하지 않는다**
 * (삼순 2차 blocker, 2026-08-12): validator 는 kboId 의 string/number 를 모두 허용하고
 * loader 는 원타입을 그대로 쓰므로, `String()` 을 끼우면 `"53006" → 53006` 같은
 * 타입 변화가 loader 산출물을 바꾸는데 지문은 그대로라 false-GREEN 된다.
 * JSON 원값을 그대로 직렬화하고, JSON 이 표현할 수 없는 undefined 만 null 로 매핑한다.
 */
export function canonicalIdentityTuple(player: RosterIdentitySource): string {
  const field = (value: unknown): unknown => (value === undefined ? null : value);
  return JSON.stringify([field(player.name), field(player.kboId), field(player.birthDate)]);
}

/**
 * 로스터 배열 → 신원 multiset 의 SHA-256.
 * 정렬로 순서를 지우되 `sort` 는 동일 튜플을 제거하지 않으므로 중복(multiplicity)은 남는다.
 * join("\n") 은 안전하다 — 각 튜플이 JSON 직렬화라 raw 개행을 포함할 수 없다.
 */
export function computeRosterIdentityFingerprint(roster: readonly RosterIdentitySource[]): string {
  const tuples = roster.map(canonicalIdentityTuple);
  tuples.sort();
  return createHash("sha256").update(tuples.join("\n")).digest("hex");
}

/** 파일 내용(bytes/string) → 지문. JSON 포맷(들여쓰기·키 순서·개행)은 지문에 영향을 주지 않는다. */
export function fingerprintRosterFile(rosterJson: string | Buffer): string {
  const parsed = JSON.parse(rosterJson.toString("utf8"));
  if (!Array.isArray(parsed)) throw new Error("로스터 파일이 배열이 아니다");
  return computeRosterIdentityFingerprint(parsed as RosterIdentitySource[]);
}
