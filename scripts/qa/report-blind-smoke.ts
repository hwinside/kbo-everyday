// QA 스모크 — 신고 자동 블라인드 안내(순수 함수) 검증.
// report-blind 모듈은 send-ops-message 를 type-only 로만 참조하므로 supabase 싱글톤을
// 로드하지 않는다. 그래도 방어적으로 더미 env 를 선주입한다(프로덕션 무변경).
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-test-anon-key";

import {
  REPORT_BLIND_THRESHOLD,
  blindTargetLabel,
  buildBlindNotice,
} from "../../src/lib/moderation/report-blind";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

// 임계값 — 하린아빠 지시 "3회 이상"
check("임계값은 3", REPORT_BLIND_THRESHOLD === 3);

// 대상 라벨
check("chat → 채팅 메시지", blindTargetLabel("chat") === "채팅 메시지");
check("post → 게시글", blindTargetLabel("post") === "게시글");
check("comment → 댓글", blindTargetLabel("comment") === "댓글");
check("unknown → 게시물 폴백", blindTargetLabel("weird") === "게시물");

// 안내 문안: 대상 라벨 치환 + 핵심 문구 포함
const chatNotice = buildBlindNotice(blindTargetLabel("chat"));
check("문안에 운영팀 서두", chatNotice.includes("크보팬 운영팀"));
check("문안에 블라인드 처리 안내", chatNotice.includes("블라인드 처리"));
check("문안에 운영정책 근거", chatNotice.includes("운영정책"));
check("chat 문안에 '채팅 메시지' 라벨", chatNotice.includes("채팅 메시지"));

const postNotice = buildBlindNotice(blindTargetLabel("post"));
check("post 문안에 '게시글' 라벨", postNotice.includes("게시글"));
check("post 문안엔 '채팅 메시지' 미포함", !postNotice.includes("채팅 메시지"));

const commentNotice = buildBlindNotice(blindTargetLabel("comment"));
check("comment 문안에 '댓글' 라벨", commentNotice.includes("댓글"));

// 문안 안정성: 빈 값/줄바꿈 구조
check("문안은 4줄 구조", chatNotice.split("\n").length === 4);
check("문안 비어있지 않음", chatNotice.trim().length > 0);

console.log(`\nreport-blind smoke: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
