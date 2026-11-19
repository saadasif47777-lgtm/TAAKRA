// A local .env may select development for the API. Default the browser build to production.
process.env.NODE_ENV ??= 'production'
const { build } = await import('vite')
await build()
