import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { GoogleAuth, OAuth2Client, type AuthClient } from 'google-auth-library'
import { ConfigurationError, need } from './config.js'
import { configuredResources, googleId, type ResourceManifest } from './google-resources.js'
import type { Registration } from './db.js'
import type { Document } from './validation.js'

export const scopes = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
const drive = 'https://www.googleapis.com/drive/v3'
const upload = 'https://www.googleapis.com/upload/drive/v3'
const sheets = 'https://sheets.googleapis.com/v4/spreadsheets'
const folderMime = 'application/vnd.google-apps.folder'
const sheetMime = 'application/vnd.google-apps.spreadsheet'
const folderName = 'TAAKRA 2027 Registrations'

export const headers = [
  'Registration reference', 'Submitted timestamp', 'Student name', 'Roll number',
  'Department', 'Semester', 'Category', 'Mobile number', 'Passport photo',
  'Student ID card', 'CNIC front', 'CNIC back', 'Student folder', 'Review status',
]

export function refreshTokenFile() {
  return process.env.GOOGLE_REFRESH_TOKEN_FILE || '.taakra-google-oauth.secret'
}

export async function googleClient(): Promise<AuthClient> {
  if (process.env.GOOGLE_AUTH_MODE === 'oauth') {
    const client = new OAuth2Client(need('GOOGLE_CLIENT_ID'), need('GOOGLE_CLIENT_SECRET'))
    const refresh = process.env.GOOGLE_REFRESH_TOKEN ||
      readFileSync(refreshTokenFile(), 'utf8').trim()
    if (!refresh) throw new Error('Google refresh token is empty.')
    client.setCredentials({ refresh_token: refresh })
    return client
  }
  if (process.env.GOOGLE_AUTH_MODE === 'service-account') {
    return new GoogleAuth({ scopes }).getClient()
  }
  throw new Error('Select an OAuth or service-account Google authentication mode.')
}

function status(error: unknown) {
  return (error as { response?: { status?: number } })?.response?.status
}

type FileMetadata = {
  id: string
  name: string
  mimeType: string
  parents?: string[]
  md5Checksum?: string
  trashed?: boolean
  driveId?: string
}
const fileFields = 'id,name,mimeType,parents,md5Checksum,trashed,driveId'

export interface GoogleStorage {
  checkResources(): Promise<void>
  reserveIds(): Promise<string[]>
  saveFolder(id: string, reference: string): Promise<void>
  saveDocument(id: string, folder: string, doc: Document): Promise<void>
  saveRow(record: Registration, ids: string[]): Promise<void>
  removeRow(record: Registration): Promise<void>
  removeFolder(id: string): Promise<void>
}

class GoogleDrive {
  constructor(protected client: AuthClient, protected approved: Set<string>) {}

  protected async request<T>(url: string, method = 'GET', data?: unknown, headers?: Record<string, string>) {
    const response = await this.client.request<T>({ url, method, data, headers, timeout: 25_000, retry: false })
    return response.data
  }

  protected async file(id: string) {
    try {
      return await this.request<FileMetadata>(`${drive}/files/${id}?supportsAllDrives=true&fields=${fileFields}`)
    } catch (error) {
      if (status(error) === 404) return null
      throw error
    }
  }

  protected async permissions(id: string) {
    let pageToken = ''
    do {
      const query = new URLSearchParams({
        supportsAllDrives: 'true', includePermissionsForView: 'published', fields: 'nextPageToken,permissions(type,emailAddress,deleted,view)', pageSize: '100',
      })
      if (pageToken) query.set('pageToken', pageToken)
      const response = await this.request<{
        nextPageToken?: string
        permissions?: { type: string; emailAddress?: string; deleted?: boolean; view?: string }[]
      }>(`${drive}/files/${id}/permissions?${query}`)
      for (const permission of response.permissions ?? []) {
        if (permission.deleted) continue
        const email = permission.emailAddress?.toLowerCase() ?? ''
        if (!['user', 'group'].includes(permission.type) || permission.view || !this.approved.has(email)) {
          throw new ConfigurationError('A Google resource has an unapproved permission.')
        }
      }
      pageToken = response.nextPageToken ?? ''
    } while (pageToken)
  }

  protected async generateIds(count: number) {
    const response = await this.request<{ ids: string[] }>(`${drive}/files/generateIds?count=${count}&space=drive`)
    if (response.ids?.length !== count || new Set(response.ids).size !== count ||
        response.ids.some(id => !googleId.safeParse(id).success)) throw new Error('Drive returned an invalid ID allocation.')
    return response.ids
  }

  protected async ensureFile(
    id: string, parent: string, name: string, mimeType: string,
    create: () => Promise<FileMetadata>, checksum?: string,
  ) {
    let file = await this.file(id)
    if (!file) {
      try {
        file = await create()
      } catch (error) {
        if (status(error) !== 409) throw error
        file = await this.file(id)
      }
    }
    if (!file || file.id !== id || file.trashed || file.name !== name || file.mimeType !== mimeType ||
        !file.parents?.includes(parent) || (checksum && file.md5Checksum !== checksum)) {
      throw new Error('Drive did not confirm the expected file.')
    }
    await this.permissions(id)
  }
}

export class GoogleApi extends GoogleDrive implements GoogleStorage {
  constructor(
    client: AuthClient,
    private parent: string,
    private workbook: string,
    approved: Set<string>,
    private rowLimit: number,
  ) {
    super(client, approved)
  }

  async checkResources() {
    const parent = await this.file(this.parent)
    const sheet = await this.file(this.workbook)
    if (parent?.mimeType !== folderMime || parent.name !== folderName || parent.trashed ||
        sheet?.mimeType !== sheetMime || sheet.trashed ||
        !sheet.parents?.includes(this.parent)) throw new Error('Google registration resources are missing or misplaced.')
    if (process.env.GOOGLE_AUTH_MODE === 'service-account' && !parent.driveId) {
      throw new Error('Service-account storage must use a Shared Drive.')
    }
    await this.permissions(this.parent)
    await this.permissions(this.workbook)
  }

  async verifySetup(prepare = false, createWorksheet = false) {
    await this.checkResources()
    type Grid = { title: string; sheetId: number; gridProperties: { rowCount: number; columnCount: number } }
    const url = `${sheets}/${this.workbook}`
    const workbook = await this.request<{ sheets: { properties: Grid }[] }>(
      `${url}?fields=sheets(properties(title,sheetId,gridProperties))`)
    const worksheet = workbook.sheets.find(sheet => sheet.properties.title === 'Registrations')?.properties
    if (!worksheet) {
      if (!createWorksheet) throw new Error('Create a Registrations worksheet first.')
      await this.request(`${url}:batchUpdate`, 'POST', {
        requests: [{ addSheet: { properties: {
          title: 'Registrations',
          gridProperties: { rowCount: this.rowLimit, columnCount: headers.length },
        } } }],
      })
      await this.verifySetup(true)
      return
    }
    const grid = worksheet.gridProperties
    if (grid.rowCount < this.rowLimit || grid.columnCount < headers.length) {
      if (!prepare) throw new Error('The registration worksheet has insufficient capacity.')
      // Update counts only when they need to grow. Existing data and sheet IDs are retained.
      await this.request(`${url}:batchUpdate`, 'POST', {
        requests: [{
          updateSheetProperties: {
            properties: {
              sheetId: worksheet.sheetId,
              gridProperties: { rowCount: Math.max(grid.rowCount, this.rowLimit), columnCount: Math.max(grid.columnCount, headers.length) },
            },
            fields: 'gridProperties.rowCount,gridProperties.columnCount',
          },
        }],
      })
    }
    const headerUrl = `${url}/values/${encodeURIComponent('Registrations!A1:N1')}`
    const response = await this.request<{ values?: string[][] }>(headerUrl)
    if (JSON.stringify(response.values?.[0]) === JSON.stringify(headers)) return
    if (!prepare || response.values?.some(row => row.some(value => value !== ''))) {
      throw new Error('The registration worksheet header does not match.')
    }
    await this.request(`${headerUrl}?valueInputOption=RAW`, 'PUT', { values: [headers] })
    await this.verifySetup()
  }

  async reserveIds() {
    return this.generateIds(5)
  }

  async saveFolder(id: string, reference: string) {
    const meta = { id, name: reference, mimeType: folderMime, parents: [this.parent] }
    await this.ensureFile(id, this.parent, reference, folderMime, () =>
      this.request<FileMetadata>(`${drive}/files?supportsAllDrives=true&fields=${fileFields}`, 'POST', meta))
  }

  async saveDocument(id: string, folder: string, doc: Document) {
    const name = `${doc.kind}.${doc.extension}`
    const mimeType = doc.extension === 'jpg' ? 'image/jpeg' : 'image/png'
    const metadata = { id, name, mimeType, parents: [folder] }
    const checksum = createHash('md5').update(doc.data).digest('hex')
    await this.ensureFile(id, folder, name, mimeType, async () => {
      const boundary = randomUUID()
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
        doc.data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ])
      return this.request<FileMetadata>(
        `${upload}/files?uploadType=multipart&supportsAllDrives=true&fields=${fileFields}`,
        'POST', body, { 'Content-Type': `multipart/related; boundary=${boundary}` },
      )
    }, checksum)
  }

  private rowUrl(row: number) {
    return `${sheets}/${this.workbook}/values/${encodeURIComponent(`Registrations!A${row}:N${row}`)}`
  }

  async saveRow(record: Registration, ids: string[]) {
    const url = this.rowUrl(record.sheet_row)
    const current = await this.request<{ values?: string[][] }>(url)
    const values = current.values?.[0]
    if (values?.some(value => value !== '')) {
      const expected = this.rowValues(record, ids)
      if (!expected.slice(0, 13).every((value, i) => value === values[i]) || !values[13]) {
        throw new Error('The reserved worksheet row contains unexpected data.')
      }
      return
    }
    const result = await this.request<{ updatedRows?: number; updatedData?: { values?: string[][] } }>(
      `${url}?valueInputOption=RAW&includeValuesInResponse=true`,
      'PUT', { values: [this.rowValues(record, ids)] },
    )
    if (result.updatedRows !== 1 || result.updatedData?.values?.[0]?.length !== headers.length) {
      throw new Error('Sheets did not confirm the registration row.')
    }
  }

  private rowValues(record: Registration, ids: string[]) {
    return [
      record.reference, record.submitted_at.toISOString(), record.name, record.roll,
      record.department, record.semester, record.category, record.mobile,
      ...ids.slice(1).map(id => `https://drive.google.com/file/d/${id}/view`),
      `https://drive.google.com/drive/folders/${ids[0]}`, 'Pending review',
    ]
  }

  async removeRow(record: Registration) {
    const url = this.rowUrl(record.sheet_row)
    const response = await this.request<{ values?: string[][] }>(url)
    const values = response.values?.[0]
    if (!values?.some(value => value !== '')) return
    if (values[0] !== record.reference) throw new Error('Cannot clear a worksheet row with a different reference.')
    await this.request(`${url}:clear`, 'POST', {})
  }

  async removeFolder(id: string) {
    try {
      await this.request(`${drive}/files/${id}?supportsAllDrives=true`, 'DELETE')
    } catch (error) {
      if (status(error) !== 404) throw error
    }
  }
}

export function approvedGoogleEmails() {
  const approved = new Set(need('GOOGLE_ALLOWED_EMAILS').split(',').map(email => email.trim().toLowerCase()).filter(Boolean))
  if (!approved.size || [...approved].some(email => !/^[^\s@]+@[^\s@]+$/.test(email))) {
    throw new ConfigurationError('GOOGLE_ALLOWED_EMAILS must list the approved Google principals.')
  }
  return approved
}

export async function configuredGoogle(rowLimit: number) {
  const { folderId, spreadsheetId } = configuredResources()
  return new GoogleApi(await googleClient(), folderId, spreadsheetId, approvedGoogleEmails(), rowLimit)
}

export class GoogleProvisioner extends GoogleDrive {
  constructor(client: AuthClient, approved: Set<string>, private sharedDriveId?: string) {
    super(client, approved)
  }

  private async destination() {
    if (this.sharedDriveId) {
      const shared = await this.request<{ id: string }>(`${drive}/drives/${this.sharedDriveId}?fields=id`)
      if (shared.id !== this.sharedDriveId) throw new ConfigurationError('Google could not confirm the Shared Drive.')
      await this.permissions(shared.id)
      return shared.id
    }
    const account = await this.request<{ user?: { emailAddress?: string } }>(`${drive}/about?fields=user(emailAddress)`)
    const email = account.user?.emailAddress?.toLowerCase() ?? ''
    if (!this.approved.has(email)) {
      throw new ConfigurationError('The signed-in Google account must be included in GOOGLE_ALLOWED_EMAILS.')
    }
    const root = await this.file('root')
    if (!root || root.trashed || root.mimeType !== folderMime || !googleId.safeParse(root.id).success) {
      throw new ConfigurationError('Google could not find the My Drive root.')
    }
    return root.id
  }

  private async findFile(parent: string, filter: string) {
    const query = new URLSearchParams({
      q: `'${parent}' in parents and trashed = false and ${filter}`,
      fields: 'nextPageToken,incompleteSearch,files(id)', spaces: 'drive', pageSize: '100',
      supportsAllDrives: 'true', corpora: this.sharedDriveId ? 'drive' : 'user',
    })
    if (this.sharedDriveId) {
      query.set('driveId', this.sharedDriveId)
      query.set('includeItemsFromAllDrives', 'true')
    }
    let id: string | undefined
    do {
      const result = await this.request<{ files?: { id: string }[]; nextPageToken?: string; incompleteSearch?: boolean }>(
        `${drive}/files?${query}`)
      if (result.incompleteSearch) throw new ConfigurationError('Drive could not confirm whether a matching resource already exists.')
      for (const file of result.files ?? []) {
        if (id || !googleId.safeParse(file.id).success) {
          throw new ConfigurationError('Drive returned multiple or invalid matches. Review the existing resources before continuing.')
        }
        id = file.id
      }
      if (!result.nextPageToken) return id
      query.set('pageToken', result.nextPageToken)
    } while (true)
  }

  async provision(
    rowLimit: number,
    existing: ResourceManifest | null,
    save: (state: ResourceManifest) => Promise<void>,
  ) {
    const rootId = await this.destination()
    let state = existing
    if (!state) {
      if (await this.findFile(rootId, `name = '${folderName}' and mimeType = '${folderMime}'`)) {
        throw new ConfigurationError('A registration folder already exists. Reuse its provisioning file or configure the existing resource IDs.')
      }
      const [folderId] = await this.generateIds(1)
      state = { rootId, folderId, setupId: randomUUID() }
      await save(state)
    } else if (state.rootId !== rootId) {
      throw new ConfigurationError('The provisioning file belongs to a different Drive root.')
    }

    const createUrl = `${drive}/files?supportsAllDrives=true&fields=${fileFields}`
    const { folderId, setupId } = state
    await this.ensureFile(folderId, rootId, folderName, folderMime, () =>
      this.request<FileMetadata>(createUrl, 'POST', {
        id: folderId, name: folderName, mimeType: folderMime, parents: [rootId],
      }))

    let spreadsheetId = state.spreadsheetId
    if (!spreadsheetId) {
      const key = `mimeType = '${sheetMime}' and appProperties has { key='taakraSetupId' and value='${setupId}' }`
      spreadsheetId = await this.findFile(folderId, key)
      if (!spreadsheetId) {
        if (state.spreadsheetRequested) {
          throw new ConfigurationError('A previous spreadsheet creation has an unknown outcome. Retry to let Drive find it, or review the folder and configure the correct resource IDs.')
        }
        state = { ...state, spreadsheetRequested: true }
        await save(state)
        try {
          const sheet = await this.request<FileMetadata>(createUrl, 'POST', {
            name: folderName, mimeType: sheetMime, parents: [folderId], appProperties: { taakraSetupId: setupId },
          })
          spreadsheetId = googleId.parse(sheet.id)
        } catch (error) {
          // Drive does not accept preallocated IDs for native Sheets files. Retry only when it rejected creation.
          if ([400, 401, 403, 404].includes(status(error) ?? 0)) {
            await save({ ...state, spreadsheetRequested: false })
            throw new ConfigurationError('Drive rejected spreadsheet creation. Check that the Google account can create files in the folder.')
          }
          throw new ConfigurationError('Spreadsheet creation could not be confirmed. Run provision again to look for the same spreadsheet.')
        }
      }
      state = { ...state, spreadsheetId }
      await save(state)
    }
    const google = new GoogleApi(this.client, folderId, spreadsheetId, this.approved, rowLimit)
    await google.verifySetup(true, true)
    await save({ ...state, ready: true })
  }
}
