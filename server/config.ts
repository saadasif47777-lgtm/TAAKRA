import { z } from 'zod'

export class ConfigurationError extends Error {}

function integer(name: string, fallback: string, min: number, max: number) {
  const result = z.coerce.number().int().min(min).max(max).safeParse(process.env[name] ?? fallback)
  if (!result.success) throw new ConfigurationError(`Invalid ${name}.`)
  return result.data
}

export function config() {
  const production = process.env.NODE_ENV === 'production'
  const organizerName = (process.env.ORGANIZER_NAME ?? '').trim()
  const organizerEmail = (process.env.ORGANIZER_EMAIL ?? '').trim()
  if (organizerName.length > 120 || /\p{Cc}/u.test(organizerName)) throw new ConfigurationError('Invalid ORGANIZER_NAME.')
  if (organizerEmail && !z.email().safeParse(organizerEmail).success) throw new ConfigurationError('Invalid ORGANIZER_EMAIL.')
  const retentionDays = integer('RETENTION_DAYS', '', 1, 365)
  const proxyHops = integer('TRUST_PROXY_HOPS', '0', 0, 5)
  const origin = process.env.PUBLIC_ORIGIN ?? ''
  const siteKey = process.env.TURNSTILE_SITE_KEY ?? ''
  const turnstileSecret = process.env.TURNSTILE_SECRET_KEY ?? ''
  const appSecret = process.env.APP_SECRET ?? ''
  if (appSecret.length < 32) throw new ConfigurationError('APP_SECRET must be at least 32 characters.')
  if (Boolean(siteKey) !== Boolean(turnstileSecret)) throw new ConfigurationError('Configure both Turnstile keys.')
  if (production) {
    const parsed = URL.canParse(origin) ? new URL(origin) : null
    if (parsed?.protocol !== 'https:' || parsed.origin !== origin || !proxyHops || !siteKey) {
      throw new ConfigurationError('Production requires an HTTPS PUBLIC_ORIGIN, a trusted TLS proxy and Turnstile.')
    }
  }
  return {
    production, organizerName, organizerEmail, retentionDays, proxyHops,
    origin, siteKey, turnstileSecret, appSecret,
    port: integer('PORT', '3000', 1, 65535),
    rowLimit: integer('GOOGLE_ROW_LIMIT', '20000', 2, 100000),
  }
}

export type Config = ReturnType<typeof config>

export function need(name: string): string {
  const value = process.env[name]
  if (!value) throw new ConfigurationError(`Missing ${name}.`)
  return value
}
