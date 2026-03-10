"use client";

import { Bell } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

interface NotificationCardProps {
  permission: NotificationPermission | "default";
  subscription: PushSubscription | null;
  subscribe: () => Promise<boolean | void>;
  unsubscribe: () => Promise<void>;
  onShowPwaGuide: () => void;
}

export default function NotificationCard({ permission, subscription, subscribe, unsubscribe, onShowPwaGuide }: NotificationCardProps) {
  return (
    <GlassCard className="p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Bell size={22} className="text-text-secondary" />
          <div>
            <span className="text-base text-text-primary">푸시 알림</span>
            <p className="text-xs text-text-tertiary mt-0.5">
              {permission === "granted" ? "경기 시작, 득점 알림 수신 중" : typeof window !== "undefined" && (!("PushManager" in window) || !window.matchMedia("(display-mode: standalone)").matches) ? "홈 화면에 추가하면 알림을 받을 수 있어요 📲" : "경기 알림을 받아보세요"}
            </p>
          </div>
        </div>
        <button
          onClick={async () => {
            const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
            if (!isStandalone || !("PushManager" in window)) {
              onShowPwaGuide();
              return;
            }
            if (permission === "granted" && subscription) {
              await unsubscribe();
            } else {
              await subscribe();
            }
          }}
          className={`relative w-12 h-7 rounded-full transition-colors ${
            permission === "granted" ? "bg-accent" : "bg-bg-tertiary"
          }`}
        >
          <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-transform ${
            permission === "granted" ? "translate-x-5" : "translate-x-0"
          }`} />
        </button>
      </div>
    </GlassCard>
  );
}
