import { createHmac } from 'node:crypto'
import sharp from 'sharp'
import { documentKeys, type DocumentKey } from './db.js'

import { MAX_FILE, validateStudentFields } from './student-fields.js'
export const MAX_REQUEST = 4 * MAX_FILE + 64 * 1024

export const documentLabels: Record<DocumentKey, string> = {
  'passport-photo': 'Passport-size photograph',
  'student-card': 'Student ID card',
  'cnic-front': 'CNIC front',
  'cnic-back': 'CNIC back',
}

export interface Document {
  kind: DocumentKey
  extension: 'jpg' | 'png'
  data: Buffer
}

export function digest(secret: string, scope: string, data: string | Buffer) {
  return createHmac('sha256', secret).update(scope).update('\0').update(data).digest('hex')
}

export function validateFields(body: Record<string, unknown>) {
  const result = validateStudentFields(body)
  if (body.privacy !== 'yes') result.errors.privacy = 'Confirm your information and acknowledge the privacy notice.'
  return result
}

export async function sanitizeDocument(kind: DocumentKey, file: Express.Multer.File): Promise<Document> {
  const jpg = file.mimetype === 'image/jpeg' && file.buffer.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  const png = file.mimetype === 'image/png' && file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if ((!jpg && !png) || !file.size || file.size > MAX_FILE) throw new Error('Invalid document.')
  const image = sharp(file.buffer, { limitInputPixels: 25_000_000, failOn: 'warning' })
  const metadata = await image.metadata()
  if (metadata.format !== (jpg ? 'jpeg' : 'png') || (metadata.pages ?? 1) !== 1) throw new Error('Invalid image.')
  const resized = image.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
  const data = await (jpg ? resized.jpeg({ quality: 90 }) : resized.png()).toBuffer()
  if (data.length > MAX_FILE) throw new Error('Image remains too large.')
  return { kind, extension: jpg ? 'jpg' : 'png', data }
}

export async function validateDocuments(files: Record<string, Express.Multer.File[]>) {
  const docs: Document[] = []
  const errors: Record<string, string> = {}
  for (const kind of documentKeys) {
    const file = files[kind]?.[0]
    if (!file) {
      errors[kind] = `Add your ${documentLabels[kind].toLowerCase()}.`
      continue
    }
    try {
      docs.push(await sanitizeDocument(kind, file))
    } catch {
      errors[kind] = 'Choose a readable JPEG or PNG image, up to 5 MB. Try a smaller image if needed.'
    }
  }
  return { docs, errors }
}
