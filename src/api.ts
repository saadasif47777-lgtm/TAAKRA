import { UPLOAD_PART_SIZE } from '../server/student-fields'

export type PortalConfig = {
  organizerName: string
  organizerEmail: string
  retentionDays: number
  siteKey: string
  chunkedUploads?: boolean
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
  if (!response.ok) throw new Error('Registration settings could not be loaded.')
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

type Progress = (percent: number | null) => void
const interrupted = () => new ApiError('The connection was interrupted. Try again to check whether the registration was received.', 0)

async function jsonRequest<T>(url: string, key: string, body: object, upload?: string): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Idempotency-Key': key,
        'Content-Type': 'application/json',
        ...(upload ? { 'Upload-Id': upload } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(95_000),
    })
  } catch {
    throw interrupted()
  }
  const result = await response.json().catch(() => null)
  if (!response.ok || !result) {
    throw new ApiError(result?.message ?? 'Registration could not be submitted. Please try again.', response.status, result?.errors)
  }
  return result as T
}

function sendPart(url: string, bytes: Blob, key: string, upload: string, onSent: (bytesSent: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', url)
    request.responseType = 'json'
    request.timeout = 95_000
    request.setRequestHeader('Idempotency-Key', key)
    request.setRequestHeader('Upload-Id', upload)
    request.setRequestHeader('Content-Type', 'application/octet-stream')
    request.upload.onprogress = event => onSent(event.loaded)
    request.onload = () => {
      if (request.status === 204) resolve()
      else reject(new ApiError(request.response?.message ?? 'The document could not be uploaded. Try again.',
        request.status, request.response?.errors))
    }
    request.onerror = request.ontimeout = request.onabort = () => reject(interrupted())
    request.send(bytes)
  })
}

async function submitInParts(data: FormData, key: string, onProgress: Progress, onUploadStart: () => void) {
  const entries = [...data]
  const files = entries.filter((entry): entry is [string, File] => entry[1] instanceof File)
  const fields = Object.fromEntries(entries.filter(([name, value]) => name !== 'challenge' && typeof value === 'string'))
  const { uploadId } = await jsonRequest<{ uploadId: string }>('/api/upload', key, { challenge: data.get('challenge') })
  const total = files.reduce((sum, entry) => sum + entry[1].size, 0)
  let sent = 0
  onUploadStart()
  for (const [kind, file] of files) {
    for (let offset = 0; offset < file.size; offset += UPLOAD_PART_SIZE) {
      const part = file.slice(offset, offset + UPLOAD_PART_SIZE)
      const query = new URLSearchParams({
        kind, mime: file.type, size: String(file.size), part: String(offset / UPLOAD_PART_SIZE),
      })
      await sendPart(`/api/upload?${query}`, part, key, uploadId, bytes => {
        onProgress(Math.round((sent + bytes) * 100 / total))
      })
      sent += part.size
      onProgress(Math.round(sent * 100 / total))
    }
  }
  onProgress(null)
  return jsonRequest<Receipt>('/api/registration', key, fields, uploadId)
}

export function submit(data: FormData, key: string, onProgress: Progress, onUploadStart: () => void, chunkedUploads = false) {
  if (chunkedUploads) return submitInParts(data, key, onProgress, onUploadStart)
  return new Promise<Receipt>((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', '/api/registration')
    request.responseType = 'json'
    request.timeout = 95_000
    request.setRequestHeader('Idempotency-Key', key)
    request.upload.onloadstart = onUploadStart
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
    request.onerror = request.ontimeout = request.onabort = () => reject(interrupted())
    request.send(data)
  })
}
