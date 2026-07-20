/**
 * Delete webhook delivery-log rows older than the 30-day retention window.
 *
 * The app also runs this on an in-process daily interval (see
 * startWebhookBackgroundJobs), which covers self-hosters who don't run the
 * cron container. This tool is the cron-scheduled equivalent.
 */
import { purgeOldDeliveries } from '../src/lib/webhooks.server.js'

async function main() {
  const deleted = await purgeOldDeliveries()
  console.log(`[prune-webhook-logs] Deleted ${deleted} delivery row(s) older than 30 days`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[prune-webhook-logs] Failed:', err)
  process.exit(1)
})
