import { Suspense } from "react";
import { notFound } from "next/navigation";
import { isNewsDiscussionAdmin } from "@/lib/news/discussion-admin";
import NativeNewsCommentsClient from "./NativeNewsCommentsClient";

export default async function NativeNewsCommentsPage() {
  if (!(await isNewsDiscussionAdmin())) notFound();

  return (
    <Suspense fallback={null}>
      <NativeNewsCommentsClient />
    </Suspense>
  );
}

