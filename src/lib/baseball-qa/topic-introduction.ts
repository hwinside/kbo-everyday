/** Reviewed static glossary extension for open beginner topics, not retrieval summaries.
 * KBO 2026 Official Baseball Rules: 1.02–1.06 (goal/scoring),
 * 5.09(e) (three outs), definition INNING (both teams' turns).
 * No season-dependent innings limit, detailed out ruling or unsupported statistic.
 */
export const BASEBALL_RULES_INTRO = {
  term: "야구 기본 규칙", aliases: [] as string[],
  answer: "야구는 두 팀이 공격과 수비를 번갈아 하며 더 많은 점수를 얻는 경기입니다.\n" +
    "공격팀은 타자가 주자가 되어 1루·2루·3루를 거쳐 홈까지 정상적으로 돌아오면 1점을 얻습니다. 다만 세 번째 아웃의 종류 등에 따라 득점이 인정되지 않는 경우도 있습니다.\n" +
    "수비팀이 아웃 3개를 잡으면 공격과 수비를 바꿉니다. 양 팀이 한 차례씩 공격하는 단위를 1이닝이라고 합니다.\n" +
    "처음에는 누가 공격하는지, 주자가 어느 베이스에 있는지, 아웃이 몇 개인지를 보시면 경기 흐름을 이해하기 쉽습니다.",
};
export const BASEBALL_TERMS_INTRO = {
  term: "야구 기본 용어", aliases: [] as string[],
  answer: "야구는 공격과 수비를 번갈아 하며 더 많은 점수를 얻는 경기입니다. 처음에는 아래 용어부터 보시면 좋습니다.\n" +
    "타자는 공을 치는 공격 선수, 투수는 타자에게 공을 던지는 수비 선수, 주자는 베이스를 돌며 득점을 노리는 공격 선수입니다.\n" +
    "득점은 주자가 1루·2루·3루를 거쳐 홈까지 정상적으로 돌아와 얻는 점수입니다. 세 번째 아웃의 종류 등에 따라 인정되지 않는 경우도 있습니다.\n" +
    "아웃 3개가 쌓이면 공수를 바꿉니다. 양 팀이 한 차례씩 공격하는 단위를 이닝이라고 합니다.",
};
