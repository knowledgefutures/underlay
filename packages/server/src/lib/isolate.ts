/**
 * This isolate, for logs. A Worker isolate runs several invocations at once and
 * all of them die when one exceeds its memory, so a log line names the isolate
 * and how many commit units it has run.
 */
export const isolate = {
  /** Set on the first log line: Workers allow no random values in global scope. */
  id: '',
  /** When the isolate first logged (Date.now() in global scope is the epoch on Workers). */
  firstAt: 0,
  unitsStarted: 0,
  /**
   * Units whose `finally` ran. A unit the runtime cancels (wall time, say) never
   * ends, so started minus ended over-counts what is running after one.
   */
  unitsEnded: 0,
}

/** `iso 1a2b3c4d (3 started, 1 ended, up 120s)`: up since the isolate's first log line. */
export const isolateTag = () => {
  if (!isolate.id) {
    isolate.id = crypto.randomUUID().slice(0, 8)
    isolate.firstAt = Date.now()
  }
  return (
    `iso ${isolate.id} (${isolate.unitsStarted} started, ${isolate.unitsEnded} ended, ` +
    `up ${Math.round((Date.now() - isolate.firstAt) / 1000)}s)`
  )
}
