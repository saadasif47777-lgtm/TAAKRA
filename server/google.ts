import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { GoogleAuth, OAuth2Client, type AuthClient } from 'google-auth-library'
import { need } from './config.js'
import type { Registration } from './db.js'
import type { Document } from './validation.js'

export const scopes = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets']
const drive = 'https://www.googleapis.com/drive/v3'
const upload = 'https://www.googleapis.com/upload/drive/v3'
const sheets = 'https://sheets.googleapis.com/v4/spreadsheets'
const folderMime = 'application/vnd.google-apps.folder'
const sheetMime = 'application/vnd.google-apps.spreadsheet'

export const headers = [
  'Registration reference', 'Submitted timestamp', 'Student name', 'Roll number',
  'Department', 'Semester', 'Category', 'Mobile number', 'Passport photo',
  'Student ID card', 'CNIC front', 'CNIC back', 'Student folder', 'Review status',
]

export async function googleClient(): Promise<AuthClient> {
  if (process.env.GOOGLE_AUTH_MODE === 'oauth') {
    const client = new OAuth2Client(need('GOOGLE_CLIENT_ID'), need('GOOGLE_CLIENT_SECRET'))
    const refresh = process.env.GOOGLE_REFRESH_TOKEN ||
      readFileSync(need('GOOGLE_REFRESH_TOKEN_FILE'), 'utf8').trim()
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

export class GoogleApi implements GoogleStorage {
  constructor(
    private client: AuthClient,
    private parent: string,
    private workbook: string,
    private approved: Set<string>,
    private rowLimit: number,
  ) {}

  private async request<T>(url: string, method = 'GET', data?: unknown, headers?: Record<string, string>) {
    const response = await this.client.request<T>({ url, method, data, headers, timeout: 25_000, retry: false })
    return response.data
  }

  async file(id: string) {
    try {
      return await this.request<FileMetadata>(`${drive}/files/${id}?supportsAllDrives=true&fields=${fileFields}`)
    } catch (error) {
      if (status(error) === 404) return null
      throw error
    }
  }

  private async permissions(id: string) {
    let pageToken = ''
    do {
      const query = new URLSearchParams({
        supportsAllDrives: 'true', fields: 'nextPageToken,permissions(type,emailAddress,deleted,view)', pageSize: '100',
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
          throw new Error('A Google resource has an unapproved permission.')
        }
      }
      pageToken = response.nextPageToken ?? ''
    } while (pageToken)
  }

  async checkResources() {
    const parent = await this.file(this.parent)
    const sheet = await this.file(this.workbook)
    if (parent?.mimeType !== folderMime || parent.name !== 'TAAKRA 2027 Registrations' || parent.trashed ||
        sheet?.mimeType !== sheetMime || sheet.trashed ||
        !sheet.parents?.includes(this.parent)) throw new Error('Google registration resources are missing or misplaced.')
    if (process.env.GOOGLE_AUTH_MODE === 'service-account' && !parent.driveId) {
      throw new Error('Service-account storage must use a Shared Drive.')
    }
    await this.permissions(this.parent)
    await this.permissions(this.workbook)
  }

  async verifySetup(prepare = false) {
    await this.checkResources()
    type Grid = { title: string; sheetId: number; gridProperties: { rowCount: number; columnCount: number } }
    const url = `${sheets}/${this.workbook}`
    const workbook = await this.request<{ sheets: { properties: Grid }[] }>(
      `${url}?fields=sheets(properties(title,sheetId,gridProperties))`)
    const worksheet = workbook.sheets.find(sheet => sheet.properties.title === 'Registrations')?.properties
    if (!worksheet) throw new Error('Create a Registrations worksheet first.')
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
    const response = await this.request<{ ids: string[] }>(`${drive}/files/generateIds?count=5&space=drive`)
    if (response.ids?.length !== 5 || new Set(response.ids).size !== 5) throw new Error('Drive returned an invalid ID allocation.')
    return response.ids
  }

  private async ensureFile(
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

export async function configuredGoogle(rowLimit: number) {
  const approved = new Set(need('GOOGLE_ALLOWED_EMAILS').split(',').map(email => email.trim().toLowerCase()).filter(Boolean))
  if (!approved.size || [...approved].some(email => !/^[^\s@]+@[^\s@]+$/.test(email))) {
    throw new Error('GOOGLE_ALLOWED_EMAILS must list the approved Google principals.')
  }
  const parent = need('GOOGLE_PARENT_FOLDER_ID')
  const workbook = need('GOOGLE_SPREADSHEET_ID')
  if (![parent, workbook].every(id => /^[\w-]+$/.test(id))) throw new Error('Invalid Google resource IDs.')
  return new GoogleApi(await googleClient(), parent, workbook, approved, rowLimit)
}
