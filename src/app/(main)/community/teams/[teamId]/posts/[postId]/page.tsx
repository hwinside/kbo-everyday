"use client";

import { useParams } from "next/navigation";
import PostDetail from "@/components/community/PostDetail";

export default function TeamPostDetailPage() {
  const { postId } = useParams();

  return <PostDetail postId={Number(postId)} />;
}
