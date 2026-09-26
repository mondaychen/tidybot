/** An expected, user-facing failure. Printed without a stack trace. */
export class TidyError extends Error {
  constructor(
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}
