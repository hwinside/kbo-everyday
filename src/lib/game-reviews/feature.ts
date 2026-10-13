// Enable only after the additive migration and reviewer QA. Rebuild to toggle;
// keeping the shared flag off makes pre-migration deploys safe for existing games.
export const GAME_REVIEWS_ENABLED = process.env.NEXT_PUBLIC_GAME_REVIEWS_ENABLED === "true";
