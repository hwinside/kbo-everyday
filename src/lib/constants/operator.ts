/**
 * 크보팬 운영팀(시스템) 계정 user_id — 클라이언트에서 "운영팀과의 대화"를 식별하는 SSOT.
 *
 * 서버에서는 `process.env.SYSTEM_USER_ID`(동일 계정 ops@keubo.fan)를 사용한다.
 * 닉네임("크보팬 운영팀") 비교는 위조 가능하므로, 권한성 분기(예: 유저→운영자 전용 기능)는
 * 반드시 이 user_id로 판정한다.
 */
export const OPERATOR_USER_ID = "7b58d68e-e212-40aa-a96d-5018cb82cc81";
