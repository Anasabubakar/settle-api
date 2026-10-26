/**
 * Every failure the API returns is an `ApiError`: a stable machine-readable code,
 * an HTTP status and a message that is safe to show an operator or a supporter.
 * Internal details (stack traces, upstream bodies) never reach a response.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(400, code, message, details);
export const notFound = (code: string, message: string) => new ApiError(404, code, message);
export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(409, code, message, details);
export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new ApiError(422, code, message, details);
