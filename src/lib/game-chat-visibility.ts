export function shouldKeepCancelledGameChat(input: {
  hasGameProgress: boolean;
  hasExistingMessages: boolean;
}): boolean {
  return input.hasGameProgress || input.hasExistingMessages;
}
