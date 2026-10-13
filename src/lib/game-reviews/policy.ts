// Product proposal defaults: change here after the owner's policy decision.
// Routes pass this trusted policy to service-only RPCs and return it to the UI.
// Client request bodies never select policy values.
export type NominationMode = "disabled" | "optional_winner_participant" | "required_winner_participant";
export interface ReviewPolicy {
  bestMinLikes: number;
  allowRecreateAfterDelete: boolean;
  nominationMode: NominationMode;
}
export const REVIEW_POLICY: Readonly<ReviewPolicy> = {
  bestMinLikes: 3,
  allowRecreateAfterDelete: false,
  nominationMode: "optional_winner_participant",
};

export function reviewDeletionMessage(allowRecreate: boolean): string {
  return allowRecreate
    ? "이 한 줄과 댓글은 더 이상 보이지 않으며 복구할 수 없어요. 삭제 후 새 한 줄은 남길 수 있어요."
    : "경기마다 한 줄만 남길 수 있어요. 삭제하면 다시 등록할 수 없고 댓글도 함께 보이지 않아요. 복구할 수 없어요.";
}
