import { randomBytes, timingSafeEqual } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library'
import { need } from './config.js'
import { configuredGoogle, scopes } from './google.js'

async function connectOrganizer() {
  const path = need('GOOGLE_REFRESH_TOKEN_FILE')
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

async function run() {
  const command = process.argv[2]
  if (command === 'oauth') return connectOrganizer()
  if (command !== 'prepare' && command !== 'verify') throw new Error('Use google:setup -- oauth, prepare or verify.')
  const rows = Number(process.env.GOOGLE_ROW_LIMIT ?? '20000')
  if (!Number.isSafeInteger(rows) || rows < 2 || rows > 100000) throw new Error('Invalid GOOGLE_ROW_LIMIT.')
  const google = await configuredGoogle(rows)
  try {
    await google.verifySetup(command === 'prepare')
  } catch {
    throw new Error('Google setup failed. Check credential access, approved permissions, the folder name, and the Registrations tab and headers.')
  }
  console.log('Google resources passed the permission and worksheet checks.')
}

run().catch(error => {
  // Print only messages created above. Never print Google request/response objects.
  const messages = [
    'OAuth failed.', 'Could not bind', 'Google authorization expired.', 'Use google:setup',
    'Invalid GOOGLE_ROW_LIMIT.', 'Google setup failed.',
  ]
  const message = error instanceof Error && messages.some(prefix => error.message.startsWith(prefix))
    ? error.message : 'Google setup is missing valid credentials or configuration.'
  console.error(message)
  process.exitCode = 1
})
