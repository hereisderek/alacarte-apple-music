// Extracts a JSON object literal assigned to `<varName> = {...}` from raw
// HTML/JS, e.g. `window._ROUTER_DATA = {...};(function(){...})()`. A plain
// non-greedy regex breaks the moment minified JS after the object contains
// its own `};` — this walks the actual brace/string nesting instead.
export function extractAssignedJson(source, varName) {
  const marker = `${varName} = {`
  const markerIdx = source.indexOf(marker)
  if (markerIdx === -1) return null
  const objStart = markerIdx + marker.length - 1 // position of the opening '{'

  let depth = 0
  let inString = false
  let stringChar = ''
  let escaped = false
  let i = objStart
  for (; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === stringChar) inString = false
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      stringChar = ch
      continue
    }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        i += 1
        break
      }
    }
  }

  try {
    return JSON.parse(source.slice(objStart, i))
  } catch {
    return null
  }
}
