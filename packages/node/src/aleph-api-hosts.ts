export function normalizeAlephApiHost(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, "");

  try {
    if (new URL(normalized).hostname.toLowerCase() === "api3.aleph.im") {
      throw new Error(
        "api3.aleph.im is not supported; configure api2.aleph.im and api.aleph.im instead.",
      );
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("is not supported")) {
      throw error;
    }
  }

  return normalized;
}
