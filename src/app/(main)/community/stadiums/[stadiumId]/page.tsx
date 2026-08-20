"use client";

import { useAuth } from "@/lib/supabase/AuthContext";
import LoginSheet from "@/components/auth/LoginSheet";
import WritePost from "@/components/community/WritePost";
import { createPost, updatePost, usePosts, uploadImages, computeImageHashes } from "@/lib/supabase/usePosts";
import type { Post } from "@/lib/supabase/usePosts";
import type { SeatInfo } from "@/components/community/WritePost";
import { getTeamBorderColor } from "@/lib/utils/team-border-color";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import Image from "next/image";
import Link from "next/link";
import { ChevronLeft, MapPin, Ticket, UtensilsCrossed, Armchair, MessageCircle, PenLine, Car, TrainFront, Bus, CalendarDays, X } from "lucide-react";
import StadiumCalendar from "@/components/stadium/StadiumCalendar";
import GlassCard from "@/components/ui/GlassCard";
import { STADIUMS, teamSlugsForStadium } from "@/lib/constants/stadiums";
import { getTeamById, getTeamBgColor } from "@/lib/constants/teams";

type Section = "info" | "food" | "seats" | "reviews" | "tickets";

function SectionChip({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold transition-colors whitespace-nowrap flex-shrink-0 " +
        (active
          ? "bg-text-primary text-bg-primary"
          : "bg-bg-tertiary text-text-secondary")
      }
    >
      {icon}
      {label}
    </button>
  );
}

function EmptyState({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="text-center py-10">
      <div className="mx-auto mb-2 opacity-40">{icon}</div>
      <p className="text-sm text-text-tertiary">{title}</p>
      <p className="text-xs text-text-tertiary/60 mt-1">{subtitle}</p>
    </div>
  );
}

export default function StadiumDetailPage() {
  const { stadiumId } = useParams();
  const router = useRouter();
  const goBack = useSafeBack("/community/stadiums");
  const { user } = useAuth();
  const [showLogin, setShowLogin] = useState(false);
  const [showWrite, setShowWrite] = useState(false);
  const [active, setActive] = useState<Section>("info");
  const [editingSeatPost, setEditingSeatPost] = useState<Post | null>(null);
  const [expandedImageUrl, setExpandedImageUrl] = useState<string | null>(null);

  const stadium = useMemo(
    () => STADIUMS.find((s) => s.id === stadiumId),
    [stadiumId]
  );

  // hooks must run on every render — keep above early return
  const stadiumKey = typeof stadiumId === "string" ? stadiumId : "";
  const seatBoardId = `stadium:${stadium?.id ?? stadiumKey}:seats`;
  const reviewBoardId = `stadium:${stadium?.id ?? stadiumKey}:reviews`;
  const { posts: seatPosts, reload: reloadSeatPosts } = usePosts("stadium", seatBoardId, "general");
  const { posts: reviewPosts, reload: reloadReviewPosts } = usePosts("stadium", reviewBoardId, "general");

  // 라이트박스: ESC 키로 닫기 (데스크탑 접근성)
  useEffect(() => {
    if (!expandedImageUrl) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpandedImageUrl(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expandedImageUrl]);

  if (!stadium)
    return (
      <div className="flex items-center justify-center h-screen text-text-secondary">
        구장을 찾을 수 없습니다
      </div>
    );

  const teams = stadium.teamIds.map((id) => getTeamById(id)!).filter(Boolean);
  const primaryTeam = teams[0];

  return (
    <div className="min-h-screen bg-bg-primary pb-24">
      {/* Sticky Header */}
      <div className="sticky top-0 z-30 border-b bg-bg-primary" style={{ borderColor: primaryTeam?.colorPrimary ? getTeamBorderColor(primaryTeam.colorPrimary, primaryTeam.colorLight) : undefined, paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <div className="flex items-center gap-3 px-4 min-h-[44px]">
          <button onClick={goBack} aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors -ml-2.5">
            <ChevronLeft size={24} />
          </button>
          <span className="min-w-0 flex-1 truncate text-lg font-semibold text-text-primary">구장</span>
        </div>
      </div>

      {/* Stadium Hero */}
      <div
        className="relative px-5 pb-5 pt-4"
        style={{
          background: `linear-gradient(135deg, ${getTeamBgColor(primaryTeam)}20, transparent)`,
        }}
      >
        <div className="flex items-center gap-3 mb-2">
          {teams.map((t) => (
            <div
              key={t.id}
              className="w-10 h-10 rounded-full bg-white p-1 flex items-center justify-center"
            >
              <Image
                src={t.logoPath}
                alt=""
                width={28}
                height={28}
                unoptimized
                className="object-contain"
              />
            </div>
          ))}
        </div>
        <h1 className="text-lg font-semibold text-text-primary">{stadium.name}</h1>
        <div className="flex items-center gap-3 mt-1 text-sm text-text-tertiary">
          <span className="flex items-center gap-1">
            <MapPin size={14} />
            {stadium.city}
          </span>
          <span>{stadium.capacity}석</span>
        </div>

        {/* Ticket CTA */}
        <div className="mt-4">
          <Link
            href={`/community/tickets?venue=${stadium.id}`}
            className="inline-flex items-center gap-2 rounded-full bg-accent/20 text-accent px-4 py-2 text-sm font-semibold"
          >
            <Ticket size={16} />
            티켓 양도 보기
          </Link>
        </div>
      </div>

      {/* Sticky section chips */}
      <div
        className="bg-bg-primary/95 backdrop-blur-xl border-b"
        style={{ borderColor: primaryTeam?.colorPrimary ? getTeamBorderColor(primaryTeam.colorPrimary, primaryTeam.colorLight) : 'var(--color-border)' }}
      >
        <div className="mx-auto max-w-lg px-5 min-h-[44px] flex items-center gap-2 overflow-x-auto hide-scrollbar">
          <SectionChip
            active={active === "info"}
            onClick={() => setActive("info")}
            label="기본정보"
            icon={<MapPin size={14} />}
          />
          <SectionChip
            active={active === "food"}
            onClick={() => setActive("food")}
            label="먹거리"
            icon={<UtensilsCrossed size={14} />}
          />
          <SectionChip
            active={active === "seats"}
            onClick={() => setActive("seats")}
            label="좌석팁"
            icon={<Armchair size={14} />}
          />
          <SectionChip
            active={active === "tickets"}
            onClick={() => setActive("tickets")}
            label="예매"
            icon={<CalendarDays size={14} />}
          />
          <SectionChip
            active={active === "reviews"}
            onClick={() => setActive("reviews")}
            label="후기"
            icon={<MessageCircle size={14} />}
          />
        </div>
      </div>

      <div className="px-5 py-4">
        {active === "info" && (
          <section className="space-y-4">
            <div>
              <h2 className="text-base font-bold text-text-primary mb-3">🏟️ 기본 정보</h2>
              <GlassCard className="p-4">
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">구장명</span>
                    <span className="text-text-primary font-medium">{stadium.name}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">위치</span>
                    <span className="text-text-primary font-medium">{stadium.city}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">수용 인원</span>
                    <span className="text-text-primary font-medium">{stadium.capacity}석</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">연고팀</span>
                    <span className="text-text-primary font-medium">{teams.map(t => t.name).join(", ")}</span>
                  </div>
                </div>
              </GlassCard>
            </div>

            <div>
              <h2 className="text-base font-bold text-text-primary mb-3">🎫 티켓</h2>
              <GlassCard className="p-4">
                <div className="space-y-3 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">구매처</span>
                    <span className="text-text-primary font-medium text-right">{stadium.ticketing.provider}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-tertiary">가격대</span>
                    <span className="text-text-primary font-medium text-right">{stadium.ticketing.priceRange}</span>
                  </div>
                </div>
              </GlassCard>
            </div>

            <div>
              <h2 className="text-base font-bold text-text-primary mb-3">🅿️ 주차</h2>
              <GlassCard className="p-4">
                <div className="space-y-3 text-sm">
                  <div className="flex items-start gap-3">
                    <Car size={16} className="text-text-tertiary mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-text-primary font-medium">{stadium.parking.fee}</p>
                      <p className="text-text-tertiary mt-1">{stadium.parking.tips}</p>
                    </div>
                  </div>
                </div>
              </GlassCard>
            </div>

            <div>
              <h2 className="text-base font-bold text-text-primary mb-3">🚇 대중교통</h2>
              <GlassCard className="p-4">
                <div className="space-y-4 text-sm">
                  <div className="flex items-start gap-3">
                    <TrainFront size={16} className="text-text-tertiary mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-xs text-text-tertiary mb-0.5">지하철</p>
                      <p className="text-text-primary">{stadium.transit.subway}</p>
                    </div>
                  </div>
                  <div className="flex items-start gap-3">
                    <Bus size={16} className="text-text-tertiary mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-xs text-text-tertiary mb-0.5">버스</p>
                      <p className="text-text-primary">{stadium.transit.bus}</p>
                    </div>
                  </div>
                </div>
              </GlassCard>
            </div>
          </section>
        )}

        {active === "food" && (
          <section>
            <h2 className="text-base font-bold text-text-primary mb-3">🍗 먹거리</h2>
            <GlassCard className="p-4">
              <div className="flex flex-wrap gap-2">
                {stadium.foodBrands.map((brand) => (
                  <span
                    key={brand}
                    className="inline-block px-3 py-1.5 rounded-full bg-bg-tertiary text-sm text-text-secondary font-medium"
                  >
                    {brand}
                  </span>
                ))}
              </div>
            </GlassCard>
            <p className="text-xs text-text-tertiary/60 mt-3 text-center">
              매점 구성은 시즌에 따라 변경될 수 있어요
            </p>
          </section>
        )}

        {active === "seats" && (
          <section>
            <h2 className="text-base font-bold text-text-primary mb-3">💺 좌석팁</h2>
            {seatPosts.length === 0 ? (
              <EmptyState
                icon={<Armchair size={32} />}
                title="아직 제보가 없어요"
                subtitle="좌석별 꿀팁을 남겨보세요"
              />
            ) : (
              <div className="space-y-3">
                {seatPosts.map((post) => {
                  const isAuthor = !!user && user.id === post.author_id;
                  const isEdited = !!post.updated_at && post.updated_at !== post.created_at;
                  return (
                    <GlassCard key={post.id} className="p-4">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <p className="text-sm font-semibold text-text-primary">{post.title}</p>
                        <span className="text-xs text-text-tertiary whitespace-nowrap">
                          {new Date(post.created_at).toLocaleDateString("ko-KR")}{isEdited ? " · 수정됨" : ""}
                        </span>
                      </div>
                      {/* 좌석 구역 태그 */}
                      {post.seat_info && (
                        <div className="flex flex-wrap gap-1.5 mb-2">
                          <span className="inline-block px-2 py-0.5 rounded-full bg-accent/15 text-accent text-xs font-medium">
                            {post.seat_info.zone}
                          </span>
                          {post.seat_info.block && (
                            <span className="inline-block px-2 py-0.5 rounded-full bg-bg-tertiary text-text-secondary text-xs">
                              {post.seat_info.block}{post.seat_info.block.endsWith("블록") ? "" : "블록"}
                            </span>
                          )}
                          {post.seat_info.row && (
                            <span className="inline-block px-2 py-0.5 rounded-full bg-bg-tertiary text-text-secondary text-xs">
                              {post.seat_info.row}{post.seat_info.row.endsWith("열") ? "" : "열"}
                            </span>
                          )}
                          {post.seat_info.seat && (
                            <span className="inline-block px-2 py-0.5 rounded-full bg-bg-tertiary text-text-secondary text-xs">
                              {post.seat_info.seat}{post.seat_info.seat.endsWith("번") ? "" : "번"}
                            </span>
                          )}
                        </div>
                      )}
                      <p className="text-sm text-text-secondary whitespace-pre-wrap">{post.content}</p>
                      {/* 이미지 썸네일 — 탭 시 라이트박스 */}
                      {post.image_urls && post.image_urls.length > 0 && (
                        <div className="flex gap-2 mt-3 overflow-x-auto">
                          {post.image_urls.map((url, i) => (
                            <button
                              key={i}
                              type="button"
                              onClick={() => setExpandedImageUrl(url)}
                              className="relative flex-shrink-0 w-24 h-24 rounded-lg overflow-hidden active:opacity-80"
                              aria-label="좌석팁 이미지 크게 보기"
                            >
                              <Image src={url} alt="" fill className="object-cover" unoptimized />
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-3 mt-3">
                        <p className="text-xs text-text-tertiary">{post.nickname || "익명"}</p>
                        {isAuthor && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingSeatPost(post);
                              setShowWrite(true);
                            }}
                            className="rounded-full bg-bg-tertiary px-3 py-1.5 text-xs font-semibold text-text-secondary active:bg-bg-secondary"
                          >
                            수정
                          </button>
                        )}
                      </div>
                    </GlassCard>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {active === "tickets" && (
          <section>
            <h2 className="text-base font-bold text-text-primary mb-3">🎫 예매</h2>
            <StadiumCalendar stadium={stadium} />
          </section>
        )}

        {active === "reviews" && (
          <section>
            <h2 className="text-base font-bold text-text-primary mb-3">💬 후기</h2>
            {reviewPosts.length === 0 ? (
              <EmptyState
                icon={<MessageCircle size={32} />}
                title="아직 후기가 없어요"
                subtitle="첫 번째 후기를 남겨보세요!"
              />
            ) : (
              <div className="space-y-3">
                {reviewPosts.map((post) => (
                  <GlassCard key={post.id} className="p-4">
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <p className="text-sm font-semibold text-text-primary">{post.title}</p>
                      <span className="text-xs text-text-tertiary whitespace-nowrap">
                        {new Date(post.created_at).toLocaleDateString("ko-KR")}
                      </span>
                    </div>
                    <p className="text-sm text-text-secondary whitespace-pre-wrap">{post.content}</p>
                    <p className="text-xs text-text-tertiary mt-3">{post.nickname || "익명"}</p>
                  </GlassCard>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {/* FAB */}
      {(active === "seats" || active === "reviews") && (
        <button
          onClick={() => {
            if (!user) {
              setShowLogin(true);
              return;
            }
            setEditingSeatPost(null); // 새 글쓰기 모드
            setShowWrite(true);
          }}
          className="fixed bottom-24 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-white shadow-lg shadow-accent/30 transition-transform hover:scale-105 active:scale-95"
        >
          <PenLine className="w-6 h-6" />
        </button>
      )}

      <WritePost
        isOpen={showWrite}
        onClose={() => {
          setShowWrite(false);
          setEditingSeatPost(null);
        }}
        teamName={`${stadium.name} ${active === "seats" ? "좌석팁" : "후기"}`}
        seatTipMode={active === "seats"}
        zones={stadium.zones}
        initialTitle={editingSeatPost?.title}
        initialContent={editingSeatPost?.content}
        initialImageUrls={editingSeatPost?.image_urls}
        initialSeatInfo={editingSeatPost?.seat_info ?? null}
        submitText={editingSeatPost ? "저장" : "등록"}
        onSubmit={async (title, content, imageUrls, seatInfo) => {
          if (editingSeatPost) {
            await updatePost(editingSeatPost.id, {
              title,
              content,
              imageUrls,
              seatInfo: seatInfo ?? null,
            });
            await reloadSeatPosts();
            setShowWrite(false);
            setEditingSeatPost(null);
            return;
          }

          await createPost({
            boardType: "stadium",
            boardId: active === "seats" ? seatBoardId : reviewBoardId,
            title,
            content,
            imageUrls,
            contentType: "general",
            // 공개범위 — 구장글은 팀 피커가 없으므로 그 구장의 홈팀에서 파생한다
            // (잠실 → LG·두산). DB 면제로 비워두면 그 board_type 이 공격면이 된다 —
            // board_type 은 클라이언트가 고르는 값이라 면제 자체가 우회로다(삼순 NO-GO 2026-08-07).
            teamTags: teamSlugsForStadium(stadium?.id),
            ...(seatInfo ? { seatInfo } : {}),
          });

          if (active === "seats") {
            await reloadSeatPosts();
          } else {
            await reloadReviewPosts();
          }
          setShowWrite(false);
        }}
      />

      {/* 이미지 라이트박스 (좌석팁 전용) */}
      {expandedImageUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="좌석팁 이미지 크게 보기"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
          onClick={() => setExpandedImageUrl(null)}
        >
          <button
            type="button"
            onClick={() => setExpandedImageUrl(null)}
            className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white"
            aria-label="이미지 닫기"
          >
            <X size={22} />
          </button>
          <div className="relative h-full max-h-full w-full max-w-full" onClick={(e) => e.stopPropagation()}>
            <Image src={expandedImageUrl} alt="" fill className="object-contain" unoptimized />
          </div>
        </div>
      )}

      <LoginSheet isOpen={showLogin} onClose={() => setShowLogin(false)} />
    </div>
  );
}
