import { createPool, schema } from './db.js'

const pool = createPool()
try {
  await pool.query(schema)
  console.log('Database schema is ready.')
} catch {
  console.error('Database migration failed. Check connectivity and migration privileges.')
  process.exitCode = 1
} finally {
  await pool.end()
}
