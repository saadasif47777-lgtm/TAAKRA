import type { Pool, PoolClient } from 'pg'
import { documentKeys, type Registration } from './db.js'
import type { GoogleStorage } from './google.js'
import type { Document } from './validation.js'

const lock = 20270109
type WorkerStorage = GoogleStorage | null

export async function syncNext(pool: Pool, google: WorkerStorage) {
  const db = await pool.connect()
  let locked = false
  let discard = false
  try {
    locked = (await db.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock($1) AS acquired', [lock])).rows[0].acquired
    if (!locked) return false
    await db.query('DELETE FROM rate_windows WHERE resets_at < now()')
    const job = (await db.query<Registration>(`
      SELECT * FROM registrations WHERE
        (status = 'complete' AND expires_at <= now()) OR
        (status = 'pending' AND expires_at <= now()) OR
        (next_attempt <= now() AND (status = 'purging' OR (status = 'pending' AND $1::boolean)))
      ORDER BY (expires_at <= now()) DESC, next_attempt, sheet_row LIMIT 1
    `, [Boolean(google)])).rows[0]
    if (!job) return false
    try {
      if (job.status === 'purging' || job.expires_at <= new Date()) await purge(db, job, google)
      else if (google) await synchronize(db, job, google)
    } catch {
      const retrySeconds = Math.min(3600, 5 * 2 ** Math.min(job.attempts, 10))
      await db.query(`
        UPDATE registrations SET attempts = attempts + 1, next_attempt = now() + ($2 * interval '1 second')
        WHERE reference = $1
      `, [job.reference, retrySeconds])
      console.warn('Registration worker operation failed. A retry has been scheduled.')
    }
    return true
  } catch {
    discard = true
    throw new Error('Registration worker database operation failed.')
  } finally {
    try {
      if (locked && !discard) await db.query('SELECT pg_advisory_unlock($1)', [lock])
    } catch {
      discard = true
    } finally {
      db.release(discard)
    }
  }
}

async function synchronize(db: PoolClient, record: Registration, google: GoogleStorage) {
  const { rows } = await db.query<Document>(
    'SELECT kind, extension, data FROM registration_documents WHERE reference = $1', [record.reference],
  )
  if (rows.length !== documentKeys.length) throw new Error('Document storage is incomplete.')
  await google.checkResources()
  let ids = record.drive_ids
  if (!ids) {
    ids = await google.reserveIds()
    await db.query('UPDATE registrations SET drive_ids = $2 WHERE reference = $1', [record.reference, ids])
  }
  await google.saveFolder(ids[0], record.reference)
  for (const [index, kind] of documentKeys.entries()) {
    const document = rows.find(row => row.kind === kind)
    if (!document) throw new Error('Required document is missing.')
    await google.saveDocument(ids[index + 1], ids[0], document)
  }
  await google.saveRow(record, ids)
  await db.query('BEGIN')
  try {
    await db.query('DELETE FROM registration_documents WHERE reference = $1', [record.reference])
    await db.query("UPDATE registrations SET status = 'complete', attempts = 0 WHERE reference = $1", [record.reference])
    await db.query('COMMIT')
  } catch (error) {
    await db.query('ROLLBACK')
    throw error
  }
}

async function purge(db: PoolClient, record: Registration, google: WorkerStorage) {
  // Withdraw access to the receipt immediately, including during a Google outage.
  await db.query("UPDATE registrations SET status = 'purging' WHERE reference = $1", [record.reference])
  await db.query('DELETE FROM registration_documents WHERE reference = $1', [record.reference])
  if (record.drive_ids) {
    if (!google) throw new Error('Google access is needed to finish retention cleanup.')
    await google.removeFolder(record.drive_ids[0])
    await google.removeRow(record)
  }
  await db.query('DELETE FROM registrations WHERE reference = $1', [record.reference])
}

export function startWorker(pool: Pool, google: WorkerStorage) {
  let stopping = false
  let current = Promise.resolve()
  let timer: ReturnType<typeof setTimeout>
  const tick = () => {
    current = syncNext(pool, google).then(
      worked => { if (!stopping) timer = setTimeout(tick, worked ? 100 : 2_000) },
      () => {
        console.warn('Registration worker database operation failed. Retrying.')
        if (!stopping) timer = setTimeout(tick, 5_000)
      },
    )
  }
  tick()
  return async () => {
    stopping = true
    clearTimeout(timer)
    await current
  }
}
