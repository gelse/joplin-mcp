import { z } from "zod";

const configSchema = z.object({
  joplinServerUrl: z.string().url().describe("JOPLIN_SERVER_URL"),
  joplinUsername: z.string().min(1).describe("JOPLIN_USERNAME"),
  joplinPassword: z.string().min(1).describe("JOPLIN_PASSWORD"),
  dataApiPort: z
    .coerce.number()
    .int()
    .positive()
    .default(41100)
    .describe("JOPLIN_DATA_API_PORT"),
  logLevel: z
    .enum(["debug", "info", "warn", "error", "silent"])
    .default("info")
    .describe("LOG_LEVEL"),
  syncIntervalSeconds: z
    .coerce.number()
    .int()
    .positive()
    .default(300)
    .describe("SYNC_INTERVAL_SECONDS"),
});

export type Config = z.infer<typeof configSchema>;

export function parseConfig(): Config {
  const env = {
    joplinServerUrl: process.env["JOPLIN_SERVER_URL"],
    joplinUsername: process.env["JOPLIN_USERNAME"],
    joplinPassword: process.env["JOPLIN_PASSWORD"],
    dataApiPort: process.env["JOPLIN_DATA_API_PORT"],
    logLevel: process.env["LOG_LEVEL"],
    syncIntervalSeconds: process.env["SYNC_INTERVAL_SECONDS"],
  };

  const result = configSchema.safeParse(env);

  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  - ${e.path.join(".")}: ${e.message}`)
      .join("\n");
    throw new Error(
      `Configuration validation failed:\n${errors}\n\n` +
        `Ensure the following environment variables are set:\n` +
        `  JOPLIN_SERVER_URL (required)\n` +
        `  JOPLIN_USERNAME (required)\n` +
        `  JOPLIN_PASSWORD (required)\n` +
        `  JOPLIN_DATA_API_PORT (optional, default: 41100)\n` +
        `  LOG_LEVEL (optional, default: "info")\n` +
        `  SYNC_INTERVAL_SECONDS (optional, default: 300)`
    );
  }

  return result.data;
}
