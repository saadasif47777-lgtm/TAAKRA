import { z } from 'zod'

const list = z.array(z.string().trim().min(1).max(100)).max(150)
  .refine(items => new Set(items.map(item => item.toLowerCase())).size === items.length)

function setting(name: string, min = 0): string[] {
  let result
  try {
    result = list.safeParse(JSON.parse(process.env[name] ?? 'null'))
  } catch {
    throw new Error(`Invalid JSON for ${name}.`)
  }
  if (!result.success || result.data.length < min) throw new Error(`Invalid or missing ${name}.`)
  return result.data
}

function integer(name: string, fallback: string, min: number, max: number) {
  const result = z.coerce.number().int().min(min).max(max).safeParse(process.env[name] ?? fallback)
  if (!result.success) throw new Error(`Invalid ${name}.`)
  return result.data
}

export function config() {
  const production = process.env.NODE_ENV === 'production'
  const departments = setting('DEPARTMENTS_JSON', 1)
  const semesters = setting('SEMESTERS_JSON', 1)
  const categories = setting('CATEGORIES_JSON')
  if (categories.some(item => item.toLowerCase() === 'not specified')) {
    throw new Error('Not specified is reserved for omitted categories.')
  }
  const retentionDays = integer('RETENTION_DAYS', '', 1, 365)
  const proxyHops = integer('TRUST_PROXY_HOPS', '0', 0, 5)
  const origin = process.env.PUBLIC_ORIGIN ?? ''
  const siteKey = process.env.TURNSTILE_SITE_KEY ?? ''
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY ?? ''
  const appSecret = process.env.APP_SECRET ?? ''
  if (appSecret.length < 32) throw new Error('APP_SECRET must be at least 32 characters.')
  if (Boolean(siteKey) !== Boolean(turnstileSecret)) throw new Error('Configure both Turnstile keys.')
  if (production) {
    const parsed = new URL(origin)
    if (parsed.protocol !== 'https:' || parsed.origin !== origin || !proxyHops || !siteKey) {
      throw new Error('Production requires an HTTPS PUBLIC_ORIGIN, a trusted TLS proxy and Turnstile.')
    }
  }
  return {
    production, departments, semesters, categories, retentionDays, proxyHops,
    origin, siteKey, turnstileSecret, appSecret,
    port: integer('PORT', '3000', 1, 65535),
    rowLimit: integer('GOOGLE_ROW_LIMIT', '20000', 2, 100000),
  }
}

export type Config = ReturnType<typeof config>

export function need(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}
