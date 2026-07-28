/**
 * Best-effort capture of the application `file:line` that triggered a span,
 * skipping frames inside node_modules and the SDK itself. Returns undefined
 * when nothing useful is found. Cheap enough to run per span; never throws.
 */
export function captureSource(): string | undefined {
  const stack = new Error().stack
  if (!stack) return undefined
  const lines = stack.split('\n').slice(1)
  for (const line of lines) {
    if (line.includes('node_modules')) continue
    if (line.includes('/metrixwire/sdks/node/')) continue
    if (line.includes('@metrixwire/node')) continue
    if (line.includes('node:')) continue
    // Match "(/abs/path/file.ts:12:5)" or "at /abs/path/file.ts:12:5"
    const m = line.match(/\(?((?:\/|[A-Za-z]:\\)[^():]+):(\d+):\d+\)?/)
    if (m) {
      const file = m[1].split('/').slice(-2).join('/')
      return `${file}:${m[2]}`
    }
  }
  return undefined
}
