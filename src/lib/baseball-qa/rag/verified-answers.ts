/**
 * 검증 완료 RAG 답변 replay 계약 (2026-08-19 맛자욱 P0 — 동일입력 결정론).
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────────────────
 * 같은 질문(`구자욱 별명이 왜 맛자욱이야?`)이 17:20 grounded ↔ 23:38 insufficient 로
 * **플립**했다(input_tokens 2546 동일 = 같은 프롬프트). temperature 를 0 으로 내려도
 * provider 생성 변동은 원리적으로 남는다 — 재질문 때마다 생성을 다시 돌리는 구조 자체가
 * 비결정성의 원천이다. 그래서 **검증(출력 가드 전부 통과)까지 끝난 답변**을
 * `entity + 정규화 질문 + 근거 fingerprint + 프롬프트/모델 버전` 키로 고정·재사용한다.
 *
 * ── replay 가 안전한 조건 (전부 키에 결속) ──────────────────────────────────
 *   - entityId: 선수가 다르면 다른 답이다.
 *   - questionNorm: 정규화 질문이 다르면 다른 답이다.
 *   - evidence fingerprint: canonical·revision·sectionPath·content 해시의 **순서 보존**
 *     연쇄. corpus 재적재·재정렬·projection 변경이 있으면 fingerprint 가 달라져
 *     replay 는 자동 무효가 된다(“corpus revision 결속”이 이 축이다).
 *   - prompt fingerprint: 시스템 프롬프트가 바뀌면 과거 답은 새 계약의 답이 아니다.
 *   - model: 모델이 바뀌면 재사용하지 않는다.
 *
 * replay 는 **grounded(검증 통과) 답변만** 저장·재생한다. insufficient/폐기를 저장하면
 * 일시적 생성 실패가 영구 고정된다 — 그건 결정론이 아니라 오답 캐시다.
 *
 * 순수 함수만 담는다(네트워크·DB 없음). 저장소 배선은 `QaDeps` 주입이 담당한다.
 */

import { createHash } from "node:crypto";

import { RAG_SYSTEM_PROMPT, type RagEvidence } from "./retrieve";

/**
 * 답변 계약 버전. **replay 결과의 의미가 바뀌는 변경**(출력 가드 계약·근거 선별 계약)마다
 * 올린다. 프롬프트 변경은 fingerprint 가 자동으로 잡으므로 여기 반영할 필요가 없다.
 */
export const RAG_VERIFIED_ANSWER_CONTRACT_VERSION = "v1";

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 근거 묶음 fingerprint — 순서 보존.
 *
 * 순서를 정렬로 지우면 "같은 근거가 다른 순서로 프롬프트에 들어간 경우"를 같다고 보게 된다.
 * 프롬프트 바이트가 다르면 생성 입력이 다른 것이므로 순서도 결속한다.
 */
export function ragEvidenceFingerprint(evidence: RagEvidence[]): string {
  const chain = evidence
    .map((row) =>
      [row.canonicalUrl, row.revision, row.sectionPath, sha256(row.content)].join("\u0000"),
    )
    .join("\u0001");
  return sha256(`${RAG_VERIFIED_ANSWER_CONTRACT_VERSION}\u0002${chain}`);
}

/** 선수 서술형 경로의 프롬프트 fingerprint — 프롬프트가 바뀌면 replay 자동 무효. */
export function ragPlayerPromptFingerprint(): string {
  return sha256(RAG_SYSTEM_PROMPT);
}

export interface VerifiedRagAnswerKey {
  entityType: "player";
  entityId: string;
  questionNorm: string;
  /** `ragEvidenceFingerprint` — corpus revision·순서·projection 결과까지 결속. */
  evidenceFingerprint: string;
  /** `ragPlayerPromptFingerprint`. */
  promptFingerprint: string;
}

export interface VerifiedRagAnswerRecord {
  /** 출력 가드를 전부 통과한 최종 답변(출처 표기 **이전** 본문). */
  answer: string;
  /** provenance payload 링크 (allowlist 밖이면 null). */
  sourceUrl: string | null;
  toneCompliant: boolean;
}

export interface VerifiedRagAnswerStore {
  /** 키 exact 일치 시에만 답을 돌려준다 — fingerprint 하나라도 다르면 null. */
  get: (key: VerifiedRagAnswerKey) => Promise<VerifiedRagAnswerRecord | null>;
  /** grounded 검증 통과 답변만 저장한다. 실패는 조용히 무시된다(관측 경로가 답변을 막으면 안 된다). */
  put: (key: VerifiedRagAnswerKey, record: VerifiedRagAnswerRecord) => Promise<void>;
}
