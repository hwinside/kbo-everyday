// AI 경기 요약 승패 검증 헬퍼.
// 목적: 패팀(loser)을 승자로 서술한 요약만 reject. 정상 요약은 통과시킨다.
//
// 과거 버그(2026-06-03): "롯데, KIA 꺾고 승리"처럼 승팀이 패팀을 *타동사로 제압*하는
// 정상 헤드라인에서, 패팀(KIA)이 승리 키워드 앞에 등장한다는 이유로 reject됐다.
// 한국어 헤드라인은 목적격 조사(를/을)를 흔히 생략("KIA 꺾고")하기 때문에
// 단순 "패팀 + 키워드" 근접 매칭으로는 목적어(정상)와 주어(오류)를 구분할 수 없었다.
//
// 보강(2026-06-03 삼순 리뷰): 타동사 키워드(꺾/제압/격파/대파/잡았/이기)는 "주어가
// 목적어를 제압" 구조라 주어=승자여야 한다. "KIA, 롯데 꺾고 승리"(패팀 KIA가 주어 +
// 승팀 롯데가 목적어)처럼 어순이 뒤집힌 오답은 승팀이 같은 구간에 있어도 reject해야
// 한다. 이전 규칙("승팀이 구간에 있으면 통과")은 이 케이스와, winner 필드가 맞게
// 들어온 경우를 모두 놓쳤다.

export const WIN_KEYWORDS = [
  "승리", "신승", "대승", "완승", "역전승", "끝내기",
  "이기", "꺾", "잡았", "제압", "대파", "격파", "등극", "위닝시리즈",
];

// 타동사 키워드: "A가 B를 ~다" 구조. 주어=승자, 목적어=패자여야 정상.
const TRANSITIVE_KEYWORDS = ["이기", "꺾", "잡았", "제압", "대파", "격파"];

// 팀명 뒤에 이 조사가 붙으면 목적어/부사어 → 승자가 아님
const OBJECT_PARTICLE_RE = /^(에게|한테|에|를|을)/;

const WINDOW = 25; // 승리 키워드 앞에서 살펴볼 같은 문장 최대 길이

// seg에서 team이 목적격 조사 없이(=주어로) 등장하는지.
function appearsAsSubject(seg: string, team: string): boolean {
  let i = seg.indexOf(team);
  while (i !== -1) {
    if (!OBJECT_PARTICLE_RE.test(seg.slice(i + team.length))) return true;
    i = seg.indexOf(team, i + 1);
  }
  return false;
}

// team이 seg 내에서 목적어로(목적격 조사를 달고) 등장하는지.
function appearsAsObject(seg: string, team: string): boolean {
  let i = seg.indexOf(team);
  while (i !== -1) {
    if (OBJECT_PARTICLE_RE.test(seg.slice(i + team.length))) return true;
    i = seg.indexOf(team, i + 1);
  }
  return false;
}

// 타동사 구간에서 패팀이 '승자(주어)'로 서술됐는지.
// 주어는 목적어보다 앞에 오므로, 패팀이 목적어 표시 없이 주어로 등장하고
// 승팀이 (부재하거나 / 패팀보다 뒤에 오거나 / 목적격 조사를 달고) 목적어 위치면 mismatch.
function loserIsClaimedVictor(seg: string, winner: string, loser: string): boolean {
  const loserIdx = seg.indexOf(loser);
  if (loserIdx === -1) return false;
  if (!appearsAsSubject(seg, loser)) return false; // 패팀이 목적어로만 등장 → 정상

  const winnerIdx = seg.indexOf(winner);
  if (winnerIdx === -1) return true;            // 승팀 부재, 패팀만 주어 → mismatch
  if (winnerIdx > loserIdx) return true;        // 패팀(주어) → 승팀(목적어) 어순 → mismatch
  if (appearsAsObject(seg, winner)) return true; // 승팀이 명시적 목적어 → mismatch
  return false;                                  // 승팀이 주어 위치 → 정상
}

/**
 * 패팀을 승자로 서술했으면 true.
 * - 타동사 키워드(꺾/제압 등): 패팀이 '주어(승자)'로 서술됐으면 mismatch (어순/조사로 판별).
 * - 그 외 키워드(승리/대승 등): 같은 구간에 승팀이 없고 패팀이 주어로 등장하면 mismatch.
 * 정상 헤드라인 "롯데, KIA 꺾고 승리"는 승팀(롯데)이 주어라 통과한다.
 */
export function loserClaimedWin(fullText: string, winner: string, loser: string): boolean {
  for (const kw of WIN_KEYWORDS) {
    const transitive = TRANSITIVE_KEYWORDS.includes(kw);
    let idx = fullText.indexOf(kw);
    while (idx !== -1) {
      let seg = fullText.slice(Math.max(0, idx - WINDOW), idx);
      // 문장 경계를 넘지 않도록 마지막 종결부호 뒤로 자른다.
      const brk = Math.max(seg.lastIndexOf("."), seg.lastIndexOf("!"), seg.lastIndexOf("?"));
      if (brk !== -1) seg = seg.slice(brk + 1);

      if (transitive) {
        if (loserIsClaimedVictor(seg, winner, loser)) return true;
      } else if (!seg.includes(winner) && appearsAsSubject(seg, loser)) {
        return true;
      }
      idx = fullText.indexOf(kw, idx + 1);
    }
  }
  return false;
}
