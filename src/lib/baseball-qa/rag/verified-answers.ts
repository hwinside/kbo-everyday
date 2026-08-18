/**
 * 검증 완료 RAG 답변 replay 계약 (2026-08-19 맛자욱 P0 — 동일입력 결정론).
 *
 * ── 왜 필요한가 ─────────────────────────────────────────────────────────────
 * 같은 질문(`구자욱 별명이 왜 맛자욱이야?`)이 17:20 grounded ↔ 23:38 insufficient 로
 * **플립**했다(input_tokens 2546 동일 = 같은 프롬프트). temperature 를 0 으로 내려도
 * provider 생성 변동은 원리적으로 남는다 — 재질문 때마다 생성을 다시 돌리는 구조 자체가
 * 비결정성의 원천이다. 그래서 **검증(출력 가드 전부 통과)까지 끝난 답변**을 아래 키로
 * 고정·재사용한다.
 *
 * ── replay 키 (전부 결속, 삼순 2026-08-19 P0-①) ────────────────────────────
 *   - entityId + questionNorm: 선수·정규화 질문이 다르면 다른 답이다.
 *   - evidenceFingerprint: canonical·revision·sectionPath·content 해시의 **순서 보존**
 *     연쇄 — corpus 재적재·재정렬·projection 변경 시 자동 무효(“corpus revision 결속”).
 *   - requestFingerprint: **model id + 실제 `buildRagLlmRequest` 요청 전체**(원문 질문·
 *     시스템 프롬프트·직전 대화 context·rosterBlock·generationConfig·근거 블록)의 해시.
 *     프롬프트 문면만 결속하면 모델 교체·context/roster 차이에도 과거 답이 재생된다 —
 *     생성 입력의 **어떤 바이트**가 달라도 miss 여야 한다.
 *
 * replay 는 **grounded(검증 통과) 답변만** 저장·재생한다. insufficient/폐기를 저장하면
 * 일시적 생성 실패가 영구 고정된다 — 그건 결정론이 아니라 오답 캐시다.
 *
 * ── 동시성 (삼순 2026-08-19 P0-②) ──────────────────────────────────────────
 * 서로 다른 messageId 가 같은 replay 키의 첫 miss 를 동시에 보면 둘 다 LLM 을 부르고
 * 서로 다른 답을 각자 반환할 수 있다 — DB `ignoreDuplicates` 는 첫 행만 지킬 뿐 응답
 * 결정론을 지키지 못한다. 그래서 저장소가 **replay-key 단위 선점(claim)** 을 제공한다:
 *   winner = pending claim 삽입에 성공한 한 명만 LLM 을 소비하고, `put` 으로 settle.
 *   loser  = winner 의 settle 을 **대기 후 재조회**해 같은 답을 재생한다.
 *   winner 가 grounded 를 못 만들면 `release` 로 claim 을 풀어 deadlock 을 막는다.
 * claim 미제공 저장소는 replay(hit)만 쓰고 선점 없이 동작한다(기존 fail-open).
 *
 * 순수 함수만 담는다(네트워크·DB 없음). 저장소 배선은 `QaDeps` 주입이 담당한다.
 */

import { createHash } from "node:crypto";

import { BASEBALL_QA_GEMINI_MODEL } from "../gemini-request";
import {
  buildRagLlmRequest,
  RAG_SYSTEM_PROMPT,
  type RagEvidence,
  type RagRequestExtras,
} from "./retrieve";

/**
 * 답변 계약 버전. **replay 결과의 의미가 바뀌는 변경**(출력 가드 계약·근거 선별 계약)마다
 * 올린다. 프롬프트·모델·요청 형태 변경은 requestFingerprint 가 자동으로 잡는다.
 */
export const RAG_VERIFIED_ANSWER_CONTRACT_VERSION = "v2";

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

/**
 * 생성 요청 전체 fingerprint — **model id + 실제 provider 로 나가는 요청 바이트** 결속.
 *
 * `buildRagLlmRequest` 가 만드는 객체(시스템 프롬프트·원문 질문·근거 블록·직전 대화·
 * rosterBlock·generationConfig)를 그대로 직렬화해 해시한다. 여기 안 들어가는 입력은
 * 생성에 영향을 줄 수 없고, 들어가는 입력은 바이트 하나만 달라도 miss 다.
 * 모델 id 는 요청 URL 에 있으므로 본문 밖 — 명시적으로 함께 결속한다.
 */
export function ragRequestFingerprint(
  question: string,
  evidence: RagEvidence[],
  extras: RagRequestExtras = {},
  model: string = BASEBALL_QA_GEMINI_MODEL,
): string {
  const request = buildRagLlmRequest(question, evidence, RAG_SYSTEM_PROMPT, extras);
  return sha256(
    `${RAG_VERIFIED_ANSWER_CONTRACT_VERSION}\u0003${model}\u0003${JSON.stringify(request)}`,
  );
}

export interface VerifiedRagAnswerKey {
  entityType: "player";
  entityId: string;
  questionNorm: string;
  /** `ragEvidenceFingerprint` — corpus revision·순서·projection 결과까지 결속. */
  evidenceFingerprint: string;
  /** `ragRequestFingerprint` — model + 실제 생성 요청 전체 결속. */
  requestFingerprint: string;
}

export interface VerifiedRagAnswerRecord {
  /** 출력 가드를 전부 통과한 최종 답변(출처 표기 **이전** 본문). */
  answer: string;
  /** provenance payload 링크 (allowlist 밖이면 null). */
  sourceUrl: string | null;
  toneCompliant: boolean;
}

/**
 * claim 판정.
 *   `winner` = 이 worker 가 선점했다 — LLM 을 소비하고 `put`(settle) 또는 `release` 책임.
 *   `wait`   = 다른 worker 가 생성 중이다 — settle 을 대기 후 `get` 재조회.
 *   `hit`    = 이미 settle 된 답이 있다 — `get` 재조회로 즉시 재생.
 */
export type VerifiedRagAnswerClaim = "winner" | "wait" | "hit";

export interface VerifiedRagAnswerStore {
  /** 키 exact 일치·settle 완료 시에만 답을 돌려준다 — fingerprint 하나라도 다르면 null. */
  get: (key: VerifiedRagAnswerKey) => Promise<VerifiedRagAnswerRecord | null>;
  /** grounded 검증 통과 답변만 저장(settle)한다. 실패는 조용히 무시된다(답변 경로 불차단). */
  put: (key: VerifiedRagAnswerKey, record: VerifiedRagAnswerRecord) => Promise<void>;
  /**
   * replay-key 단위 선점 — 동시 첫 miss 에서 정확히 한 worker 만 `winner` 를 받는다.
   * 미구현 저장소는 선점 없이 동작한다(동시 창에서 결정론 보장 없음 — production 은 구현).
   */
  claim?: (key: VerifiedRagAnswerKey) => Promise<VerifiedRagAnswerClaim>;
  /** winner 가 grounded 를 만들지 못했을 때 claim 을 푼다 — loser deadlock 방지. */
  release?: (key: VerifiedRagAnswerKey) => Promise<void>;
  /** loser 대기 폴링 간격(ms). 기본 250. 테스트 저장소가 줄인다. */
  pollDelayMs?: number;
  /** loser 대기 폴링 횟수 상한. 기본 40 (≈10초). */
  pollAttempts?: number;
}
