import type { Metadata } from "next";
import { buildPostMetadata } from "@/lib/share/post-og";

interface Props {
  params: Promise<{ postId: string }>;
  children: React.ReactNode;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { postId } = await params;
  const id = Number(postId);
  return buildPostMetadata(id, `/community/free/${postId}`);
}

export default function FreePostLayout({ children }: Props) {
  return children;
}
