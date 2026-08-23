/**
 * relay-substitution-gate — 크관 피드 교체 행 결속 회귀 게이트 (#1292 트랙).
 *
 * 계약:
 *  1. parseInningRelays 는 교체 공지("A : B (으)로 교체")를 FieldingEvent(replace)로 구조화하고
 *     **playIndex 를 그 교체가 속한 타석의 plays 인덱스에 결속**한다 (직후 확정 타석 = plays[playIndex]).
 *  2. 진행 중 타석(terminal 13/23 미도착)의 교체는 playIndex === plays.length 로 떨어진다(피드 tail 노출).
 *  3. 수비위치 변경(reposition)도 playIndex 를 갖는다(피드는 숨기지만 필드뷰 시간순 소스 유지).
 *
 * 픽스처는 2026-08-22 HT:WO 실경기 relay 원문 구조를 그대로 축약한 것 (titleStyle/type 코드 실측 기반).
 * selftest: 알려진 결함(playIndex 미결속/오결속)을 주입한 mutant 판정으로 게이트 검증력을 증명한다.
 * 실행: npm run qa:relay-substitution [-- --selftest]
 */
import { parseInningRelays, type NaverTextRelay, type FieldingEvent } from "../../src/app/api/game-relay/route";

// ── 픽스처: 7회말 — 선두타자 타석 중 투수교체 → 안타, 대타 교체 후 사구, 진행 중 타석에서 대주자 교체
const FIXTURE: NaverTextRelay[] = [
  // textRelays 는 최신-우선(역순)으로 도착한다 — parseInningRelays 가 reverse 하므로 여기도 역순 배치.
  {
    title: "7번타자 하주석",
    titleStyle: "8",
    textOptions: [
      { seqno: 1, text: "7번타자 하주석", type: 8 },
      { seqno: 2, text: "1루주자 김선빈 : 대주자 김민규 (으)로 교체", type: 2 },
      { seqno: 3, text: "1구 볼", type: 1, pitchNum: 1 },
      // terminal(13/23) 없음 = 진행 중 타석 → 대주자 교체는 plays.length 에 결속되어야 한다.
    ],
  },
  // 역순(최신우선)이므로 시간순은 ↓ 아래에서 위: 어준서(교체 공지) 다음에 김웅빈 타석이 온다.
  {
    title: "대타 김웅빈",
    titleStyle: "2",
    textOptions: [
      { seqno: 1, text: "대타 김웅빈", type: 8 },
      { seqno: 2, text: "1구 볼", type: 1, pitchNum: 1 },
      { seqno: 3, text: "김웅빈 : 몸에 맞는 볼", type: 23 },
    ],
  },
  {
    title: "8번타자 어준서",
    titleStyle: "8",
    textOptions: [
      { seqno: 1, text: "8번타자 어준서", type: 8 },
      { seqno: 2, text: "8번타자 어준서 : 대타 김웅빈 (으)로 교체", type: 2 },
    ],
  },
  {
    title: "6번타자 김건희",
    titleStyle: "8",
    textOptions: [
      { seqno: 1, text: "6번타자 김건희", type: 8 },
      { seqno: 2, text: "투수 올러 : 투수 조상우 (으)로 교체", type: 2 },
      { seqno: 3, text: "대타 한준수 : 포수(으)로 수비위치 변경", type: 2 },
      { seqno: 4, text: "1구 스트라이크", type: 1, pitchNum: 1 },
      { seqno: 5, text: "김건희 : 중견수 오른쪽 1루타", type: 13 },
    ],
  },
  { title: "7회말 키움 공격", titleStyle: "0" },
] as unknown as NaverTextRelay[];

type Replace = Extract<FieldingEvent, { kind: "replace" }>;

interface Expected {
  kind: FieldingEvent["kind"];
  playIndex: number;
  /** replace 전용 — 들어온 선수 이름으로 이벤트를 특정한다(순서 의존 판정 금지). */
  inName?: string;
}

// 기대 계약 — plays: [김건희 1루타(0), 김웅빈 사구(1)], 진행 중: 하주석.
const EXPECTED: Expected[] = [
  { kind: "replace", playIndex: 0, inName: "조상우" },   // 투수교체: 김건희 타석(plays[0]) 직전
  { kind: "reposition", playIndex: 0 },                    // 수비위치 변경도 같은 타석에 결속
  { kind: "replace", playIndex: 1, inName: "김웅빈" },   // 대타: 김웅빈 타석(plays[1]) 직전
  { kind: "replace", playIndex: 2, inName: "김민규" },   // 대주자: 진행 중 타석 → plays.length(=2)
];

function judge(fielding: FieldingEvent[] | undefined, playsLen: number): string[] {
  const failures: string[] = [];
  const events = fielding ?? [];
  for (const exp of EXPECTED) {
    const hit = events.find((e) =>
      e.kind === exp.kind && (exp.inName === undefined || (e as Replace).inName === exp.inName),
    );
    if (!hit) {
      failures.push(`GATE-MISS: ${exp.kind}${exp.inName ? `(in=${exp.inName})` : ""} 이벤트 자체가 없음`);
      continue;
    }
    if (hit.playIndex !== exp.playIndex) {
      failures.push(`GATE-BIND: ${exp.kind}${exp.inName ? `(in=${exp.inName})` : ""} playIndex=${hit.playIndex} ≠ 기대 ${exp.playIndex}`);
    }
  }
  if (events.some((e) => typeof e.playIndex !== "number")) {
    failures.push("GATE-UNBOUND: playIndex 미결속 이벤트 존재");
  }
  if (playsLen !== 2) failures.push(`GATE-PLAYS: 확정 타석 수 ${playsLen} ≠ 기대 2`);
  return failures;
}

function run(): number {
  const innings = parseInningRelays(FIXTURE);
  if (innings.length !== 1) {
    console.error(`GATE-INNING: 이닝 수 ${innings.length} ≠ 1`);
    return 1;
  }
  const inn = innings[0];
  const failures = judge(inn.fielding, inn.plays.length);
  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    return 1;
  }
  console.log(`PASS: 교체 이벤트 ${(inn.fielding ?? []).length}건 playIndex 결속 정상 (plays=${inn.plays.length})`);
  return 0;
}

function selftest(): number {
  // 게이트 검증력 증명 — 실제 파서 출력을 변조(mutation)해 judge 가 RED 를 내는지 확인.
  // 사본이 아니라 run() 과 동일한 judge seam 을 태운다.
  const base = parseInningRelays(FIXTURE)[0];
  const mutants: { name: string; fielding: FieldingEvent[] | undefined }[] = [
    { name: "M1 playIndex 전부 제거(미결속 회귀)", fielding: (base.fielding ?? []).map((e) => { const { playIndex: _px, ...rest } = e; return rest as FieldingEvent; }) },
    { name: "M2 playIndex 전부 0 고정(오결속 회귀)", fielding: (base.fielding ?? []).map((e) => ({ ...e, playIndex: 0 })) },
    { name: "M3 교체 이벤트 전부 소실(파싱 회귀)", fielding: [] },
  ];
  let red = 0;
  for (const m of mutants) {
    const failures = judge(m.fielding, base.plays.length);
    const caught = failures.length > 0;
    console.log(`${caught ? "RED(정상 검출)" : "!! GREEN(검출 실패)"} — ${m.name}`);
    if (caught) red++;
  }
  if (red !== mutants.length) {
    console.error(`SELFTEST FAIL: ${mutants.length}개 중 ${red}개만 검출`);
    return 1;
  }
  // 원본은 GREEN 이어야 한다(항상 RED 나는 게이트 방지).
  if (judge(base.fielding, base.plays.length).length > 0) {
    console.error("SELFTEST FAIL: 무결 입력에서 RED (게이트가 항상 실패)");
    return 1;
  }
  console.log(`SELFTEST PASS: mutation ${red}/${mutants.length} RED + 무결 GREEN`);
  return 0;
}

process.exit(process.argv.includes("--selftest") ? selftest() : run());
