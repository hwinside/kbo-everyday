"use client";

import { useEffect, type Dispatch, type SetStateAction } from "react";
import {
  expireBaseballQaReplyTimeouts,
  getBaseballQaReplyStates,
  readBaseballQaOutbox,
  type BaseballQaReplyStates,
  type StorageLike,
} from "./client-outbox";

interface UseBaseballQaReplyRecoveryOptions {
  replyStates: BaseballQaReplyStates;
  setReplyStates: Dispatch<SetStateAction<BaseballQaReplyStates>>;
  syncReplies: () => void;
  processOutbox: () => void | Promise<void>;
  /** 테스트에서는 메모리 storage를 주입하고, 앱에서는 localStorage를 사용한다. */
  storage?: StorageLike;
  nowMs?: () => number;
}

/** 3초마다 exact 답변을 회수하고, deadline이 지난 질문을 failed UI로 전환한다. */
export function useBaseballQaReplyRecovery({
  replyStates,
  setReplyStates,
  syncReplies,
  processOutbox,
  storage,
  nowMs = Date.now,
}: UseBaseballQaReplyRecoveryOptions) {
  useEffect(() => {
    if (!Object.values(replyStates).some((state) => state !== "failed")) return;
    const activeStorage = storage ?? (typeof window === "undefined" ? null : window.localStorage);
    if (!activeStorage) return;

    const timer = window.setInterval(() => {
      syncReplies();
      expireBaseballQaReplyTimeouts(activeStorage, nowMs());
      setReplyStates(getBaseballQaReplyStates(readBaseballQaOutbox(activeStorage)));
      void processOutbox();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [nowMs, processOutbox, replyStates, setReplyStates, storage, syncReplies]);
}
