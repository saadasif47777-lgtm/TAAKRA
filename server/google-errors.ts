type ProviderError = {
  code?: unknown
  response?: {
    status?: number
    data?: {
      error?: string | {
        status?: unknown
        errors?: { reason?: unknown }[]
        details?: { reason?: unknown }[]
      }
    }
  }
}

const hints: Readonly<Record<string, string>> = {
  SERVICE_DISABLED: 'Enable the named API in the Google Cloud project that owns the OAuth client.',
  accessNotConfigured: 'Enable the named API in the Google Cloud project that owns the OAuth client.',
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'Authorize the organizer again and grant both Google scopes.',
  insufficientPermissions: 'Authorize the organizer again and grant both Google scopes.',
  insufficientFilePermissions: 'Check the organizer’s access to the Google resource.',
  invalid_client: 'Check that the client ID and secret come from the same Google OAuth client.',
  invalid_grant: 'Reauthorize the organizer using a fresh refresh-token file.',
  access_denied: 'Check that the organizer granted access and that the Google account allows it.',
  domainPolicy: 'Check Google Workspace policies with the domain administrator.',
  storageQuotaExceeded: 'Check available storage in Google Drive.',
  rateLimitExceeded: 'Wait a moment and retry.',
  userRateLimitExceeded: 'Wait a moment and retry.',
  PERMISSION_DENIED: 'Check that the organizer has access and both APIs are enabled.',
  INVALID_ARGUMENT: '',
  NOT_FOUND: '',
  RESOURCE_EXHAUSTED: '',
  ETIMEDOUT: 'Check your connection and retry.',
  ECONNRESET: 'Check your connection and retry.',
  ENOTFOUND: 'Check your connection and retry.',
}

export class GoogleRequestError extends Error {
  readonly httpStatus?: number

  constructor(operation: string, error: unknown) {
    const provider = error as ProviderError | null
    const response = provider?.response
    const httpStatus = response?.status
    const validStatus = typeof httpStatus === 'number' && Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599
    const body = response?.data?.error
    const candidates = typeof body === 'object' && body !== null
      ? [
        ...(Array.isArray(body.details) ? body.details.map(item => item?.reason) : []),
        ...(Array.isArray(body.errors) ? body.errors.map(item => item?.reason) : []),
        body.status,
      ]
      : [body]
    const reason = [...candidates, provider?.code].find(
      (value): value is string => typeof value === 'string' && Object.hasOwn(hints, value),
    )
    const codes = [validStatus ? `HTTP ${httpStatus}` : '', reason].filter(Boolean).join(', ')
    super(`${operation} failed${codes ? ` (${codes})` : ' without a Google error code'}.${reason && hints[reason] ? ` ${hints[reason]}` : ''}`)
    this.httpStatus = validStatus ? httpStatus : undefined
  }
}
