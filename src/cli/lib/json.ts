export function parseJsonOrExit<T>(text: string, context: string, suggestion?: string): T {
  try {
    return JSON.parse(text) as T
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`Could not parse ${context}: ${detail}`)
    if (suggestion) console.error(suggestion)
    process.exit(1)
  }
}
