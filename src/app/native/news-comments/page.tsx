import { Suspense } from "react";
import NativeNewsCommentsClient from "./NativeNewsCommentsClient";

// 네이티브 댓글 오버레이 페이지는 공개다(비로그인 포함) — 댓글 조회는 열리고,
// 작성은 CommentSheet(user 필수→LoginSheet)가 막는다. 로그인 전용 하드 게이트로
// 두면 비로그인이 네이티브 CTA 탭 시 빈 화면으로 끝나 LoginSheet 에 도달하지 못한다.
export default function NativeNewsCommentsPage() {
  return (
    <Suspense fallback={null}>
      <NativeNewsCommentsClient />
    </Suspense>
  );
}

