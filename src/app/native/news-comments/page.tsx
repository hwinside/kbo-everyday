import { Suspense } from "react";
import { notFound } from "next/navigation";
import { isNewsDiscussionUser } from "@/lib/news/discussion-auth";
import NativeNewsCommentsClient from "./NativeNewsCommentsClient";

export default async function NativeNewsCommentsPage() {
  if (!(await isNewsDiscussionUser())) notFound();

  return (
    <Suspense fallback={null}>
      <NativeNewsCommentsClient />
    </Suspense>
  );
}

