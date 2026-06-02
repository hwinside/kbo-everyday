import { getPostShareTitle } from "@/lib/utils/post-share";

export type InstaShareMode = "story" | "reels";
export type InstaShareResult = "shared" | "cancelled" | "unsupported" | "error";

/** 인스타 공유에 필요한 최소 게시글 정보. 호출부에서 구성해 넘긴다. */
export interface InstaSharePost {
  id: number;
  title?: string | null;
  content?: string | null;
  /** 첫 영상 URL (없으면 영상글 아님) */
  videoUrl?: string | null;
}

/** navigator.share + 파일 공유 지원 여부 (기능 감지). */
export function canShareToInstagram(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function"
  );
}

/** 영상글이면 릴스 노출 가능. */
export function canShareReels(post: InstaSharePost): boolean {
  return canShareToInstagram() && Boolean(post.videoUrl);
}

async function urlToFile(url: string, filename: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const blob = await res.blob();
  const type = blob.type || (filename.endsWith(".mp4") ? "video/mp4" : "image/png");
  return new File([blob], filename, { type });
}

/**
 * 인스타로 게시글을 공유한다 (파일 공유 → OS 시트에서 인스타 선택 → 스토리/릴스).
 * - reels: 영상글만. 영상 mp4를 그대로 공유 → 릴스 선택 가능.
 * - story: 영상글이면 영상 그대로(스토리에서 재생), 그 외엔 동적 OG 스토리 카드(1080×1920).
 */
export async function shareToInstagram(post: InstaSharePost, mode: InstaShareMode): Promise<InstaShareResult> {
  if (!canShareToInstagram() || typeof window === "undefined") return "unsupported";

  const isVideoPost = Boolean(post.videoUrl);
  let fileUrl: string;
  let filename: string;

  if (mode === "reels") {
    if (!isVideoPost) return "unsupported";
    fileUrl = post.videoUrl as string;
    filename = `keubo-${post.id}.mp4`;
  } else {
    if (isVideoPost) {
      fileUrl = post.videoUrl as string;
      filename = `keubo-${post.id}.mp4`;
    } else {
      fileUrl = `${window.location.origin}/api/og/post/${post.id}?variant=story`;
      filename = `keubo-${post.id}.png`;
    }
  }

  try {
    const file = await urlToFile(fileUrl, filename);
    if (!navigator.canShare({ files: [file] })) return "unsupported";
    await navigator.share({ files: [file], title: getPostShareTitle(post) });
    return "shared";
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return "cancelled";
    return "error";
  }
}
