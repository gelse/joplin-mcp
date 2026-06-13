import { describe, it, expect } from "vitest";
import {
  ConfigError,
  DataApiError,
  NotFoundError,
  ConflictError,
  ValidationError,
  AuthError,
} from "../src/errors.js";

describe("Error classes", () => {
  it("ConfigError has correct name", () => {
    const err = new ConfigError("test");
    expect(err.name).toBe("ConfigError");
    expect(err.message).toBe("test");
    expect(err).toBeInstanceOf(Error);
  });

  it("NotFoundError includes resource info", () => {
    const err = new NotFoundError("Note", "abc123");
    expect(err.message).toContain("Note");
    expect(err.message).toContain("abc123");
    expect(err.statusCode).toBe(404);
  });

  it("DataApiError carries status code", () => {
    const err = new DataApiError("Server error", 500, "trace");
    expect(err.statusCode).toBe(500);
    expect(err.responseBody).toBe("trace");
  });

  it("ConflictError has 409 status", () => {
    const err = new ConflictError("Note", "abc123");
    expect(err.statusCode).toBe(409);
  });

  it("ValidationError has 400 status", () => {
    const err = new ValidationError("Invalid input");
    expect(err.statusCode).toBe(400);
  });

  it("AuthError has 401 status and default message", () => {
    const err = new AuthError();
    expect(err.statusCode).toBe(401);
    expect(err.message).toBe("Authentication failed");
  });
});
