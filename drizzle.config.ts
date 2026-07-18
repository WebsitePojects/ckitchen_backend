import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/db/schema.ts",
    "./src/db/enterprise-schema.ts",
    "./src/db/returns-schema.ts",
    "./src/db/production-schema.ts",
    "./src/db/customer-orders-schema.ts",
    "./src/db/transfer-orders-schema.ts",
    "./src/db/w4-schema.ts",
    "./src/db/outbound-schema.ts",
  ],
  out: "./drizzle",
});
