export function shouldApplyAutomaticStoryRefresh(input: {
  automatic: boolean;
  requestId: number;
  latestRequestId: number;
  blocked: boolean;
  hidden: boolean;
}): boolean {
  if (!input.automatic) return true;
  return (
    input.requestId === input.latestRequestId &&
    !input.blocked &&
    !input.hidden
  );
}
