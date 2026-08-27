"use client";

import { motion } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import NewsFeed from "@/components/news/NewsFeed";
import { MOCK_NEWS, MOCK_VIDEOS } from "@/lib/constants/news";

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05 } },
};

const item = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.3 } },
};

export default function NewsPage() {
  return (
    <motion.div
      variants={container}
      initial="hidden"
      animate="show"
      className="mx-auto max-w-lg px-5"
    >
      {/* Header */}
      <div className="sticky top-0 z-30 -mx-5 border-b border-border bg-bg-primary px-5" style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
      <motion.header variants={item} className="flex items-center gap-2 min-h-[44px]">
        <Link href="/" aria-label="뒤로가기" className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </Link>
        <h1 className="truncate text-lg font-bold text-text-primary flex-1">뉴스 & 영상</h1>
        <HeaderProfileLink />
      </motion.header>
      </div>

      {/* Feed */}
      <motion.div variants={item} className="pb-8">
        <NewsFeed news={MOCK_NEWS} videos={MOCK_VIDEOS} />
      </motion.div>
    </motion.div>
  );
}
