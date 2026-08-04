// ISO-BMFF(mp4/mov) 상위 박스 순서 파서 — 클라/서버 공용 순수 모듈.
//
// 왜 필요한가(2026-08-04 실측): 실제 업로드본 5건 중 2건(s847/s771)은 moov 가 파일 끝에 있어
// 첫 재생 시작에 사실상 전량 전송이 필요했다. "faststart 인가"는 컨테이너 바이트를 직접 읽어야만
// 알 수 있고, ffprobe 도 이 값을 직접 알려주지 않는다.
//
// 이 모듈은 "use client" 를 붙이지 않는다 — 서버(ffprobe 검증 경로)에서도 같은 판정을 써야 한다.

/** faststart 판정에 읽을 파일 선두 바이트 수(상위 박스 순서 판별용). */
export const MP4_HEAD_PROBE_BYTES = 64 * 1024;

/**
 * 선두 바이트에서 상위 박스 타입을 순서대로 파싱.
 * head 는 파일 앞부분만이므로 끝까지 못 읽는 것이 정상이다. 잘린/손상 박스는 타입까지만
 * 기록하고 종료하며, 어떤 입력에서도 무한 루프에 빠지지 않는다.
 */
export function parseTopLevelBoxTypes(head: Uint8Array): string[] {
  const types: string[] = [];
  if (head.byteLength === 0) return types;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let pos = 0;
  while (pos + 8 <= head.length) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(head[pos + 4], head[pos + 5], head[pos + 6], head[pos + 7]);
    types.push(type);
    let headerBytes = 8;
    if (size === 1) {
      if (pos + 16 > head.length) break; // 64bit 길이가 잘림 — 더 진행 불가
      const hi = view.getUint32(pos + 8);
      const lo = view.getUint32(pos + 12);
      size = hi * 2 ** 32 + lo;
      headerBytes = 16;
    } else if (size === 0) {
      break; // '파일 끝까지' 박스 — 이후 상위 박스 없음
    }
    if (size < headerBytes) break; // 손상
    pos += size;
  }
  return types;
}

/**
 * faststart(moov 가 mdat 앞) 여부. 선두에서 둘 다 못 보면 null(미상).
 * null 은 fail-open 이 아니라 "정규화 결과를 선호"하는 쪽으로 쓰인다.
 */
export function isFastStartMp4(head: Uint8Array): boolean | null {
  for (const type of parseTopLevelBoxTypes(head)) {
    if (type === "moov") return true;
    if (type === "mdat") return false;
  }
  return null;
}
