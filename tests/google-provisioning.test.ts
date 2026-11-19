import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AuthClient } from 'google-auth-library'
import { GoogleRequestError } from '../server/google-errors.js'
import { GoogleProvisioner, headers } from '../server/google.js'
import { configuredResources, readManifest, withManifestLock } from '../server/google-resources.js'

const folderMime = 'application/vnd.google-apps.folder'
const sheetMime = 'application/vnd.google-apps.spreadsheet'
const folderName = 'TAAKRA 2027 Registrations'
const organizer = 'organizer@example.org'

type DriveFile = { id: string; name: string; mimeType: string; parents?: string[]; appProperties?: { taakraSetupId: string } }
type Sheet = { id: number; title: string; rowCount: number; columnCount: number }

class GoogleFixture {
  files = new Map<string, DriveFile>()
  tabs: Sheet[] = [{ id: 0, title: 'Sheet1', rowCount: 1000, columnCount: 26 }]
  values: string[][] = []
  folderCreates = 0
  spreadsheetCreates = 0
  loseFolderResponse = false
  loseSheetResponse = false
  hideSpreadsheet = false
  publicDrive = false

  constructor() {
    this.files.set('my-root', { id: 'my-root', name: 'My Drive', mimeType: folderMime })
  }

  async request({ url, method, data }: { url: string; method: string; data?: unknown }) {
    const parsed = new URL(url)
    const name = decodeURIComponent(parsed.pathname.split('/').at(-1) ?? '')
    if (parsed.hostname === 'sheets.googleapis.com') {
      if (name.endsWith(':batchUpdate')) {
        const { requests } = data as { requests: { addSheet: { properties: {
          title: string; gridProperties: { rowCount: number; columnCount: number }
        } } }[] }
        const [{ addSheet: { properties: { title, gridProperties } } }] = requests
        assert.equal(title, 'Registrations')
        assert(!this.tabs.some(tab => tab.title === title), 'An existing tab must be kept')
        this.tabs.push({ id: 9, title, ...gridProperties })
        return { data: {} }
      }
      if (name === 'Registrations!A1:N1') {
        if (method === 'PUT') {
          assert.equal(parsed.searchParams.get('valueInputOption'), 'RAW')
          this.values = (data as { values: string[][] }).values
        }
        return { data: { values: this.values } }
      }
      return { data: { sheets: this.tabs.map(tab => ({
        properties: { title: tab.title, sheetId: tab.id, gridProperties: { rowCount: tab.rowCount, columnCount: tab.columnCount } },
      })) } }
    }
    if (name === 'about') return { data: { user: { emailAddress: organizer } } }
    if (parsed.pathname.includes('/drives/')) return { data: { id: name } }
    if (name === 'permissions') {
      assert.equal(parsed.searchParams.get('includePermissionsForView'), 'published')
      return { data: { permissions: this.publicDrive ? [{ type: 'anyone', view: 'published' }] : [{ type: 'user', emailAddress: organizer }] } }
    }
    if (name === 'generateIds') return { data: { ids: ['registration-folder'] } }
    if (name === 'files' && method === 'GET') {
      const query = parsed.searchParams.get('q')!
      const parent = /^'([^']+)' in parents/.exec(query)?.[1]
      const folderSearch = query.includes(`name = '${folderName}'`)
      const marker = /value='([^']+)'/.exec(query)?.[1]
      const files = [...this.files.values()].filter(file => file.parents?.includes(parent!) &&
        (folderSearch ? file.name === folderName && file.mimeType === folderMime
          : !this.hideSpreadsheet && file.mimeType === sheetMime && file.appProperties?.taakraSetupId === marker))
      return { data: { files } }
    }
    if (name === 'files' && method === 'POST') {
      const file = data as DriveFile
      if (file.mimeType === folderMime) {
        assert.equal(file.id, 'registration-folder')
        this.folderCreates++
        this.files.set(file.id, file)
        if (this.loseFolderResponse) throw new Error('No folder response')
        return { data: file }
      }
      assert.equal(file.mimeType, sheetMime)
      assert.equal(file.id, undefined, 'Native spreadsheet IDs are assigned by Google')
      assert.ok(file.appProperties?.taakraSetupId)
      this.spreadsheetCreates++
      const created = { ...file, id: 'registration-workbook' }
      this.files.set(created.id, created)
      if (this.loseSheetResponse) throw new Error('No sheet response')
      return { data: created }
    }
    const file = this.files.get(name === 'root' ? 'my-root' : name)
    if (!file) throw { response: { status: 404 } }
    return { data: file }
  }

  provisioner(sharedDrive?: string) {
    return new GoogleProvisioner(this as unknown as AuthClient, new Set([organizer]), sharedDrive)
  }
}

test('provisions private resources, resumes interrupted creation, and publishes only verified IDs locally', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'taakra-google-'))
  const path = join(directory, 'state.secret')
  const google = new GoogleFixture()
  const provisioner = google.provisioner()
  const run = () => withManifestLock(path, save => provisioner.provision(2000, readManifest(path), save))
  const previousResourcesFile = process.env.GOOGLE_RESOURCES_FILE
  const previousFolder = process.env.GOOGLE_PARENT_FOLDER_ID
  const previousSpreadsheet = process.env.GOOGLE_SPREADSHEET_ID
  process.env.GOOGLE_RESOURCES_FILE = path
  delete process.env.GOOGLE_PARENT_FOLDER_ID
  delete process.env.GOOGLE_SPREADSHEET_ID
  try {
    google.loseFolderResponse = true
    await assert.rejects(run(), /Creating the registration folder in Google Drive failed without a Google error code/)
    assert.throws(configuredResources, /missing or incomplete/)
    assert.equal(readManifest(path)?.folderId, 'registration-folder')

    google.loseSheetResponse = true
    await assert.rejects(run(), /Spreadsheet creation could not be confirmed/)
    assert.equal(readManifest(path)?.spreadsheetRequested, true)
    google.hideSpreadsheet = true
    await assert.rejects(run(), /unknown outcome/)
    assert.equal(google.spreadsheetCreates, 1)
    assert.throws(configuredResources, /missing or incomplete/)

    google.hideSpreadsheet = false
    await run()
    await run()
    assert.equal(google.folderCreates, 1)
    assert.equal(google.spreadsheetCreates, 1)
    assert.deepEqual(google.tabs.map(tab => tab.title), ['Sheet1', 'Registrations'])
    assert.deepEqual(google.values, [headers])
    assert.deepEqual(configuredResources(), { folderId: 'registration-folder', spreadsheetId: 'registration-workbook' })
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
    await assert.rejects(() => provisioner.provision(2000, null, async () => assert.fail()), /registration folder already exists/)
  } finally {
    if (previousResourcesFile === undefined) delete process.env.GOOGLE_RESOURCES_FILE
    else process.env.GOOGLE_RESOURCES_FILE = previousResourcesFile
    if (previousFolder === undefined) delete process.env.GOOGLE_PARENT_FOLDER_ID
    else process.env.GOOGLE_PARENT_FOLDER_ID = previousFolder
    if (previousSpreadsheet === undefined) delete process.env.GOOGLE_SPREADSHEET_ID
    else process.env.GOOGLE_SPREADSHEET_ID = previousSpreadsheet
    await rm(directory, { recursive: true, force: true })
  }
})

test('refuses Shared Drive creation before any writes when inherited permissions are public', async () => {
  const google = new GoogleFixture()
  google.publicDrive = true
  await assert.rejects(
    () => google.provisioner('shared-drive').provision(2000, null, async () => assert.fail()),
    /unapproved permission/,
  )
  assert.equal(google.folderCreates + google.spreadsheetCreates, 0)
})

test('reports the Google operation and supported error codes without exposing request or response content', () => {
  const sensitive = 'private-auth-or-resource-data'
  const error = new GoogleRequestError('Checking Google Drive access', {
    config: { url: sensitive, headers: { Authorization: sensitive } },
    response: {
      status: 403,
      data: {
        error: {
          message: sensitive,
          status: 'PERMISSION_DENIED',
          details: [{ reason: sensitive }, { reason: 'SERVICE_DISABLED' }],
        },
      },
    },
  })
  assert.equal(error.httpStatus, 403)
  assert.match(error.message, /^Checking Google Drive access failed \(HTTP 403, SERVICE_DISABLED\)\./)
  assert(!error.message.includes(sensitive))
  const oauth = new GoogleRequestError('Exchanging the Google authorization code', {
    response: { status: 400, data: { error: 'invalid_grant', error_description: sensitive } },
  })
  assert.match(oauth.message, /HTTP 400, invalid_grant/)
  assert(!oauth.message.includes(sensitive))
})
