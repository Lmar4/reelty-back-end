export interface ApiResponse<T> {
  success: boolean;
  data?: T | null;
  error?: string;
  message?: string;
}

export function createApiResponse<T>(
  success: boolean,
  data?: T | null,
  message?: string | undefined,
  error?: string | undefined
): ApiResponse<T> {
  return {
    success,
    ...(data !== undefined && { data }),
    ...(message && { message }),
    ...(error && { error }),
  };
}
