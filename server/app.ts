import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import helmet from 'helmet'
import multer from 'multer'
import type { Pool } from 'pg'
import type { Config } from './config.js'
import { documentKeys, type Registration } from './db.js'
import { keyHash, receipt, saveRegistration } from './registrations.js'
import { MAX_FILE } from './student-fields.js'
import { digest, MAX_REQUEST, validateDocuments, validateFields } from './validation.js'

const parseUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE + 1, files: 4, fields: 8, parts: 13, fieldSize: 4096, headerPairs: 20 },
}).fields(documentKeys.map(name => ({ name, maxCount: 1 })))

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function throttle(pool: Pool, settings: Config, scope: string, limit: number, seconds: number): RequestHandler {
  return async (req, res, next) => {
    const key = digest(settings.appSecret, scope, req.ip ?? 'unknown')
    const { rows: [result] } = await pool.query<{ hits: number }>(`
      INSERT INTO rate_windows VALUES ($1, 1, now() + ($2 * interval '1 second'))
      ON CONFLICT (client_key) DO UPDATE SET
        hits = CASE WHEN rate_windows.resets_at <= now() THEN 1 ELSE rate_windows.hits + 1 END,
        resets_at = CASE WHEN rate_windows.resets_at <= now() THEN excluded.resets_at ELSE rate_windows.resets_at END
      RETURNING hits
    `, [key, seconds])
    if (result.hits > limit) {
      res.set('Retry-After', String(seconds)).status(429).json({ message: 'Too many requests. Wait a few minutes and try again.' })
      return
    }
    next()
  }
}

async function verifyChallenge(settings: Config, token: unknown, ip: string | undefined) {
  if (!settings.turnstileSecret) return !settings.production
  if (typeof token !== 'string' || !token || token.length > 2048) return false
  const form = new URLSearchParams({ secret: settings.turnstileSecret, response: token })
  if (ip) form.set('remoteip', ip)
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST', body: form, signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error('Bot verification unavailable.')
  const result = await response.json() as { success?: boolean; hostname?: string; action?: string }
  return result.success === true && result.action === 'register' &&
    (!settings.origin || result.hostname === new URL(settings.origin).hostname)
}

export function createApp(pool: Pool, settings: Config, staticPath?: string) {
  const app = express()
  app.set('trust proxy', settings.proxyHops)
  app.disable('x-powered-by')
  app.use(helmet({
    strictTransportSecurity: settings.production ? undefined : false,
    contentSecurityPolicy: {
      directives: {
        scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
        frameSrc: ['https://challenges.cloudflare.com'],
        imgSrc: ["'self'", 'blob:', 'data:'],
        connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
        upgradeInsecureRequests: settings.production ? [] : null,
      },
    },
  }))
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })
  app.use((req, res, next) => {
    if (settings.production && !req.secure && req.path !== '/healthz') {
      res.status(400).json({ message: 'Use the secure registration website.' })
      return
    }
    next()
  })
  app.get('/healthz', async (_req, res) => {
    await pool.query('SELECT next_row FROM registration_sheet_cursor WHERE singleton')
    res.json({ status: 'ok' })
  })
  app.get('/api/config', (_req, res) => {
    const { organizerName, organizerEmail, retentionDays, siteKey } = settings
    res.json({ organizerName, organizerEmail, retentionDays, siteKey })
  })

  app.get('/api/registration', throttle(pool, settings, 'receipt-ip', 180, 60), async (req, res) => {
    const key = req.get('Idempotency-Key') ?? ''
    if (!uuid.test(key)) {
      res.status(400).json({ message: 'The receipt key is invalid.' })
      return
    }
    const { rows: [record] } = await pool.query<Registration>(`
      SELECT * FROM registrations WHERE request_key = $1 AND status <> 'purging' AND expires_at > now()
    `, [keyHash(settings, key)])
    if (!record) {
      res.status(404).json({ message: 'No registration was found for this receipt.' })
      return
    }
    res.json(receipt(record))
  })

  let uploading = 0
  app.post('/api/registration', (req, res, next) => {
    if ((settings.origin && req.get('Origin') !== settings.origin) || !uuid.test(req.get('Idempotency-Key') ?? '')) {
      res.status(400).json({ message: 'Open the registration page and try again.' })
      return
    }
    next()
  }, throttle(pool, settings, 'submit-ip', 30, 600), async (req, res) => {
    if (req.aborted || res.destroyed) return
    const length = Number(req.get('Content-Length'))
    if (!req.is('multipart/form-data') || !Number.isSafeInteger(length) || length < 1) {
      res.status(400).json({ message: 'Submit the registration form with its four images.' })
      return
    }
    if (length > MAX_REQUEST) {
      res.status(413).json({ message: 'Use four images of 5 MB or less.' })
      return
    }
    if (uploading >= 4) {
      res.set('Retry-After', '10').status(503).json({ message: 'Uploads are busy. Wait a moment and try again.' })
      return
    }
    uploading++
    try {
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(new Error('Upload aborted.'))
        req.once('aborted', aborted)
        parseUpload(req, res, error => {
          req.off('aborted', aborted)
          if (error) reject(error)
          else resolve()
        })
      })
      const key = req.get('Idempotency-Key')!
      const { fields, errors } = validateFields(req.body ?? {})
      if (Object.keys(errors).length) {
        res.status(422).json({ message: 'Check the highlighted fields.', errors })
        return
      }
      const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>
      const oversized = documentKeys.find(kind => (files[kind]?.[0]?.size ?? 0) > MAX_FILE)
      if (oversized) {
        const message = 'Choose an image of 5 MB or less.'
        res.status(413).json({ message, errors: { [oversized]: message } })
        return
      }
      const existing = await pool.query('SELECT 1 FROM registrations WHERE request_key = $1', [keyHash(settings, key)])
      if (!existing.rowCount && !(await verifyChallenge(settings, req.body.challenge, req.ip))) {
        res.status(422).json({ message: 'Complete the security check and try again.', errors: { challenge: 'Complete the security check again.' } })
        return
      }
      const { docs, errors: documentErrors } = await validateDocuments(files)
      if (Object.keys(documentErrors).length) {
        res.status(422).json({ message: 'Check the highlighted documents.', errors: documentErrors })
        return
      }
      const result = await saveRegistration(pool, settings, key, fields, docs)
      if (result.record) {
        res.status(result.record.status === 'complete' ? 200 : 202).json(receipt(result.record))
      } else if (result.conflict === 'roll') {
        res.status(409).json({ message: 'This roll number is already registered.', errors: { roll: 'A registration already exists for this roll number.' } })
      } else if (result.conflict === 'request') {
        res.status(409).json({ message: 'This submission differs from the original. Check the existing receipt.' })
      } else {
        res.status(503).json({ message: 'Registration is currently unavailable. Try again later.' })
      }
    } finally {
      uploading--
    }
  })

  app.use('/api', (_req, res) => { res.status(404).json({ message: 'This request could not be found.' }) })
  if (staticPath) {
    app.use(express.static(staticPath))
    app.get('/', (_req, res) => { res.sendFile('index.html', { root: staticPath }) })
  }
  const handleError: ErrorRequestHandler = (error, req, res, next) => {
    if (req.aborted || res.destroyed) return
    if (res.headersSent) { next(new Error('A registration HTTP request failed.')); return }
    if (error instanceof multer.MulterError) {
      const oversized = error.code === 'LIMIT_FILE_SIZE'
      const message = oversized ? 'Choose an image of 5 MB or less.' : 'Attach one image for each required document.'
      const field = documentKeys.find(kind => kind === error.field)
      res.status(oversized ? 413 : 422).json({ message, ...(field ? { errors: { [field]: message } } : {}) })
      return
    }
    if (typeof error?.message === 'string' && /^(Multipart:|Unexpected end of form|Malformed part header)/.test(error.message)) {
      res.status(400).json({ message: 'The upload was incomplete. Try again.' })
      return
    }
    console.warn('A registration HTTP request failed.')
    res.status(503).json({ message: 'The registration service is temporarily unavailable. Try again shortly.' })
  }
  app.use(handleError)
  return app
}
