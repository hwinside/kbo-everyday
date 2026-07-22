#!/usr/bin/env node
/**
 * PR #743 레거시 AQ008→56548 이관 검증 (read-only) — 2026-07-21.
 * 마이그레이션 적용 전/후로 실행해 잔존 레거시 참조와 게시판 합류를 확인한다.
 *   적용 전 기대: legacy favorites 3 · legacy board posts 2
 *   적용 후 기대: legacy 전부 0 · 56548 board posts = 기존 + 이관분(2+2=4)
 * 실행: node --env-file=.env.local scripts/qa/kyoyama-legacy-verify.mjs
 */
import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const { data: legacyFavs, error: e1 } = await sb
  .from("profiles")
  .select("id")
  .contains("favorite_players", JSON.stringify([{ playerId: "AQ008" }]));
if (e1) throw e1;

const { count: legacyPosts, error: e2 } = await sb
  .from("posts")
  .select("*", { count: "exact", head: true })
  .eq("board_type", "player")
  .eq("board_id", "AQ008");
if (e2) throw e2;

const { count: newPosts, error: e3 } = await sb
  .from("posts")
  .select("*", { count: "exact", head: true })
  .eq("board_type", "player")
  .eq("board_id", "56548");
if (e3) throw e3;

const { data: newFavs, error: e4 } = await sb
  .from("profiles")
  .select("id")
  .contains("favorite_players", JSON.stringify([{ playerId: "56548" }]));
if (e4) throw e4;

console.log(`legacy AQ008 favorites : ${legacyFavs.length}`);
console.log(`legacy AQ008 board post: ${legacyPosts}`);
console.log(`56548 favorites        : ${newFavs.length}`);
console.log(`56548 board posts      : ${newPosts}`);
console.log(
  legacyFavs.length === 0 && legacyPosts === 0
    ? "✅ legacy refs 0 — 이관 완료 상태"
    : "⏳ legacy refs 잔존 — 마이그레이션 적용 전 상태",
);
