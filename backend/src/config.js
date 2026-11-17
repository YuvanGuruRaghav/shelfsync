import "dotenv/config";

/**
 * Single source of truth for environment configuration.
 * Variable names follow PLAN.md section 8. Values are read once here.
 */
export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? "",
  databaseSsl: ["1", "true", "yes"].includes(String(process.env.DATABASE_SSL ?? "false").toLowerCase()),
  eventProvider: process.env.EVENT_PROVIDER ?? "log",
  searchProvider: process.env.SEARCH_PROVIDER ?? "postgres",
  reservationTtlMinutes: Number(process.env.RESERVATION_TTL_MINUTES ?? 10),
  reservationExpiryIntervalMs: Number(process.env.RESERVATION_EXPIRY_INTERVAL_MS ?? 30000),
  outboxRelayIntervalMs: Number(process.env.OUTBOX_RELAY_INTERVAL_MS ?? 1000),
  adminKey: process.env.ADMIN_KEY ?? "change-me",
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  kafkaBrokers: (process.env.KAFKA_BROKERS ?? "").split(",").filter(Boolean),
  kafkaSslCa: process.env.KAFKA_SSL_CA ?? "",
  kafkaSslCert: process.env.KAFKA_SSL_CERT ?? "",
  kafkaSslKey: process.env.KAFKA_SSL_KEY ?? "",
  opensearchUrl: process.env.OPENSEARCH_URL ?? "",
  publicApiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000",
};

export default config;
