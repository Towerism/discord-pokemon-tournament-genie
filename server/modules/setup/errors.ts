/** A refusal the routes turn into an HTTP error with `data.code` (architecture §7). */
export class SetupError extends Error {
  override name = 'SetupError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
