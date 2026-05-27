/**
 * 움짤콜렉터 슬랙 인박스 파서 smoke test.
 *
 * Usage: npx tsx scripts/qa/gif-collector-slack-parser-smoke.ts
 */

import { parseInboxMessage, type ParsedInboxMessage } from "@/lib/gif-collector/slack-parser";

type Case = {
  name: string;
  text: string;
  expect:
    | { ok: true; value: Partial<ParsedInboxMessage> }
    | { ok: false; errorIncludes?: string };
};

const cases: Case[] = [
  {
    name: "키-값 형식 (한국어): 삼순이 PR #107 권고",
    text: "팀: LG\n선수: 오스틴\n링크: https://mlbpark.donga.com/mp/12345\n본문: 시즌 첫 그랜드슬램.\n진짜 미쳤다.",
    expect: {
      ok: true,
      value: {
        url: "https://mlbpark.donga.com/mp/12345",
        teamName: "LG",
        playerName: "오스틴",
        body: "시즌 첫 그랜드슬램.\n진짜 미쳤다.",
      },
    },
  },
  {
    name: "키-값 본문 보존 (빈 줄 + 앞뒤 공백 포함)",
    text: "팀: LG\n선수: 오스틴\n링크: https://example.com/gif\n본문: 첫 단락\n\n  들여쓰기 둘째 단락  ",
    expect: {
      ok: true,
      value: { body: "첫 단락\n\n  들여쓰기 둘째 단락  " },
    },
  },
  {
    name: "키-값에 본문 누락 → body 빈 문자열",
    text: "팀: LG\n선수: 오스틴\n링크: https://example.com",
    expect: {
      ok: true,
      value: { teamName: "LG", playerName: "오스틴", body: "" },
    },
  },
  {
    name: "키-값 팀-only (선수 없음) → playerName='' 허용",
    text: "팀: 한화\n링크: https://example.com/gif\n본문: 한화 팀 사진 모음",
    expect: {
      ok: true,
      value: {
        url: "https://example.com/gif",
        teamName: "한화",
        playerName: "",
        body: "한화 팀 사진 모음",
      },
    },
  },
  {
    name: "키-값 부분 누락 (팀 없음) → 친절 에러",
    text: "선수: 오스틴\n링크: https://example.com",
    expect: { ok: false, errorIncludes: "팀" },
  },
  {
    name: "멀티라인 fallback: URL + 팀 선수 + 본문",
    text: "https://mlbpark.donga.com/mp/12345\nLG 오스틴\n시즌 첫 그랜드슬램. 진짜 미쳤다",
    expect: {
      ok: true,
      value: {
        url: "https://mlbpark.donga.com/mp/12345",
        teamName: "LG",
        playerName: "오스틴",
        body: "시즌 첫 그랜드슬램. 진짜 미쳤다",
      },
    },
  },
  {
    name: "멀티라인 본문 보존 (빈 줄 + 들여쓰기)",
    text: "https://example.com/gif\nLG 오스틴\n첫 단락\n\n  들여쓰기 둘째 단락  ",
    expect: {
      ok: true,
      value: { body: "첫 단락\n\n  들여쓰기 둘째 단락  " },
    },
  },
  {
    name: "슬랙 링크 포맷 (<url>)",
    text: "<https://mlbpark.donga.com/mp/12345>\nLG 오스틴\n본문",
    expect: {
      ok: true,
      value: { url: "https://mlbpark.donga.com/mp/12345", teamName: "LG", playerName: "오스틴" },
    },
  },
  {
    name: "슬랙 HTML entity URL 정규화 (&amp; → &)",
    text: "<https://mlbpark.donga.com/mp/b.php?m=search&amp;p=1&amp;b=kbotown&amp;id=202605250115533923|MLBPARK>\n한화 강백호\n사회생활 갑",
    expect: {
      ok: true,
      value: {
        url: "https://mlbpark.donga.com/mp/b.php?m=search&p=1&b=kbotown&id=202605250115533923",
        teamName: "한화",
        playerName: "강백호",
      },
    },
  },
  {
    name: "슬랙 라벨 링크 (<url|label>)",
    text: "<https://x.com/post/999|X post>\n두산 양석환\n역전 적시타",
    expect: {
      ok: true,
      value: { url: "https://x.com/post/999", teamName: "두산", playerName: "양석환" },
    },
  },
  {
    name: "본문 없음 (2줄만, OK)",
    text: "https://example.com/gif\nLG 오스틴",
    expect: {
      ok: true,
      value: { url: "https://example.com/gif", teamName: "LG", playerName: "오스틴", body: "" },
    },
  },
  {
    name: "본문 멀티라인",
    text: "https://example.com/gif\nLG 오스틴\n첫 줄\n둘째 줄",
    expect: {
      ok: true,
      value: { body: "첫 줄\n둘째 줄" },
    },
  },
  {
    name: "외국인 풀네임 (공백 포함)",
    text: "https://example.com/gif\nLG 라클란 웰스\n호투",
    expect: {
      ok: true,
      value: { teamName: "LG", playerName: "라클란 웰스" },
    },
  },
  {
    name: "1줄만 → 에러",
    text: "https://example.com/gif",
    expect: { ok: false, errorIncludes: "최소 2줄" },
  },
  {
    name: "URL 인식 실패 → 에러",
    text: "그냥 텍스트\nLG 오스틴",
    expect: { ok: false, errorIncludes: "URL 인식 실패" },
  },
  {
    name: "멀티라인 팀-only (둘째 줄 1단어) → playerName='' 허용",
    text: "https://example.com/gif\n한화\n한화 팀 사진 모음",
    expect: {
      ok: true,
      value: {
        url: "https://example.com/gif",
        teamName: "한화",
        playerName: "",
        body: "한화 팀 사진 모음",
      },
    },
  },
  {
    name: "멀티라인 팀-only 본문 없음 (2줄, OK)",
    text: "https://example.com/gif\nLG",
    expect: {
      ok: true,
      value: { url: "https://example.com/gif", teamName: "LG", playerName: "", body: "" },
    },
  },
];

let pass = 0;
let fail = 0;

for (const c of cases) {
  const r = parseInboxMessage(c.text);
  if (c.expect.ok) {
    if (!r.ok) {
      console.log(`✗ ${c.name} — expected ok, got error: ${r.error}`);
      fail++;
      continue;
    }
    let okAll = true;
    for (const [k, v] of Object.entries(c.expect.value)) {
      const got = (r.value as unknown as Record<string, unknown>)[k];
      if (got !== v) {
        console.log(`✗ ${c.name} — ${k}: expected ${JSON.stringify(v)}, got ${JSON.stringify(got)}`);
        okAll = false;
        break;
      }
    }
    if (okAll) {
      console.log(`✓ ${c.name}`);
      pass++;
    } else {
      fail++;
    }
  } else {
    if (r.ok) {
      console.log(`✗ ${c.name} — expected error, got ok: ${JSON.stringify(r.value)}`);
      fail++;
      continue;
    }
    if (c.expect.errorIncludes && !r.error.includes(c.expect.errorIncludes)) {
      console.log(`✗ ${c.name} — error '${r.error}' lacks '${c.expect.errorIncludes}'`);
      fail++;
      continue;
    }
    console.log(`✓ ${c.name}`);
    pass++;
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
