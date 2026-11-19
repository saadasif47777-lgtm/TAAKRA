import { resolve } from 'node:path'
import { createApp } from './app.js'
import { config, ConfigurationError } from './config.js'
import { createPool, migrateDatabase } from './db.js'
import { configuredGoogle } from './google.js'
import { startWorker } from './worker.js'

async function main() {
  const settings = config()
  const google = settings.production || process.env.GOOGLE_AUTH_MODE ? await configuredGoogle(settings.rowLimit) : null
  const pool = createPool()
  pool.on('error', () => console.error('An idle database connection failed.'))
  const migrateOnStart = process.argv.includes('--migrate')
  try {
    if (migrateOnStart) {
      await migrateDatabase(pool)
      console.log('Database schema is ready.')
    }
    await pool.query('SELECT next_row FROM registration_sheet_cursor WHERE singleton')
  } catch {
    await pool.end()
    throw new ConfigurationError(migrateOnStart
      ? 'Database startup migration failed. Check connectivity and schema privileges.'
      : 'Database is unavailable or has not been migrated.')
  }

  const server = createApp(pool, settings, resolve('dist')).listen(settings.port, settings.production ? '0.0.0.0' : '127.0.0.1')
  server.requestTimeout = 90_000
  server.headersTimeout = 15_000
  server.on('listening', () => console.log(`Registration server running on port ${settings.port}.`))
  const stopWorker = startWorker(pool, google)
  const stop = () => {
    server.closeIdleConnections()
    server.close(() => { void stopWorker().then(() => pool.end()) })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

main().catch(error => {
  console.error(error instanceof ConfigurationError ? error.message : 'Server startup failed. Check server and Google configuration.')
  process.exitCode = 1
})
