/**
 * 프로필 작성글 목록 행의 **표시 판정** 순수 계약 — 미리보기 한 줄과 썸네일 슬롯.
 *
 * 렌더 컴포넌트(.tsx)가 아니라 여기 사는 이유: 이 판정들은 DOM 이 필요 없는 순수 함수인데
 * .tsx 안에 있으면 node 가 직접 import 하지 못해 **브라우저가 없는 실행면에서는 검증할 방법이
 * 사라진다**(CI 러너에 chromium 이 없다). 실제로 게이트가 브라우저 없이 돌 때
 * `preview-title-only` 결함주입이 통과해버렸다 — 순수 로직을 .ts 로 내려 그 구멍을 막는다.
 */

/** 사진글 판정의 SSOT — posts.content_type 의 값. */
export const PHOTO_CONTENT_TYPE = "photo";

/**
 * 미리보기 한 줄의 문자 상한. 프로덕션 실측으로 본문 첫 줄은 median 17자·p90 42자지만
 * max 660자라 상한이 없으면 DOM 에 긴 문자열을 그대로 실어 나른다(CSS truncate 는
 * 보이는 것만 가린다). 80자면 p90 을 두 배 이상 덮는다.
 */
export const PROFILE_POST_PREVIEW_MAX = 80;

export interface CommunityProfilePost {
  id: number;
  title: string;
  board_type: string;
  board_id: string;
  like_count: number;
  comment_count: number;
  created_at: string;
  team_tags?: string[] | null;
  player_tags?: string[] | null;
  content_type?: string | null;
  image_urls?: string[] | null;
  video_urls?: string[] | null;
  content?: string | null;
}

/**
 * 목록 행 왼쪽 썸네일 슬롯의 모양.
 *   image — 첫 이미지를 그대로
 *   video — 재생 아이콘 플레이스홀더(영상은 포스터 URL 이 따로 없다)
 *   null  — 슬롯 자체를 그리지 않음
 */
export type ProfilePostThumbnail =
  | { kind: "image"; url: string }
  | { kind: "video" };

/** 빈 문자열·공백·비문자열을 걸러낸 첫 유효 URL. */
function firstUsableUrl(urls: string[] | null | undefined): string | null {
  return urls?.find(url => typeof url === "string" && url.trim().length > 0) ?? null;
}

/**
 * 목록 행에 보여줄 한 줄 텍스트.
 *
 * 제목이 빈 글이 생각보다 많다 — 프로덕션 전수 실측으로 **사진글 1,424건 중 478건**,
 * **일반글 4,440건 중 2,381건**이 `title=""` 이다(사진글은 WritePhotoPost 가 구조적으로
 * 빈 제목을 넣고, 일반글은 유저가 제목 없이 본문만 쓴다). 그래서 제목만 그리던
 * 이전 구현은 목록 절반이 본문 줄 없이 날짜만 떠 있는 화면이었다.
 *
 * 순서: 제목 → 본문 첫 줄. 둘 다 없으면 null 을 돌려 호출부가 썸네일로 대체하게 한다.
 * 본문은 **첫 줄만** 쓴다 — 여러 줄 글(16.9%)을 통째로 넣으면 개행이 공백으로 뭉개져
 * 뜻 모를 문장이 된다. 앞쪽 빈 줄은 건너뛴다.
 */
export function profilePostPreviewText(post: CommunityProfilePost): string | null {
  const title = (post.title ?? "").trim();
  if (title) return title;

  const firstLine = (post.content ?? "")
    .split("\n")
    .map(line => line.trim())
    .find(line => line.length > 0);
  if (!firstLine) return null;

  return firstLine.length > PROFILE_POST_PREVIEW_MAX
    ? `${firstLine.slice(0, PROFILE_POST_PREVIEW_MAX)}\u2026`
    : firstLine;
}

/**
 * 썸네일 슬롯 판정.
 *
 * **사진글에만** 썸네일을 단다(삼순 NO-GO 2026-08-22). 이전 판본은 content_type 을 안 보고
 * image_urls 만 봐서 이미지가 달린 일반글에도 썸네일을 그렸다 — 일반글은 제목·본문이
 * 주인공이므로 사진을 앞에 세우면 목록의 읽힘이 깨진다. 전수 실측상 일반글 4,440건 중
 * 이미지 보유는 5건으로 적지만 0 이 아니라 실제로 오작동하는 경로다.
 *
 * 사진글인데 이미지가 없는 경우는 **전수 1,424건 중 161건**이고 그 **161건이 전부 영상을
 * 가진다** — 그래서 이미지 부재를 "미디어 없음"으로 취급하면 영상글이 다시 날짜만 남는
 * 행이 된다(앞서 "샘플 200건 중 11건"이라 본 것은 절단된 분모였다).
 */
export function profilePostThumbnail(post: CommunityProfilePost): ProfilePostThumbnail | null {
  if (post.content_type !== PHOTO_CONTENT_TYPE) return null;
  const image = firstUsableUrl(post.image_urls);
  if (image) return { kind: "image", url: image };
  if (firstUsableUrl(post.video_urls)) return { kind: "video" };
  return null;
}

/**
 * 미리보기 텍스트가 없을 때 썸네일 종류로 대체 문구를 만든다.
 * 제목·본문이 모두 없는 순수 미디어글은 썸네일이 내용을 대신하므로 종류를 글로 밝힌다.
 */
export function profilePostPreviewFallback(thumbnail: ProfilePostThumbnail | null): string | null {
  if (thumbnail === null) return null;
  return thumbnail.kind === "video" ? "영상" : "사진";
}
