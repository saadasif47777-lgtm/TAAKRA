import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { attachDatabasePool, waitUntil } from '@vercel/functions'
import { createApp } from './app.js'
import { config, ConfigurationError, need } from './config.js'
import { createPool } from './db.js'
import { configuredGoogle } from './google.js'
import { syncNext } from './worker.js'

async function configure() {
  const settings = config()
  const secret = Buffer.from(`Bearer ${need('CRON_SECRET')}`)
  if (!settings.production || secret.length < 'Bearer '.length + 16) {
    throw new ConfigurationError('Vercel requires NODE_ENV=production and a CRON_SECRET of at least 16 characters.')
  }
  const google = await configuredGoogle(settings.rowLimit)
  const pool = createPool(need('DATABASE_URL'), 3)
  // The session advisory lock must stay on the same backend connection.
  const syncPool = createPool(need('DATABASE_URL_UNPOOLED'), 1)
  for (const connectionPool of [pool, syncPool]) {
    connectionPool.on('error', () => console.warn('An idle database connection failed.'))
    attachDatabasePool(connectionPool)
  }

  async function syncFor(milliseconds: number) {
    const deadline = Date.now() + milliseconds
    do {
      if (!(await syncNext(syncPool, google))) break
    } while (Date.now() < deadline)
  }

  let background: Promise<void> | undefined
  function wakeWorker() {
    if (!background) {
      background = syncFor(45_000).catch(() => {
        console.warn('Background Google sync failed. The scheduled worker will retry.')
      }).finally(() => { background = undefined })
    }
    waitUntil(background)
  }

  return createApp(pool, settings, undefined, {
    chunkedUploads: true,
    onPending: wakeWorker,
    async scheduledSync(req, res) {
      const header = Buffer.from(req.get('Authorization') ?? '')
      if (header.length !== secret.length || !timingSafeEqual(header, secret)) {
        res.status(401).json({ message: 'Unauthorized.' })
        return
      }
      await syncFor(180_000)
      res.status(204).end()
    },
  })
}

let runtime: ReturnType<typeof configure> | undefined
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  let app
  try {
    runtime ??= configure()
    app = await runtime
  } catch (error) {
    runtime = undefined
    console.error(error instanceof ConfigurationError ? error.message
      : 'Vercel runtime setup failed. Check database, Google, and production environment settings.')
    res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ message: 'Registration is temporarily unavailable.' }))
    return
  }
  await new Promise<void>(resolve => {
    res.once('close', resolve)
    res.once('finish', resolve)
    app(req, res)
  })
}
