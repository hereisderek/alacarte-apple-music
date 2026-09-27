import { test } from 'node:test'
import assert from 'node:assert/strict'

import { userAgentFor } from '../lib/userAgent.mjs'

test('userAgentFor falls back to a built-in default when nothing is set', () => {
  delete process.env.IMPORTER_USER_AGENT
  delete process.env.QISHUI_USER_AGENT
  assert.match(userAgentFor('QISHUI_USER_AGENT'), /Mozilla/)
})

test('userAgentFor prefers the generic override over the built-in default', () => {
  process.env.IMPORTER_USER_AGENT = 'generic-ua'
  delete process.env.QISHUI_USER_AGENT
  assert.equal(userAgentFor('QISHUI_USER_AGENT'), 'generic-ua')
  delete process.env.IMPORTER_USER_AGENT
})

test('userAgentFor prefers the parser-specific override over the generic one', () => {
  process.env.IMPORTER_USER_AGENT = 'generic-ua'
  process.env.QISHUI_USER_AGENT = 'qishui-ua'
  assert.equal(userAgentFor('QISHUI_USER_AGENT'), 'qishui-ua')
  assert.equal(userAgentFor('SPOTIFY_USER_AGENT'), 'generic-ua')
  delete process.env.IMPORTER_USER_AGENT
  delete process.env.QISHUI_USER_AGENT
})
