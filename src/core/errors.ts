export class ComciApiError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(message: string, code: string, statusCode = 500, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ComciApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class ComciRateLimitError extends ComciApiError {
  constructor(message = '요청이 많습니다. 잠시 후 다시 이용해 주세요.') {
    super(message, 'HOUR_RATE_LIMIT', 429);
    this.name = 'ComciRateLimitError';
  }
}

export class ComciServiceBusyError extends ComciApiError {
  constructor(message = '컴시간 서버가 혼잡합니다. 잠시 후 다시 이용해 주세요.') {
    super(message, 'HOUR_SERVICE_BUSY', 503);
    this.name = 'ComciServiceBusyError';
  }
}

export class ComciTokenError extends ComciApiError {
  constructor(message = '접속 토큰이 없거나 만료되었습니다.') {
    super(message, 'HOUR_TOKEN_REQUIRED', 403);
    this.name = 'ComciTokenError';
  }
}

export class ComciParseError extends ComciApiError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 'PARSE_ERROR', 502, options);
    this.name = 'ComciParseError';
  }
}

export class ComciValidationError extends ComciApiError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.name = 'ComciValidationError';
  }
}

export class ComciNotFoundError extends ComciApiError {
  constructor(message: string) {
    super(message, 'NOT_FOUND', 404);
    this.name = 'ComciNotFoundError';
  }
}
