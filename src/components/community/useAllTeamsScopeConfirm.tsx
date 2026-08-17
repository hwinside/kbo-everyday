"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";

/**
 * "전체구단 공개" 확인 모달 (하린아빠 스펙 2026-08-16).
 *
 * 유저가 10개 구단을 하나씩 다 골라(= 전체공개 시도) 등록을 누르면, 작성 화면 3종
 * (일반·사진·투표)이 이 훅으로 확인창을 띄운다.
 *   · 예   → 전체구단 공개로 그대로 등록
 *   · 아니요 → 등록하지 않고 초안 유지 + 공개범위를 최애팀 1개로 축소
 * 판정은 규칙 기반(10팀 전부 선택)이며 내용 AI 판정이 아니다.
 *
 * z-index: 투표 컴포저(z-[10000])·팀 선택 시트(z-[10002]) 위로 확실히 뜨도록
 * **document.body 로 portal** + z-[10050]. 컴포저 안에 그대로 렌더하면
 * 상위 stacking context 에 갇혀 뒤로 가려진다(삼순 NO-GO 2026-08-16).
 *
 * promise 기반으로 3종 컴포저가 문구·동작을 공유한다:
 *   const { confirmAllTeamsScope, allTeamsScopeDialog } = useAllTeamsScopeConfirm();
 *   ... if (await confirmAllTeamsScope()) { 등록 } else { 최애팀 축소 }
 *   ... return (<> ...컴포저... {allTeamsScopeDialog} </>)
 */
export function useAllTeamsScopeConfirm() {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const resolverRef = useRef<((v: boolean) => void) | null>(null);

  // portal 대상(document.body)은 클라이언트 마운트 후에만 존재.
  useEffect(() => {
    setMounted(true);
  }, []);

  const confirmAllTeamsScope = useCallback(() => {
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    setOpen(false);
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(value);
  }, []);

  const content = (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[10050] bg-black/70"
            onClick={() => settle(false)}
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.94 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.94 }}
            transition={{ type: "spring", damping: 26, stiffness: 320 }}
            role="dialog"
            aria-modal="true"
            data-all-teams-scope-confirm
            className="fixed left-1/2 top-1/2 z-[10050] w-[min(20rem,calc(100vw-2.5rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-bg-secondary p-5 shadow-xl"
          >
            <p className="text-base font-semibold text-text-primary">전체구단 공개 확인</p>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">
              전체구단과 관련된 게시물이 아닌 것으로 판단될 경우 공개범위가 제한될 수 있습니다.
              <br />
              전체구단과 관련된 내용인가요?
              <br />
              <span className="text-text-tertiary">
                아니요를 누르면 등록하지 않고 공개범위가 최애팀으로 변경돼요.
              </span>
            </p>
            <div className="mt-5 flex gap-2">
              <button
                type="button"
                onClick={() => settle(false)}
                data-scope-confirm-no
                className="flex-1 rounded-xl bg-bg-tertiary py-3 text-sm font-semibold text-text-secondary"
              >
                아니요
              </button>
              <button
                type="button"
                onClick={() => settle(true)}
                data-scope-confirm-yes
                className="flex-1 rounded-xl bg-accent py-3 text-sm font-semibold text-white"
              >
                예
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );

  // 마운트 전(SSR/최초 렌더)에는 아무것도 렌더하지 않는다. 이후엔 body 로 portal.
  const allTeamsScopeDialog = mounted ? createPortal(content, document.body) : null;

  return { confirmAllTeamsScope, allTeamsScopeDialog };
}
