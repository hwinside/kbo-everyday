export function shouldCloseCommentSheetDrag(input: {
  armed: boolean;
  deltaX: number;
  deltaY: number;
}): boolean {
  return input.armed && input.deltaY > 80 && input.deltaY > input.deltaX * 1.2;
}
