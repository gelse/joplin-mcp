export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export class CliError extends Error {
  constructor(
    message: string,
    public readonly result: { stdout: string; stderr: string; exitCode: number }
  ) {
    super(message);
    this.name = "CliError";
  }
}

export class SyncError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = "SyncError";
  }
}

export class DataApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly responseBody?: string
  ) {
    super(message);
    this.name = "DataApiError";
  }
}

export class NotFoundError extends DataApiError {
  constructor(resourceType: string, id: string) {
    super(`${resourceType} not found: ${id}`, 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends DataApiError {
  constructor(resourceType: string, id: string) {
    super(`${resourceType} has been modified and conflicts with your changes: ${id}`, 409);
    this.name = "ConflictError";
  }
}

export class ValidationError extends DataApiError {
  constructor(message: string) {
    super(message, 400);
    this.name = "ValidationError";
  }
}

export class AuthError extends DataApiError {
  constructor(message = "Authentication failed") {
    super(message, 401);
    this.name = "AuthError";
  }
}
