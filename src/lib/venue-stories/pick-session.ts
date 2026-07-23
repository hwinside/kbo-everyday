/**
 * 파일 픽 in-flight 세션 상태 머신 (삼순 #805 blocker 라운드3 — identity 결속).
 *
 * iOS는 사진앱 영상 export 때문에 픽커 닫힘 → change 이벤트 사이에 수 초 지연이 있다.
 * 그 사이 사용자가 취소/닫기를 하고 다시 픽을 열면(open A → cancel A → open B),
 * 뒤늦게 도착한 A의 change가 B 세션으로 오인돼 취소한 파일이 되살아나면 안 된다.
 *
 * 그래서 각 open은 고유 토큰(id)을 발급하고, change handler는 자신이 시작한 토큰을
 * 들고 있다가 resolveChange(token)로 검증한다. 현재 활성 토큰과 다르면(=이미 취소됐거나
 * 다른 픽으로 교체됨) late event로 간주해 무시한다.
 *
 * 규칙:
 * - open(): in-flight 픽이 없을 때만 새 토큰 발급(number). 이미 진행 중이면 null(재진입 차단).
 * - cancel(): 수동 취소·컴포저 닫기·reset — 활성 세션 invalidate.
 * - resolveChange(token): 그 토큰이 현재 활성 토큰과 일치할 때만 true(파일 반영)+세션 종료.
 *   불일치면 false(late/stale change 무시), 활성 세션은 건드리지 않는다.
 */
export interface PickSession {
  /** 새 픽 시작. 성공 시 토큰, 진행 중이면 null. */
  open(): number | null;
  /** 활성 세션 취소(수동 취소/닫기/reset). */
  cancel(): void;
  /** change 도착 검증. 발급받은 토큰을 넘긴다. 일치 시 true+종료, 아니면 false. */
  resolveChange(token: number | null): boolean;
  isPicking(): boolean;
}

export function createPickSession(onStateChange?: (picking: boolean) => void): PickSession {
  let activeToken: number | null = null;
  let nextToken = 1;
  const emit = (picking: boolean) => onStateChange?.(picking);

  return {
    open() {
      if (activeToken != null) return null;
      activeToken = nextToken++;
      emit(true);
      return activeToken;
    },
    cancel() {
      if (activeToken == null) return;
      activeToken = null;
      emit(false);
    },
    resolveChange(token) {
      // 발급 토큰이 현재 활성 토큰과 정확히 일치할 때만 유효한 change다.
      if (token == null || token !== activeToken) return false;
      activeToken = null;
      emit(false);
      return true;
    },
    isPicking: () => activeToken != null,
  };
}
