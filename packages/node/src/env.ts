export function requiredEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name]
  if (value == null || value === '') {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

export function optionalEnv(name: string, fallback = '', env: NodeJS.ProcessEnv = process.env): string {
  return env[name] ?? fallback
}

export function integerEnv(name: string, fallback: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = optionalEnv(name, String(fallback), env)
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be an integer.`)
  }
  return value
}

export function booleanEnv(name: string, fallback: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = optionalEnv(name, fallback ? 'true' : 'false', env).trim().toLowerCase()
  if (raw === 'true' || raw === '1' || raw === 'yes') return true
  if (raw === 'false' || raw === '0' || raw === 'no') return false
  throw new Error(`${name} must be a boolean-like value.`)
}

export function jsonEnv<T>(name: string, fallback: string, env: NodeJS.ProcessEnv = process.env): T {
  const raw = optionalEnv(name, fallback, env)
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}
