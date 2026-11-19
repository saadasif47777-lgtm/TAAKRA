import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { request } from 'node:http'
import { resolve } from 'node:path'
import { after, before, test } from 'node:test'
import type { Server } from 'node:http'
import type { AuthClient } from 'google-auth-library'
import pg from 'pg'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { createApp } from '../server/app.js'
import type { Config } from '../server/config.js'
import { documentKeys, schema } from '../server/db.js'
import { GoogleApi, headers } from '../server/google.js'
import { syncNext } from '../server/worker.js'

const connectionString = process.env.TEST_DATABASE_URL
assert(connectionString, 'Set TEST_DATABASE_URL to a development PostgreSQL instance with CREATE privileges.')
const schemaName = `test_${randomUUID().replaceAll('-', '')}`
const admin = new pg.Pool({ connectionString })
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schemaName}` })
const settings: Config = {
  production: false, departments: ['Test department'], semesters: ['Test semester'], categories: [],
  retentionDays: 7, proxyHops: 0, origin: '', siteKey: '', turnstileSecret: '',
  appSecret: 'development-test-only-key-do-not-deploy', port: 0, rowLimit: 200,
}

let server: Server
let base: string
let png: Uint8Array<ArrayBuffer>
before(async () => {
  await admin.query(`CREATE SCHEMA ${schemaName}`)
  await pool.query(schema)
  await pool.query(schema)
  png = new Uint8Array(await sharp({ create: { width: 50, height: 80, channels: 3, background: '#d99e65' } })
    .withMetadata({ orientation: 6 }).png().toBuffer())
  await new Promise<void>(resolveListen => {
    server = createApp(pool, settings, resolve('dist')).listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  assert(address && typeof address === 'object')
  base = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server) await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
  await pool.end()
  await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
  await admin.end()
})

function form(roll: string, options: { fields?: Record<string, string>; omit?: string; replacement?: Blob } = {}) {
  const data = new FormData()
  for (const [field, value] of Object.entries({
    name: '  Example   Student ', roll, mobile: '(0300) 123-4567', department: 'Test department',
    semester: 'Test semester', privacy: 'yes', ...options.fields,
  })) if (field !== options.omit) data.set(field, value)
  for (const [i, kind] of documentKeys.entries()) if (kind !== options.omit) {
    data.set(kind, i === 0 && options.replacement ? options.replacement : new Blob([png], { type: 'image/png' }), 'sample.png')
  }
  return data
}

function send(key: string, body: FormData) {
  return fetch(`${base}/api/registration`, { method: 'POST', body, headers: { 'Idempotency-Key': key } })
}

let mainKey: string
let mainReference: string

test('stores a valid application without category and protects receipt data', async () => {
  mainKey = randomUUID()
  const response = await send(mainKey, form(' Sp-26 / BsSE / 001 '))
  assert.equal(response.status, 202)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  const result = await response.json()
  mainReference = result.reference
  assert.match(mainReference, /^TK27-[A-F0-9]{16}$/)
  assert.deepEqual(Object.keys(result).sort(), ['name', 'reference', 'status', 'submittedAt'])
  assert.equal(result.status, 'pending')
  assert.equal(result.name, 'Example Student')
  const { rows: [row] } = await pool.query('SELECT roll, category, mobile FROM registrations WHERE reference=$1', [mainReference])
  assert.deepEqual(row, { category: 'Not specified', mobile: '+923001234567', roll: 'Sp-26 / BsSE / 001' })
  const docs = await pool.query('SELECT data FROM registration_documents WHERE reference=$1', [mainReference])
  assert.equal(docs.rowCount, 4)
  const cleaned = await sharp(docs.rows[0].data).metadata()
  assert.equal(cleaned.exif, undefined)
  assert.equal(cleaned.width, 80)
  assert.equal((await fetch(`${base}/api/registration`, { headers: { 'Idempotency-Key': randomUUID() } })).status, 404)
})

test('enforces all required fields and all four images', async () => {
  for (const name of ['name', 'roll', 'mobile', 'department', 'semester', 'privacy', ...documentKeys]) {
    const response = await send(randomUUID(), form('TEST-missing', { omit: name }))
    assert.equal(response.status, 422, name)
    assert.equal(typeof (await response.json()).errors[name], 'string', name)
  }
  const unknown = await send(randomUUID(), form('TEST-options', { fields: { category: 'Unconfigured category' } }))
  assert.equal(unknown.status, 422)
  assert.ok((await unknown.json()).errors.category)
})

test('rejects forged, truncated, incorrectly declared and oversized images', async () => {
  for (const replacement of [
    new Blob(['not an image'], { type: 'image/png' }),
    new Blob([png.slice(0, 30)], { type: 'image/png' }),
    new Blob([png], { type: 'image/jpeg' }),
  ]) {
    const response = await send(randomUUID(), form('TEST-image', { replacement }))
    assert.equal(response.status, 422)
    assert.ok((await response.json()).errors['passport-photo'])
  }
  const replacement = new Blob([new Uint8Array(5 * 1024 * 1024 + 1)], { type: 'image/png' })
  const response = await send(randomUUID(), form('TEST-image', { replacement }))
  assert.equal(response.status, 413, JSON.stringify(await response.clone().json()))
  assert.ok((await response.json()).errors['passport-photo'])
})

test('handles parallel idempotent requests and normalized roll-number conflicts', async () => {
  const key = randomUUID()
  const same = await Promise.all([
    send(key, form('TES-T/idempotent')),
    send(key, form('TES-T/idempotent')),
  ])
  assert.deepEqual(same.map(res => res.status), [202, 202])
  const receipts = await Promise.all(same.map(res => res.json()))
  assert.equal(receipts[0].reference, receipts[1].reference)
  const changed = await send(key, form('TES-T/idempotent', { fields: { name: 'Other Student' } }))
  assert.equal(changed.status, 409)

  const parallel = await Promise.all([
    send(randomUUID(), form('Test/Concurrent')),
    send(randomUUID(), form(' TEST / CONCURRENT ')),
  ])
  assert.deepEqual(parallel.map(res => res.status).sort(), [202, 409])
  const { rows: [row] } = await pool.query('SELECT count(*)::int AS count FROM registrations')
  assert.equal(row.count, 3)
})

test('abandons partial uploads and accepts an intact retry with the same key', async () => {
  const key = randomUUID()
  const partial = '--partial\r\nContent-Disposition: form-data; name="name"\r\n\r\nTest'
  await new Promise<void>(resolveAbort => {
    const aborted = request(`${base}/api/registration`, {
      method: 'POST', headers: { 'Idempotency-Key': key, 'Content-Type': 'multipart/form-data; boundary=partial', 'Content-Length': 4096 },
    })
    aborted.on('error', () => resolveAbort())
    aborted.write(partial, () => aborted.destroy())
  })
  const lookup = await fetch(`${base}/api/registration`, { headers: { 'Idempotency-Key': key } })
  assert.equal(lookup.status, 404)
  assert.equal((await send(key, form('TEST/interrupted'))).status, 202)
})

test('resumes lost Drive and Sheets responses with persistent IDs and one spreadsheet row', async () => {
  const folderMime = 'application/vnd.google-apps.folder'
  const driveFiles = new Map<string, Record<string, unknown>>([
    ['parent', { id: 'parent', name: 'TAAKRA 2027 Registrations', mimeType: folderMime }],
    ['workbook', { id: 'workbook', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['parent'] }],
  ])
  const spreadsheet = new Map([['Registrations!A1:N1', headers]])
  let allocations = 0
  let driveCreates = 0
  let sheetWrites = 0
  let checkPrivacy = true
  function missing(): never { throw { response: { status: 404 } } }
  const client = {
    async request({ url, method, data }: { url: string; method: string; data?: string | Buffer | Record<string, unknown> }) {
      const path = new URL(url)
      const last = decodeURIComponent(path.pathname.split('/').at(-1) ?? '')
      if (last === 'permissions') return { data: { permissions: checkPrivacy ? [{ type: 'user', emailAddress: 'owner@example.org' }] : [{ type: 'anyone' }] } }
      if (last === 'generateIds') {
        allocations++
        return { data: { ids: Array.from({ length: 5 }, (_, i) => `drive-${allocations}-${i}`) } }
      }
      if (path.hostname === 'sheets.googleapis.com') {
        if (last === 'workbook') return { data: { sheets: [{ properties: { title: 'Registrations', gridProperties: { rowCount: 200, columnCount: 14 } } }] } }
        if (method === 'GET') return { data: { values: spreadsheet.has(last) ? [spreadsheet.get(last)] : [] } }
        if (method === 'PUT') {
          assert.equal(path.searchParams.get('valueInputOption'), 'RAW')
          const values = (data as { values: string[][] }).values[0]
          spreadsheet.set(last, values)
          if (++sheetWrites === 1) throw new Error('Response dropped after writing to Sheets.')
          return { data: { updatedRows: 1, updatedData: { values: [values] } } }
        }
        spreadsheet.delete(last.replace(':clear', ''))
        return { data: {} }
      }
      if (method === 'GET') {
        if (!driveFiles.has(last)) missing()
        return { data: driveFiles.get(last) }
      }
      if (method === 'DELETE') {
        driveFiles.delete(last)
        for (const [id, file] of driveFiles) if ((file.parents as string[] | undefined)?.includes(last)) driveFiles.delete(id)
        return { data: {} }
      }
      let created: Record<string, unknown>
      if (Buffer.isBuffer(data)) {
        const parts = data.toString('latin1').split('\r\n\r\n')
        created = JSON.parse(parts[1].split('\r\n')[0])
        const { createHash } = await import('node:crypto')
        const bytes = Buffer.from(parts.slice(2).join('\r\n\r\n').split(/\r\n--[a-f0-9-]+--/)[0], 'latin1')
        created.md5Checksum = createHash('md5').update(bytes).digest('hex')
      } else {
        created = data as Record<string, unknown>
      }
      const id = created.id as string
      assert(!driveFiles.has(id), 'Resume must reuse existing Drive files')
      driveFiles.set(id, created)
      if (++driveCreates === 2) throw new Error('Response dropped after creating a Drive file.')
      return { data: created }
    },
  }
  const google = new GoogleApi(client as unknown as AuthClient, 'parent', 'workbook', new Set(['owner@example.org']), 200)
  await google.verifySetup()
  checkPrivacy = false
  await assert.rejects(google.verifySetup(), /unapproved permission/)
  checkPrivacy = true
  // Restrict this run to the registration under test.
  await pool.query("UPDATE registrations SET next_attempt=now() + interval '1 day' WHERE reference<>$1", [mainReference])
  await syncNext(pool, google)
  const retry = () => pool.query('UPDATE registrations SET next_attempt=now() WHERE reference=$1', [mainReference])
  await retry()
  await syncNext(pool, google)
  const stillPending = await fetch(`${base}/api/registration`, { headers: { 'Idempotency-Key': mainKey } })
  assert.equal((await stillPending.json()).status, 'pending')
  await retry()
  await syncNext(pool, google)
  assert.equal(allocations, 1)
  assert.equal(driveCreates, 5)
  assert.equal(sheetWrites, 1)
  const row = spreadsheet.get('Registrations!A2:N2')
  assert.equal(row?.[0], mainReference)
  assert.equal(row?.[7], '+923001234567')
  assert.equal(row?.[13], 'Pending review')
  const complete = await fetch(`${base}/api/registration`, { headers: { 'Idempotency-Key': mainKey } })
  assert.equal((await complete.json()).status, 'complete')
  assert.equal((await pool.query('SELECT 1 FROM registration_documents WHERE reference=$1', [mainReference])).rowCount, 0)
  await pool.query("UPDATE registrations SET expires_at=now() - interval '1 second' WHERE reference=$1", [mainReference])
  await syncNext(pool, google)
  assert.equal(driveFiles.size, 2)
  assert(!spreadsheet.has('Registrations!A2:N2'))
  assert.equal((await fetch(`${base}/api/registration`, { headers: { 'Idempotency-Key': mainKey } })).status, 404)
})

test('mobile keyboard flow, document preview, and reduced motion in Chromium', {
  skip: !process.env.TEST_CHROMIUM_EXECUTABLE,
}, async () => {
  const browser = await chromium.launch({ executablePath: process.env.TEST_CHROMIUM_EXECUTABLE, args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    const pageErrors: unknown[] = []
    page.on('pageerror', error => pageErrors.push(error))
    await page.goto(base)
    assert.equal(await page.locator('h1').innerText(), 'YOUR TAAKRA JOURNEY\nSTARTS HERE.')
    assert(await page.locator('.artwork img').evaluate((img: HTMLImageElement) => img.naturalWidth > 0))
    assert(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches && getComputedStyle(document.documentElement).scrollBehavior === 'auto'))
    const fitsViewport = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    assert(await fitsViewport())
    await page.getByRole('button', { name: 'Continue' }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('alert').waitFor()
    assert.equal(await page.locator(':focus').getAttribute('id'), 'form-message')
    await page.locator('#name').fill('Browser Student')
    await page.keyboard.press('Tab')
    assert.equal(await page.locator(':focus').getAttribute('id'), 'roll')
    await page.locator('#roll').fill('Browser-test-001')
    await page.locator('#department').selectOption('Test department')
    await page.locator('#semester').selectOption('Test semester')
    await page.locator('#mobile').fill('+92 300 1234567')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('heading', { name: 'Required documents' }).waitFor()
    for (const kind of documentKeys) await page.locator(`#${kind}`).setInputFiles({ name: 'browser.png', mimeType: 'image/png', buffer: Buffer.from(png) })
    await page.getByRole('img', { name: 'Preview of passport photograph' }).waitFor()
    await page.getByRole('button', { name: 'Back', exact: true }).click()
    assert.equal(await page.locator('#name').inputValue(), 'Browser Student')
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Remove CNIC back' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByText('Add your cnic back.', { exact: true }).waitFor()
    await page.locator('#cnic-back').setInputFiles({ name: 'browser.png', mimeType: 'image/png', buffer: Buffer.from(png) })
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('heading', { name: 'Review and submit' }).waitFor()
    assert(await fitsViewport())
    await page.getByRole('checkbox', { name: 'I acknowledge the privacy notice.' }).check()
    await page.getByRole('button', { name: 'Submit registration' }).click()
    await page.getByRole('heading', { name: 'Received — processing' }).waitFor()
    assert(await fitsViewport())
    assert.equal(await page.getByRole('button', { name: 'Download receipt' }).count(), 0)
    assert.deepEqual(pageErrors, [])
    await page.close()

    const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await desktop.goto(base)
    await desktop.getByRole('button', { name: 'Continue' }).waitFor()
    const intro = await desktop.locator('.intro').boundingBox()
    const form = await desktop.locator('.registration').boundingBox()
    assert(intro && form && form.x > intro.x + intro.width)
    if (process.env.TEST_SCREENSHOT_PATH) await desktop.screenshot({ path: process.env.TEST_SCREENSHOT_PATH })
  } finally {
    await browser.close()
  }
})
