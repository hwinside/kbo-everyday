"use client";

import { useState } from "react";
import WritePost from "@/components/community/WritePost";
import WritePhotoPost from "@/components/community/WritePhotoPost";
import WriteEntrySheet from "@/components/community/WriteEntrySheet";
import LoginSheet from "@/components/auth/LoginSheet";
import { createPost } from "@/lib/supabase/usePosts";

export type WriteFlowMode = "entry" | "login" | null;

interface CommunityWriteFlowProps {
  /** 진입 모드 — 부모가 클릭 시점에 결정(로그인 유저 "entry", 비로그인 "login"). null=닫힘. */
  mode: WriteFlowMode;
  /** 플로우가 닫히면 호출 — 부모가 mode를 null로 되돌린다. */
  onClose: () => void;
  /** 작성 성공 시 호출 — 호스트가 자기 피드를 갱신(예: 홈 최신글 reload). */
  onPosted?: () => void;
}

/**
 * 커뮤니티 글쓰기 플로우(타입 선택 → 사진글/일반글 컴포저)를 *페이지 이동 없이*
 * 현재 화면 위에 모달로 띄운다. 홈 '새 글 올리기' CTA가 커뮤니티(전체글)로 이동한 뒤
 * 시트를 열던 걸, 배경 전환 없이 그 자리에서 작성하도록 바꾸기 위함(하린아빠 스펙).
 *
 * 작성 글은 자유게시판(free/general)+선택 태그 — all-posts FAB 플로우와 동일한 대상.
 * 로그인/작성 분기는 부모 이벤트 핸들러에서 결정(mode)하므로 effect·레이스가 없다.
 */
export default function CommunityWriteFlow({ mode, onClose, onPosted }: CommunityWriteFlowProps) {
  // 타입 선택 후 어떤 컴포저를 열지(엔트리 시트의 하위 상태).
  const [composer, setComposer] = useState<"write" | "photo" | null>(null);

  const close = () => {
    setComposer(null);
    onClose();
  };

  return (
    <>
      <WriteEntrySheet
        isOpen={mode === "entry" && composer === null}
        onClose={close}
        onChoosePhoto={() => setComposer("photo")}
        onChooseText={() => setComposer("write")}
      />
      <WritePost
        isOpen={composer === "write"}
        onClose={close}
        teamName="자유게시판"
        enableTags
        onSubmit={async (title, content, imageUrls, _seatInfo, tags) => {
          await createPost({
            boardType: "free",
            boardId: "general",
            title,
            content,
            imageUrls,
            teamTags: tags?.teamTags,
            playerTags: tags?.playerTags,
          });
          onPosted?.();
          close();
        }}
      />
      <WritePhotoPost
        isOpen={composer === "photo"}
        onClose={close}
        teamName="자유게시판"
        boardType="free"
        boardId="general"
        onSuccess={() => { onPosted?.(); close(); }}
      />
      {mode === "login" && <LoginSheet isOpen onClose={close} />}
    </>
  );
}
