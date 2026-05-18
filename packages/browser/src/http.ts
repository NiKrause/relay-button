export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController()
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs)

  try {
    if (input instanceof URL) {
      const url = new URL(input.toString())
      url.searchParams.set('_ts', String(Date.now()))

      return await fetch(url, {
        ...init,
        cache: init.cache ?? 'no-store',
        signal: init.signal ?? controller.signal
      })
    }

    if (typeof input === 'string') {
      let requestInput: RequestInfo | URL = input

      try {
        const url = new URL(input, globalThis.location?.href)
        url.searchParams.set('_ts', String(Date.now()))
        requestInput = url
      } catch {
        // Keep relative or otherwise non-URL-like strings untouched when no
        // usable base URL exists in the current runtime.
      }

      return await fetch(requestInput, {
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
