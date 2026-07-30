export type DetailCursor = {
  messageAt: string;
  messageId: string;
};

type DetailRow = {
  id: number | string;
  created_at: string;
};

type QuestionJob = {
  message_id: number | string;
  source: string | null;
  llm_input_tokens: number | null;
  llm_output_tokens: number | null;
};

export function takeDetailPage<T extends DetailRow>(rows: T[], pageSize: number) {
  const hasMore = rows.length > pageSize;
  const page = rows.slice(0, pageSize);
  const oldest = page.at(-1);
  return {
    page,
    nextCursor: hasMore && oldest
      ? { messageAt: oldest.created_at, messageId: String(oldest.id) }
      : null,
  };
}

export function mapQuestionJobsByMessageId(jobs: QuestionJob[]) {
  return new Map(jobs.map((job) => [String(job.message_id), job]));
}

export function createLatestRequestGate() {
  let generation = 0;
  return {
    begin() {
      generation += 1;
      return generation;
    },
    isCurrent(token: number) {
      return generation === token;
    },
    invalidate() {
      generation += 1;
    },
  };
}
