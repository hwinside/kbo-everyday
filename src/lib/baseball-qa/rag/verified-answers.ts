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
 * ── 동시성 — owner-token CAS (삼순 2026-08-19 P0-② + 2차 NO-GO) ────────────
 * 서로 다른 messageId 가 같은 replay 키의 첫 miss 를 동시에 보면 둘 다 LLM 을 부르고
 * 서로 다른 답을 각자 반환할 수 있다. 그래서 저장소가 **replay-key 단위 선점**을
 * 제공하고, 선점은 **owner token** 으로 결속된다(2차 NO-GO — token 없는 선점은
 * lease 인수 뒤 구 winner 의 stale release/settle 이 새 claim 을 지우거나 덮어쓴다):
 *   - `claim` 은 winner 에게 **ownerToken** 을 발급한다. lease 만료 인수는 새 token 으로
 *     교체되므로 죽은 구 winner 의 token 은 그 순간 무효다(fencing).
 *   - `put`(settle)과 `release` 는 그 token 보유자만 성공한다(CAS). settled 는 절대
 *     덮어쓰지 않는다(first-writer-wins). settle CAS 패자는 자기 답을 버리고
 *     canonical(먼저 settle 된) 답을 재조회해 반환한다.
 *   - loser 는 settle 대기 후 재조회하며, **claim(winner) 없이는 절대 생성하지 않는다**
 *     — 폴링 상한 뒤 직접 생성 폴백은 느린 정상 winner(provider 최대 15초)에서
 *     LLM 중복 호출을 만든다(2차 NO-GO 재현 축).
 *   - 저장소 오류(get/claim/put throw)와 invalid 반환은 **fail-close** 다 — 오류를
 *     winner 로 오인해 생성하면 결정론이 조용히 깨진다.
 * claim 미제공 저장소(테스트 전용)는 replay(hit)만 쓰고 선점 없이 동작한다 — 동시 창
 * 결정론을 보장하지 않으므로 production 배선은 반드시 claim 을 구현한다.
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
 *   `winner` = 이 worker 가 선점했다 — **ownerToken** 을 받아 LLM 을 소비하고
 *              `put`(settle, token CAS) 또는 `markInsufficient`(token CAS) 책임을 진다.
 *   `wait`   = 다른 worker 가 생성 중이다 — settle 을 대기 후 `get` 재조회.
 *   `hit`    = 이미 settle 된 답이 있다 — `get` 재조회로 즉시 재생.
 *   `insufficient` = 이 flight 의 winner 가 non-grounded 로 종결했다 — 같은 flight 의
 *              전원이 **같은 폐기 문구**(answer)를 받는다. 재생성 금지(역방향 플립 차단,
 *              삼순 3차 NO-GO). lease TTL 만료 후 새 요청은 새 flight 로 재클레임(token
 *              교체)되므로 일시 실패가 영구 고정되지 않는다(오답 캐시 금지 유지).
 */
export type VerifiedRagAnswerClaim =
  | { verdict: "winner"; ownerToken: string }
  | { verdict: "wait" }
  | { verdict: "hit" }
  | { verdict: "insufficient"; answer: string };

export interface VerifiedRagAnswerStore {
  /** 키 exact 일치·settle 완료 시에만 답을 돌려준다 — fingerprint 하나라도 다르면 null. */
  get: (key: VerifiedRagAnswerKey) => Promise<VerifiedRagAnswerRecord | null>;
  /**
   * settle — grounded 검증 통과 답변을 **token CAS** 로 고정한다.
   * true = 내 답이 canonical. false = CAS 패배(다른 winner 가 먼저 settle 했거나 lease
   * 인수로 token 이 무효) — 호출자는 자기 답을 버리고 canonical 을 재조회해야 한다.
   * settled 행은 어떤 경우에도 덮어쓰지 않는다(first-writer-wins).
   */
  put: (key: VerifiedRagAnswerKey, record: VerifiedRagAnswerRecord, ownerToken?: string) => Promise<boolean>;
  /**
   * replay-key 단위 선점 — 동시 첫 miss 에서 정확히 한 worker 만 winner(token 보유)가 된다.
   * 미구현 저장소(테스트 전용)는 선점 없이 동작한다 — production 은 반드시 구현.
   */
  claim?: (key: VerifiedRagAnswerKey) => Promise<VerifiedRagAnswerClaim>;
  /**
   * winner 가 non-grounded 로 종결했다 — flight 를 `insufficient` 상태로 마킹해 같은
   * flight 의 waiter 전원이 같은 폐기 문구를 재생하게 한다(재생성 금지 — release 로 풀면
   * waiter 가 새 winner 가 되어 같은 동시입력이 2답·LLM 2회가 된다, 삼순 3차 NO-GO).
   * **token CAS** — lease 인수 뒤 구 winner 의 stale mark 는 새 claim 을 건드리지 못한다.
   * lease TTL 까지만 유효 — TTL 후 재클레임이 상태를 인수해 재생성한다(영구 캐시 아님).
   */
  markInsufficient?: (key: VerifiedRagAnswerKey, ownerToken: string, answer: string) => Promise<boolean>;
  /**
   * winner 가 응답 불능(예외·crash 경로)일 때 claim 을 푼다 — loser deadlock 방지.
   * ⚠️ 사용자에게 답을 보낸 뒤에는 쓰지 않는다 — 그 경우는 `markInsufficient` 로 종결해야
   * 같은 flight 재생성(2답 분기)을 막는다.
   * **token CAS** — lease 인수 뒤 구 winner 의 stale release 는 새 claim 을 지우지 못한다.
   */
  release?: (key: VerifiedRagAnswerKey, ownerToken: string) => Promise<void>;
  /** loser 대기 폴링 간격(ms). 기본 250. 테스트 저장소가 줄인다. */
  pollDelayMs?: number;
  /**
   * loser 대기 폴링 횟수 상한. 기본 80 (≈20초) — provider timeout(15초)보다 길게 잡아
   * 느린 정상 winner 를 기다리는 동안 중복 생성으로 새지 않게 한다(2차 NO-GO).
   */
  pollAttempts?: number;
}
