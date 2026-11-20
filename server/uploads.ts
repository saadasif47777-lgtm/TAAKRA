import { randomUUID } from 'node:crypto'
import express, { type Request, type RequestHandler } from 'express'
import type { Pool } from 'pg'
import type { Config } from './config.js'
import { documentKeys, type DocumentKey } from './db.js'
import { keyHash } from './registrations.js'
import { MAX_FILE, UPLOAD_PART_SIZE } from './student-fields.js'
import { digest, type IncomingDocument } from './validation.js'

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function uploadKey(settings: Config, id: string) {
  return digest(settings.appSecret, 'upload', id)
}

export function uploadId(req: Request) {
  const id = req.get('Upload-Id') ?? ''
  return uuid.test(id) ? id : null
}

type Part = { kind: DocumentKey; part: number; mimetype: string; total_size: number; data: Buffer }

export function parseRegistrationJson() {
  return express.json({ limit: 8 * 1024, inflate: false })
}

export function createUpload(pool: Pool, settings: Config, check: (token: unknown, ip?: string) => Promise<boolean>): RequestHandler {
  return async (req, res) => {
    if (!(await check(req.body?.challenge, req.ip))) {
      res.status(422).json({ message: 'Complete the security check and try again.', errors: { challenge: 'Complete the security check again.' } })
      return
    }
    const id = randomUUID()
    await pool.query('INSERT INTO upload_sessions (session_key, request_key) VALUES ($1, $2)', [
      uploadKey(settings, id), keyHash(settings, req.get('Idempotency-Key')!),
    ])
    res.status(201).json({ uploadId: id })
  }
}

export function checkUploadPart(req: Request) {
  const { kind, mime, size, part } = req.query
  if (typeof kind !== 'string' || !documentKeys.includes(kind as DocumentKey) ||
      (mime !== 'image/png' && mime !== 'image/jpeg') || typeof size !== 'string' || !/^\d{1,7}$/.test(size) ||
      typeof part !== 'string' || !/^[012]$/.test(part)) return null
  const total = Number(size)
  const index = Number(part)
  const length = Math.min(UPLOAD_PART_SIZE, total - index * UPLOAD_PART_SIZE)
  if (total < 1 || total > MAX_FILE || length < 1) return null
  return { kind, mime, total, index, length }
}

export const parseUploadPart = express.raw({ type: 'application/octet-stream', limit: UPLOAD_PART_SIZE, inflate: false })

export function saveUploadPart(pool: Pool, settings: Config): RequestHandler {
  return async (req, res) => {
    const id = uploadId(req)
    const part = checkUploadPart(req)
    if (!id || !part || !Buffer.isBuffer(req.body) || req.body.length !== part.length) {
      res.status(400).json({ message: 'This image part was incomplete or invalid. Try uploading again.' })
      return
    }
    // An identical retry is accepted. Parts stay immutable while the final submission is being assembled.
    const { rowCount } = await pool.query(`
      INSERT INTO upload_parts (session_key, kind, part, mimetype, total_size, data)
      SELECT session_key, $3, $4, $5, $6, $7 FROM upload_sessions
      WHERE session_key = $1 AND request_key = $2 AND expires_at > now()
      ON CONFLICT (session_key, kind, part) DO UPDATE SET data = upload_parts.data
      WHERE upload_parts.data = excluded.data AND upload_parts.mimetype = excluded.mimetype
        AND upload_parts.total_size = excluded.total_size
    `, [uploadKey(settings, id), keyHash(settings, req.get('Idempotency-Key')!),
      part.kind, part.index, part.mime, part.total, req.body])
    if (rowCount !== 1) {
      res.status(409).json({ message: 'This upload expired or changed. Submit again to start a fresh upload.' })
      return
    }
    res.status(204).end()
  }
}

export async function readUpload(pool: Pool, settings: Config, key: string, id: string) {
  const { rows } = await pool.query<Part>(`
    SELECT p.kind, p.part, p.mimetype, p.total_size, p.data
    FROM upload_sessions s LEFT JOIN upload_parts p USING (session_key)
    WHERE s.session_key = $1 AND s.request_key = $2 AND s.expires_at > now()
    ORDER BY p.kind, p.part
  `, [uploadKey(settings, id), keyHash(settings, key)])
  if (!rows.length) return null

  const files: Partial<Record<DocumentKey, IncomingDocument[]>> = {}
  for (const kind of documentKeys) {
    const parts = rows.filter(row => row.kind === kind)
    const first = parts[0]
    if (!first || parts.length !== Math.ceil(first.total_size / UPLOAD_PART_SIZE) ||
        parts.some((part, index) => part.part !== index || part.total_size !== first.total_size ||
          part.mimetype !== first.mimetype || part.data.length !== Math.min(UPLOAD_PART_SIZE, first.total_size - index * UPLOAD_PART_SIZE))) continue
    files[kind] = [{ mimetype: first.mimetype, buffer: Buffer.concat(parts.map(part => part.data)), size: first.total_size }]
  }
  return files
}

export async function removeUpload(pool: Pool, settings: Config, key: string, id: string) {
  await pool.query('DELETE FROM upload_sessions WHERE session_key = $1 AND request_key = $2', [
    uploadKey(settings, id), keyHash(settings, key),
  ])
}
