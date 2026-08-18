const DEFAULT_BASE_PATH = "/api/v1/foodpanda";

function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return DEFAULT_BASE_PATH;
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.length > 1 && withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
}

export function getFoodpandaPluginBasePath(): string {
  return normalizeBasePath(process.env.FOODPANDA_PLUGIN_BASE_PATH);
}

export function getFoodpandaPluginJwtSecret(): string | null {
  const value = process.env.FOODPANDA_PLUGIN_JWT_SECRET?.trim();
  return value ? value : null;
}
