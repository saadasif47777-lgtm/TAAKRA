export type PortalConfig = {
  departments: string[]
  semesters: string[]
  categories: string[]
  retentionDays: number
  siteKey: string
}

export type Receipt = {
  reference: string
  name: string
  submittedAt: string
  status: 'pending' | 'complete'
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public errors: Record<string, string> = {}) {
    super(message)
  }
}

export async function getConfig(signal?: AbortSignal): Promise<PortalConfig> {
  const response = await fetch('/api/config', { signal })
  if (!response.ok) throw new Error('Registration options could not be loaded.')
  return response.json()
}

export async function getReceipt(key: string, signal?: AbortSignal): Promise<Receipt | null> {
  const response = await fetch('/api/registration', {
    headers: { 'Idempotency-Key': key }, signal, cache: 'no-store',
  })
  if (response.status === 404) return null
  if (!response.ok) throw new ApiError('The registration status is temporarily unavailable.', response.status)
  return response.json()
}

export function submit(data: FormData, key: string, onProgress: (percent: number | null) => void) {
  return new Promise<Receipt>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/api/registration')
    request.responseType = 'json'
    request.timeout = 95_000
    request.setRequestHeader('Idempotency-Key', key)
    request.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded * 100 / event.total))
    }
    request.upload.onload = () => onProgress(null)
    request.onload = () => {
      if ((request.status === 200 || request.status === 202) && request.response?.reference) {
        resolve(request.response as Receipt)
        return
      }
      reject(new ApiError(
        request.response?.message ?? (request.status === 413 ? 'Choose four images of 5 MB or less.' : 'Registration could not be submitted. Please try again.'),
        request.status,
        request.response?.errors,
      ))
    }
    request.onerror = request.ontimeout = request.onabort = () => reject(
      new ApiError('The connection was interrupted. Try again to check whether the registration was received.', 0),
    )
    request.send(data)
  })
}
