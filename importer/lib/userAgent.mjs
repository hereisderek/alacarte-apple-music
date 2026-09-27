// Some sources (KKBOX in particular — see parsers/kkbox/index.mjs) gate on
// User-Agent, and a fleet of importer instances all sharing one hardcoded
// string is an easy pattern to fingerprint/block. Resolution order per
// parser: its own override env var, then the generic IMPORTER_USER_AGENT
// override, then this built-in default.
const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export function userAgentFor(parserEnvVar) {
  return (
    (parserEnvVar && process.env[parserEnvVar]) ||
    process.env.IMPORTER_USER_AGENT ||
    DEFAULT_USER_AGENT
  )
}
