import { startEmberApiFixture } from '../e2e/fixtures/ember-api-server.ts'

const API_PORT = 18787
const fixture = await startEmberApiFixture(API_PORT)
console.log(`✓ direct Ember SDK fixture http://127.0.0.1:${API_PORT}`)

process.on('SIGINT', () => {
  fixture.server.closeAllConnections()
  fixture.server.close()
})
