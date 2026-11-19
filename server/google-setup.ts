import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import { ConfigurationError, need } from './config.js'
import { explicitResources, googleId, readManifest, resourceFile, withManifestLock } from './google-resources.js'
import { approvedGoogleEmails, configuredGoogle, googleClient, GoogleProvisioner, refreshTokenFile, scopes } from './google.js'

async function connectOrganizer() {
  const path = refreshTokenFile()
  const host = '127.0.0.1'
  const port = 53682
  const redirect = `http://${host}:${port}/oauth/callback`
  const client = new OAuth2Client(need('GOOGLE_CLIENT_ID'), need('GOOGLE_CLIENT_SECRET'), redirect)
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
  const state = randomBytes(32).toString('hex')
  const consent = client.generateAuthUrl({
    access_type: 'offline', prompt: 'consent', scope: scopes, state,
    code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256,
  })

  await new Promise<void>((resolve, reject) => {
    let exchanging = false
    const server = createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      const callback = new URL(req.url ?? '/', redirect)
      const supplied = Buffer.from(callback.searchParams.get('state') ?? '')
      if (req.method !== 'GET' || req.headers.host !== `${host}:${port}` || callback.pathname !== '/oauth/callback' ||
          supplied.length !== state.length || !timingSafeEqual(supplied, Buffer.from(state)) || exchanging) {
        res.writeHead(400).end('This callback is invalid.')
        return
      }
      exchanging = true
      try {
        const code = callback.searchParams.get('code')
        if (!code) throw new Error('Google did not provide an authorization code.')
        const { tokens } = await client.getToken({ code, codeVerifier })
        if (!tokens.refresh_token) throw new Error('Google did not issue a refresh token.')
        await writeFile(path, tokens.refresh_token + '\n', { mode: 0o600, flag: 'wx' })
        res.end('Organizer authorization saved. You can close this tab.')
        resolve()
      } catch {
        res.writeHead(400).end('Authorization could not be saved. Check your terminal.')
        reject(new Error('OAuth failed. Check consent, redirect URI and that the token output path does not already exist.'))
      } finally {
        clearTimeout(timeout)
        server.close()
      }
    })
    const timeout = setTimeout(() => {
      server.close()
      reject(new Error('Google authorization expired. Start the flow again.'))
    }, 5 * 60_000)
    server.once('error', () => {
      clearTimeout(timeout)
      reject(new Error('Could not bind the local OAuth callback port.'))
    })
    server.listen(port, host, () => {
      console.log('Open this consent URL on this computer and sign in as the organizer:')
      console.log(consent)
    })
  })
  console.log('Saved the organizer refresh token to the configured private file.')
}

async function provision(rowLimit: number) {
  const explicit = explicitResources()
  const approved = approvedGoogleEmails()
  const sharedDriveId = process.env.GOOGLE_SHARED_DRIVE_ID || undefined
  if (!explicit && ((sharedDriveId && !googleId.safeParse(sharedDriveId).success) ||
      (process.env.GOOGLE_AUTH_MODE === 'service-account' && !sharedDriveId))) {
    throw new ConfigurationError('Set GOOGLE_SHARED_DRIVE_ID to the Shared Drive ID for automatic provisioning.')
  }

  if (process.env.GOOGLE_AUTH_MODE === 'oauth' && !process.env.GOOGLE_REFRESH_TOKEN && !existsSync(refreshTokenFile())) {
    await connectOrganizer()
  }
  if (explicit) {
    const google = await configuredGoogle(rowLimit)
    await google.verifySetup(true)
  } else {
    const path = resourceFile()
    const google = new GoogleProvisioner(await googleClient(), approved, sharedDriveId)
    await withManifestLock(path, save => google.provision(rowLimit, readManifest(path), save))
    console.log('Saved verified Google resource IDs in the private provisioning file.')
  }
  console.log('Google resources passed the permission and worksheet checks.')
}

async function run() {
  const command = process.argv[2]
  if (command === 'oauth') return connectOrganizer()
  if (command !== 'prepare' && command !== 'verify' && command !== 'provision') {
    throw new ConfigurationError('Use google:setup -- provision, oauth, prepare or verify.')
  }
  const rows = Number(process.env.GOOGLE_ROW_LIMIT ?? '20000')
  if (!Number.isSafeInteger(rows) || rows < 2 || rows > 100000) throw new ConfigurationError('Invalid GOOGLE_ROW_LIMIT.')
  if (command === 'provision') return provision(rows)

  const google = await configuredGoogle(rows)
  await google.verifySetup(command === 'prepare')
  console.log('Google resources passed the permission and worksheet checks.')
}

run().catch(error => {
  // Google request/response objects can contain confidential configuration.
  const oauthMessages = ['OAuth failed.', 'Could not bind', 'Google authorization expired.']
  const safe = error instanceof ConfigurationError ||
    (error instanceof Error && oauthMessages.some(prefix => error.message.startsWith(prefix)))
  console.error(safe ? error.message : 'Google setup failed. Check credential access, approved permissions, and the registration worksheet.')
  process.exitCode = 1
})
