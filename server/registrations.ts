import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Config } from './config.js'
import type { Registration } from './db.js'
import { normalizeRoll } from './student-fields.js'
import { digest, type Document, type validateFields } from './validation.js'

type Fields = ReturnType<typeof validateFields>['fields']

export function receipt(record: Registration) {
  return {
    reference: record.reference, name: record.name,
    submittedAt: record.submitted_at.toISOString(), status: record.status,
  }
}

export function keyHash(settings: Config, key: string) {
  return digest(settings.appSecret, 'receipt', key)
}

export async function saveRegistration(pool: Pool, settings: Config, key: string, fields: Fields, docs: Document[]) {
  const requestKey = keyHash(settings, key)
  const rollKey = digest(settings.appSecret, 'roll', normalizeRoll(fields.roll))
  const payloadHash = digest(settings.appSecret, 'payload', JSON.stringify({
    fields,
    documents: docs.map(doc => [doc.kind, doc.extension, digest(settings.appSecret, 'document', doc.data)]),
  }))
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    // The cursor serializes allocation and is rolled back if anything fails.
    const cursor = await db.query<{ next_row: number }>('SELECT next_row FROM registration_sheet_cursor WHERE singleton FOR UPDATE')
    const previous = (await db.query<Registration & { expired: boolean }>(`
      SELECT *, expires_at <= now() AS expired FROM registrations WHERE request_key = $1 OR roll_key = $2
      ORDER BY (request_key = $1) DESC LIMIT 1
    `, [requestKey, rollKey])).rows[0]
    if (previous) {
      await db.query('ROLLBACK')
      if (previous.request_key === requestKey) {
        if (previous.payload_hash !== payloadHash || previous.expired || previous.status === 'purging') return { conflict: 'request' } as const
        return { record: previous }
      }
      return { conflict: 'roll' } as const
    }
    const row = cursor.rows[0].next_row
    if (row > settings.rowLimit) {
      await db.query('ROLLBACK')
      return { conflict: 'capacity' } as const
    }
    const reference = `TK27-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`
    const { name, roll, department, semester, category, mobile } = fields
    const { rows: [record] } = await db.query<Registration>(`
      INSERT INTO registrations (
        reference, request_key, payload_hash, roll_key, expires_at,
        name, roll, department, semester, category, mobile, sheet_row
      ) VALUES ($1,$2,$3,$4,now() + ($5 * interval '1 day'),$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [reference, requestKey, payloadHash, rollKey, settings.retentionDays, name, roll, department, semester, category, mobile, row])
    for (const doc of docs) {
      await db.query('INSERT INTO registration_documents VALUES ($1,$2,$3,$4)', [reference, doc.kind, doc.extension, doc.data])
    }
    await db.query('UPDATE registration_sheet_cursor SET next_row = next_row + 1 WHERE singleton')
    await db.query('COMMIT')
    return { record }
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  } finally {
    db.release()
  }
}
