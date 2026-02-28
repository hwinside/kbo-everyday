"use client";

import { motion } from "framer-motion";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
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
      className="mx-auto max-w-lg px-5 pt-safe"
    >
      {/* Header */}
      <motion.header variants={item} className="flex items-center gap-4 py-5">
        <Link href="/" className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
          <ChevronLeft size={24} />
        </Link>
        <h1 className="text-xl font-bold text-text-primary">뉴스 & 영상</h1>
      </motion.header>

      {/* Feed */}
      <motion.div variants={item} className="pb-8">
        <NewsFeed news={MOCK_NEWS} videos={MOCK_VIDEOS} />
      </motion.div>
    </motion.div>
  );
}
