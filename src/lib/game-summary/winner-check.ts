// AI 경기 요약 승패 검증 헬퍼.
// 목적: 패팀(loser)을 승자로 서술한 요약만 reject. 정상 요약은 통과시킨다.
//
// 과거 버그(2026-06-03): "롯데, KIA 꺾고 승리"처럼 승팀이 패팀을 *타동사로 제압*하는
// 정상 헤드라인에서, 패팀(KIA)이 승리 키워드 앞에 등장한다는 이유로 reject됐다.
// 한국어 헤드라인은 목적격 조사(를/을)를 흔히 생략("KIA 꺾고")하기 때문에
// 단순 "패팀 + 키워드" 근접 매칭으로는 목적어(정상)와 주어(오류)를 구분할 수 없었다.

export const WIN_KEYWORDS = [
  "승리", "신승", "대승", "완승", "역전승", "끝내기",
  "이기", "꺾", "잡았", "제압", "대파", "격파", "등극", "위닝시리즈",
];

// 패팀 뒤에 이 조사가 붙으면 목적어/부사어 → 승자가 아님(오탐 방지)
const OBJECT_PARTICLE_RE = /^(에게|한테|에|를|을)/;

const WINDOW = 25; // 승리 키워드 앞에서 살펴볼 같은 문장 최대 길이

// seg(같은 문장의 키워드 앞 구간)에서 loser가 '주어'로 등장하는지.
// loser 바로 뒤에 목적격 조사가 없으면 주어로 간주.
function loserAppearsAsSubject(seg: string, loser: string): boolean {
  let i = seg.indexOf(loser);
  while (i !== -1) {
    const after = seg.slice(i + loser.length);
    if (!OBJECT_PARTICLE_RE.test(after)) return true;
    i = seg.indexOf(loser, i + 1);
  }
  return false;
}

/**
 * 패팀을 승자로 서술했으면 true.
 * 규칙: 승리 키워드 바로 앞(같은 문장, 최대 WINDOW자) 구간에
 *   - 승팀이 등장하지 않고
 *   - 패팀이 '주어'로(목적격 조사 없이) 등장하면 → mismatch.
 * 정상 헤드라인 "롯데, KIA 꺾고 승리"는 같은 구간에 승팀(롯데)도 있어 통과한다.
 */
export function loserClaimedWin(fullText: string, winner: string, loser: string): boolean {
  for (const kw of WIN_KEYWORDS) {
    let idx = fullText.indexOf(kw);
    while (idx !== -1) {
      let seg = fullText.slice(Math.max(0, idx - WINDOW), idx);
      // 문장 경계를 넘지 않도록 마지막 종결부호 뒤로 자른다.
      const brk = Math.max(seg.lastIndexOf("."), seg.lastIndexOf("!"), seg.lastIndexOf("?"));
      if (brk !== -1) seg = seg.slice(brk + 1);
      if (!seg.includes(winner) && loserAppearsAsSubject(seg, loser)) return true;
      idx = fullText.indexOf(kw, idx + 1);
    }
  }
  return false;
}
