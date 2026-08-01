/** 야잘알봇 시스템 계정. 배포 전 동일 UUID의 auth/profiles 계정을 프로비저닝한다. */
export const BASEBALL_GENIUS_USER_ID = "45ae7419-6a9a-4c6b-9101-8d65df7e242e";
export const BASEBALL_GENIUS_NAME = "야잘알봇";

/** 하린아빠 확정 대기 중인 권장 기본값(spec §8). */
export const BASEBALL_GENIUS_DAILY_LIMIT = 20;
export const BASEBALL_GENIUS_PINNED_ROOM_LEAVABLE = false;
export const BASEBALL_GENIUS_MAX_ANSWER_LENGTH = 200;
export const BASEBALL_GENIUS_MIN_QUESTION_LENGTH = 2;
export const BASEBALL_GENIUS_MAX_QUESTION_LENGTH = 200;

/**
 * 야잘알봇 대화는 쪽지 푸시 알림에서 제외한다 (2026-08-02 하린아빠 지시).
 *
 * - 수신자가 야잘알봇: 시스템 계정이라 유저 질문 수신 푸시 자체가 무의미
 * - 발신자가 야잘알봇: 답변이 도착할 때마다 '✉️ 쪽지' 푸시가 함께 울려 소음이 된다.
 *   답변은 유저가 방금 질문하고 앱에서 확인하는 흐름이라 푸시가 필요 없다.
 *
 * 쪽지 저장·대화 목록·안읽음 표시는 그대로 두고 푸시만 막는다.
 */
export function isBaseballGeniusDmParticipant(
  senderId: string | null | undefined,
  receiverId: string | null | undefined,
): boolean {
  return senderId === BASEBALL_GENIUS_USER_ID || receiverId === BASEBALL_GENIUS_USER_ID;
}
