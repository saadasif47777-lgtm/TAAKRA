import { createHmac } from 'node:crypto'
import sharp from 'sharp'
import type { Config } from './config.js'
import { documentKeys, type DocumentKey } from './db.js'

export const MAX_FILE = 5 * 1024 * 1024
export const MAX_REQUEST = 4 * MAX_FILE + 64 * 1024

export const documentLabels: Record<DocumentKey, string> = {
  'passport-photo': 'Passport photograph',
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

export function clean(value: unknown) {
  return typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : ''
}

export function normalizeRoll(value: string) {
  return clean(value).toLowerCase().replace(/\s+/gu, '')
}

export function normalizeMobile(value: string) {
  const compact = clean(value).replace(/[\s()-]/g, '')
  const match = /^(?:0|\+92)(3\d{9})$/.exec(compact)
  return match ? `+92${match[1]}` : null
}

export function validateFields(body: Record<string, unknown>, settings: Config) {
  const name = clean(body.name)
  const roll = clean(body.roll)
  const department = typeof body.department === 'string' ? body.department : ''
  const semester = typeof body.semester === 'string' ? body.semester : ''
  const category = typeof body.category === 'string' ? body.category : ''
  const mobile = normalizeMobile(clean(body.mobile))
  const errors: Record<string, string> = {}
  if (name.length < 2 || name.length > 120 || !/\p{L}/u.test(name) || /\p{Cc}/u.test(name)) {
    errors.name = 'Enter your complete name (2–120 characters).'
  }
  if (roll.length < 2 || roll.length > 80 || !/[\p{L}\p{N}]/u.test(roll) || /\p{Cc}/u.test(roll)) {
    errors.roll = 'Enter your complete roll number (2–80 characters).'
  }
  if (!settings.departments.includes(department)) errors.department = 'Select your department.'
  if (!settings.semesters.includes(semester)) errors.semester = 'Select your semester.'
  if (category && !settings.categories.includes(category)) errors.category = 'Select an available category or leave it blank.'
  if (!mobile) errors.mobile = 'Enter a Pakistani mobile number, such as 0300 1234567 or +92 300 1234567.'
  if (body.privacy !== 'yes') errors.privacy = 'Acknowledge the privacy notice to continue.'
  return { fields: { name, roll, department, semester, category: category || 'Not specified', mobile: mobile ?? '' }, errors }
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
