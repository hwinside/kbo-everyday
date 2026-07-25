import { Suspense } from "react";
import { notFound } from "next/navigation";
import { isNewsDiscussionUser } from "@/lib/news/discussion-auth";
import NativeNewsCommentsClient from "./NativeNewsCommentsClient";

// 네이티브 댓글 오버레이는 로그인 유저 전용(admin-only 해제 = 전체 로그인 유저).
// 미로그인은 그 이전 단계(웹/네이티브 CTA)에서 LoginSheet로 유도하므로 이 페이지까지
// 도달하면 로그인 상태다. 작성은 CommentSheet(user 필수)가 다시 막는다.
export default async function NativeNewsCommentsPage() {
  if (!(await isNewsDiscussionUser())) notFound();

  return (
    <Suspense fallback={null}>
      <NativeNewsCommentsClient />
    </Suspense>
  );
}

