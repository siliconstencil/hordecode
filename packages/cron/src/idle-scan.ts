/**
 * Decides which scheduler ticks scan for tasks. While the last scan found nothing, only every
 * `every`-th tick scans again, so an idle scheduler does no disk reads in between. `wake` makes the
 * next tick scan; callers use it when a task may have been added in this process.
 */
export function createIdleScanGate(every = 5) {
  let seen = Number.POSITIVE_INFINITY
  let skipped = 0
  return {
    shouldScan() {
      if (seen !== 0) return true
      skipped++
      return skipped % every === 0
    },
    record(count: number) {
      seen = count
      if (count !== 0) skipped = 0
    },
    wake() {
      seen = Number.POSITIVE_INFINITY
      skipped = 0
    },
  }
}
