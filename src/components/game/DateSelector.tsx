"use client";

import { useRef, useEffect } from "react";
import { motion } from "framer-motion";

interface DateSelectorProps {
  selectedDate: string; // YYYY-MM-DD
  onDateChange: (date: string) => void;
}

function getDates(range: number = 7) {
  const dates: { key: string; day: string; weekday: string; isToday: boolean }[] = [];
  const today = new Date();
  
  for (let i = -range; i <= range; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    const day = d.getDate().toString();
    const weekday = ["일", "월", "화", "수", "목", "금", "토"][d.getDay()];
    dates.push({ key, day, weekday, isToday: i === 0 });
  }
  return dates;
}

export default function DateSelector({ selectedDate, onDateChange }: DateSelectorProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const dates = getDates();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const selected = el.querySelector(`[data-date="${selectedDate}"]`) as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ inline: "center", behavior: "smooth" });
    }
  }, []);

  return (
    <div
      ref={scrollRef}
      className="flex gap-1 overflow-x-auto hide-scrollbar py-2 px-3"
    >
      {dates.map((d) => {
        const isSelected = d.key === selectedDate;
        const isSunday = d.weekday === "일";
        const isSaturday = d.weekday === "토";
        return (
          <button
            key={d.key}
            data-date={d.key}
            onClick={() => onDateChange(d.key)}
            className={`relative flex flex-col items-center gap-0.5 rounded-xl px-3 py-2 min-w-[44px] transition-all ${
              isSelected
                ? "bg-accent text-white"
                : "text-text-secondary hover:bg-bg-tertiary"
            }`}
          >
            <span className={`text-xs font-medium ${
              !isSelected && isSunday ? "text-red-400" : 
              !isSelected && isSaturday ? "text-blue-400" : ""
            }`}>
              {d.weekday}
            </span>
            <span className={`text-base font-bold ${isSelected ? "text-white" : ""}`}>
              {d.day}
            </span>
            {d.isToday && !isSelected && (
              <div className="absolute -bottom-0.5 h-1 w-1 rounded-full bg-accent" />
            )}
          </button>
        );
      })}
    </div>
  );
}
