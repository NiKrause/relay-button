export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)

  try {
    if (typeof input === 'string' || input instanceof URL) {
      const url = new URL(String(input), globalThis.location?.href)
      url.searchParams.set('_ts', String(Date.now()))

      return await fetch(url, {
        ...init,
        cache: init.cache ?? 'no-store',
        signal: init.signal ?? controller.signal
      })
    }

    return await fetch(input, {
      ...init,
      cache: init.cache ?? 'no-store',
      signal: init.signal ?? controller.signal
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s.`)
    }
    throw error
  } finally {
    globalThis.clearTimeout(timeout)
  }
}
