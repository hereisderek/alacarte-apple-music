import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractAssignedJson } from '../lib/extractInlineJson.mjs'

test('extractAssignedJson pulls the object out even when more JS follows on the same line', () => {
  const html =
    '<script>window._ROUTER_DATA = {"a":1,"nested":{"b":"a string with a } brace"}};' +
    'someOtherCall({not:"part of it"});</script>'
  const data = extractAssignedJson(html, '_ROUTER_DATA')
  assert.deepEqual(data, { a: 1, nested: { b: 'a string with a } brace' } })
})

test('extractAssignedJson returns null when the marker is missing', () => {
  assert.equal(extractAssignedJson('<script>no data here</script>', '_ROUTER_DATA'), null)
})
