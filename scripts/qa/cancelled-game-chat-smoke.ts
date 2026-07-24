import assert from "node:assert/strict";
import { shouldKeepCancelledGameChat } from "../../src/lib/game-chat-visibility";

assert.equal(
  shouldKeepCancelledGameChat({ hasGameProgress: true, hasExistingMessages: false }),
  true,
  "중간 취소 경기는 채팅을 유지해야 한다",
);
assert.equal(
  shouldKeepCancelledGameChat({ hasGameProgress: false, hasExistingMessages: true }),
  true,
  "기존 채팅이 있는 취소 경기는 채팅을 유지해야 한다",
);
assert.equal(
  shouldKeepCancelledGameChat({ hasGameProgress: false, hasExistingMessages: false }),
  false,
  "사전 취소되어 열린 적 없는 경기는 채팅을 노출하면 안 된다",
);

console.log("cancelled game chat smoke: PASS");
