"use client";

import { useState } from "react";
import { ChevronDown, CircleHelp } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

const FAQ_ITEMS = [
  {
    question: "스마트워치는 어떻게 연결하나요?",
    answer:
      "폰 앱의 마이페이지에서 최애팀을 설정한 뒤 갤럭시워치는 워치 Play 스토어, 애플워치는 아이폰의 Watch 앱에서 크보팬을 설치해 주세요. 타일이나 컴플리케이션을 추가하면 경기와 순위를 볼 수 있어요. (갤럭시워치 4 이상·Wear OS 3 이상 지원)",
  },
  {
    question: "경기·득점·실점 알림은 어디서 설정하나요?",
    answer:
      "마이페이지 > 알림 설정에서 원하는 알림을 켜고 끌 수 있어요. 알림이 오지 않으면 휴대폰 설정 > 앱 > 크보팬 > 알림도 허용되어 있는지 확인해 주세요.",
  },
  {
    question: "잠금화면 실시간 중계는 어떻게 보나요?",
    answer:
      "아이폰은 마이페이지 > 잠금화면 > 잠금화면 실시간 중계를 켜면 최애팀 경기 시작 30분 전부터 종료까지 볼 수 있어요. 지원되는 Android 16 기기에서는 같은 메뉴에서 잠금화면 라이브 카드를 설정할 수 있고, 그 외 안드로이드 기기는 홈 위젯과 경기 알림을 이용해 주세요.",
  },
  {
    question: "최애선수는 어떻게 지정하나요?",
    answer:
      "로그인 후 마이페이지 > 최애 선수에서 최대 5명까지 지정할 수 있어요. 응원 구단을 변경하면 새 구단의 최애선수를 다시 선택하게 됩니다.",
  },
  {
    question: "뉴스·영상을 본 뒤 어떻게 돌아오나요?",
    answer:
      "iOS·Android 앱에서는 링크가 앱 안 브라우저로 열려요. 완료 또는 뒤로가기를 누르면 보던 크보팬 화면으로 돌아옵니다. 웹·PWA에서는 새 탭으로 열려요.",
  },
  {
    question: "홈 위젯은 어떻게 추가하나요?",
    answer:
      "폰 홈 화면의 빈 곳을 길게 누른 뒤 위젯 > 크보팬에서 경기 중계, 팀 순위, 최애선수 카드를 선택해 추가해 주세요. 원하는 위젯이 보이지 않으면 크보팬 앱을 최신 버전으로 업데이트해 주세요.",
  },
] as const;

export default function FaqCard() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <GlassCard className="overflow-hidden p-0">
      <div className="flex items-start gap-4 p-5">
        <CircleHelp size={22} className="mt-0.5 shrink-0 text-text-secondary" />
        <div>
          <h2 className="text-base font-semibold text-text-primary">자주 묻는 질문 (FAQ)</h2>
          <p className="mt-0.5 text-xs text-text-tertiary">반복 문의가 많았던 내용을 모았어요</p>
        </div>
      </div>

      <div className="divide-y divide-white/10 border-t border-white/10">
        {FAQ_ITEMS.map(({ question, answer }, index) => {
          const isOpen = openIndex === index;
          const answerId = `faq-answer-${index}`;

          return (
            <div key={question}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
                aria-expanded={isOpen}
                aria-controls={answerId}
                onClick={() => setOpenIndex(isOpen ? null : index)}
              >
                <span className="text-sm font-medium text-text-primary">{question}</span>
                <ChevronDown
                  size={18}
                  className={`shrink-0 text-text-tertiary transition-transform ${isOpen ? "rotate-180" : ""}`}
                />
              </button>
              {isOpen && (
                <p id={answerId} className="px-5 pb-4 pr-11 text-sm leading-6 text-text-secondary">
                  {answer}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </GlassCard>
  );
}
