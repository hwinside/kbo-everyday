import imageCompression from "browser-image-compression";

const COMMENT_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const COMMENT_IMAGE_COMPRESS_TARGET_MB = 1.2;
const COMMENT_IMAGE_MAX_DIMENSION = 1600;
const ALLOWED_COMMENT_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

const GIPHY_URL_RE = /^https:\/\/media\d*\.giphy\.com\/media\/.+/;
const STORAGE_PHOTOS_URL_RE = /^https?:\/\/[^/\s]+\/storage\/v1\/object\/public\/photos\/\S+$/;

/** 댓글 content가 Giphy GIF URL인지 판별 */
export function isGifComment(content: string): boolean {
  return GIPHY_URL_RE.test(content.trim());
}

/** 댓글 content가 이미지(GIF 또는 우리 photos 버킷 업로드 사진)인지 판별 — 임의 외부 이미지 URL은 제외(원격 콘텐츠/트래킹 리스크) */
export function isImageComment(content: string): boolean {
  const url = content.trim();
  return isGifComment(url) || STORAGE_PHOTOS_URL_RE.test(url);
}

/**
 * 댓글 첨부 이미지를 업로드 전 경량화한다.
 * - jpg/png/webp: 최대 1.2MB / 1600px로 클라이언트 압축(댓글용이라 화질보다 용량 우선)
 * - gif: 애니메이션 보존을 위해 압축하지 않고 8MB 이하만 원본 통과
 */
export async function prepareCommentImageForUpload(file: File): Promise<File> {
  if (!ALLOWED_COMMENT_IMAGE_TYPES.has(file.type)) {
    throw new Error("jpg, png, webp, gif 이미지만 올릴 수 있어요");
  }

  if (file.type === "image/gif") {
    if (file.size > COMMENT_IMAGE_MAX_BYTES) {
      throw new Error("GIF는 8MB 이하만 올릴 수 있어요");
    }
    return file;
  }

  let prepared: File;
  try {
    prepared = await imageCompression(file, {
      maxSizeMB: COMMENT_IMAGE_COMPRESS_TARGET_MB,
      maxWidthOrHeight: COMMENT_IMAGE_MAX_DIMENSION,
      useWebWorker: true,
    });
  } catch {
    throw new Error("이미지 압축에 실패했어요. 다른 이미지로 시도해주세요");
  }

  if (prepared.size > COMMENT_IMAGE_COMPRESS_TARGET_MB * 1024 * 1024) {
    throw new Error("이미지 용량을 줄이지 못했어요. 더 작은 이미지로 시도해주세요");
  }

  return prepared;
}
