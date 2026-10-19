/**
 * A response body read from `chunks` only as the client takes it: one chunk per
 * pull, so a slow reader holds the Worker back instead of the Worker buffering
 * the rest (a type of records.ndjson is GBs). A client that goes away ends the
 * iterator, which closes what it holds open.
 */
export function pullStream(chunks: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = chunks[Symbol.asyncIterator]()
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await it.next()
        if (done) controller.close()
        else controller.enqueue(value)
      } catch (err) {
        controller.error(err)
      }
    },
    async cancel() {
      await it.return?.()
    },
  })
}
