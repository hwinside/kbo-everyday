import type { ReactNode } from "react";

export default function CommunityCommentRow({
  kind,
  isReply,
  header,
  children,
}: {
  kind: "sheet" | "detail";
  isReply?: boolean;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-community-comment-row={kind} className={isReply ? "pl-10" : ""}>
      {header}
      <div data-community-comment-body className="ml-[50px] min-w-0">
        {children}
      </div>
    </div>
  );
}
