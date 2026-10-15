/** A refusal of an M2 module that routes and the bot turn into an answer with `data.code` (architecture §7). */
export class ServiceError extends Error {
  override name = 'ServiceError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ServiceError(404, 'not_found', `No such ${what}.`);
