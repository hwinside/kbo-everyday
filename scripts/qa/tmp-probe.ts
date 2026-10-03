import { requiredRuleEvidence } from "../../src/lib/baseball-qa/rag/required-rule-evidence";
const qs = ["아까 그 선수 왜 아웃이야?", "그건 플라이아웃 아니야?", "2024년 최다안타는 누구야?"];
for (const q of qs) console.log(JSON.stringify([q, requiredRuleEvidence(q, Date.now())?.kind ?? null]));
