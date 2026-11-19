import { readFileSync } from 'node:fs'
import { open, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ConfigurationError } from './config.js'

export const googleId = z.string().regex(/^[\w-]+$/)
const manifestSchema = z.object({
  rootId: googleId,
  folderId: googleId,
  setupId: z.uuid(),
  spreadsheetId: googleId.optional(),
  spreadsheetRequested: z.boolean().optional(),
  ready: z.boolean().optional(),
})

export type ResourceManifest = z.infer<typeof manifestSchema>

export function resourceFile() {
  return process.env.GOOGLE_RESOURCES_FILE || '.taakra-google.secret'
}

export function explicitResources() {
  const folderId = process.env.GOOGLE_PARENT_FOLDER_ID
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID
  if (!folderId && !spreadsheetId) return null
  if (!googleId.safeParse(folderId).success || !googleId.safeParse(spreadsheetId).success) {
    throw new ConfigurationError('Set both Google resource IDs to valid Drive IDs, or leave both blank to use the provisioning file.')
  }
  return { folderId: folderId!, spreadsheetId: spreadsheetId! }
}

export function readManifest(path: string): ResourceManifest | null {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new ConfigurationError('Could not read the Google provisioning file.')
  }
  try {
    return manifestSchema.parse(JSON.parse(text))
  } catch {
    throw new ConfigurationError('The Google provisioning file is invalid.')
  }
}

export function configuredResources() {
  const explicit = explicitResources()
  if (explicit) return explicit
  const manifest = readManifest(resourceFile())
  if (!manifest?.ready || !manifest.spreadsheetId) {
    throw new ConfigurationError('Google resources are missing or incomplete. Run google:setup -- provision or set both resource IDs.')
  }
  return { folderId: manifest.folderId, spreadsheetId: manifest.spreadsheetId }
}

export async function withManifestLock(path: string, run: (save: (state: ResourceManifest) => Promise<void>) => Promise<void>) {
  const lockPath = `${path}.lock.secret`
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new ConfigurationError('A Google provisioning lock exists. Finish the other setup run before retrying.')
    }
    throw new ConfigurationError('Could not create the Google provisioning lock. Check the output directory.')
  }
  try {
    await run(async state => {
      const temp = `${path}.${randomUUID()}.secret`
      try {
        await writeFile(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
        await rename(temp, path)
      } catch {
        throw new ConfigurationError('Could not save the Google provisioning file.')
      } finally {
        await rm(temp, { force: true })
      }
    })
  } finally {
    await lock.close()
    await rm(lockPath, { force: true })
  }
}
