# Scale bench (protocol v3)

Runs the v3 library (`packages/protocol/src/v3`, spec in `docs/protocol-v3.md`) on one machine
against generated Crossref-shaped records and the real Crossref dump, to check the design at
Crossref's size (about 180M records) and at 20,000 collections. The plan, the rules for running
it, and the log are in the meta repo: `planning/kf/underlay/v3-build-plan.md`. Start there.

The layout F bench this grew from (the server-coupled harness, its rounds and findings) is on
the local branch `scale-testing`. What was general came over: the generator (`src/gen.ts`), the
latency profiles (`src/latency.ts`), the bench folder (`src/dirs.ts`), and the scripts.

## The pieces

| File              | What it is                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------- |
| `v3/cli.ts`       | A command line over the library and a folder: push, read, diff, rebuild, fork, sweep, verify |
| `v3/store.ts`     | The bench store: a folder that waits, limits, and counts as R2 is documented to              |
| `v3/engine.ts`    | The engine interface the scenarios drive, and its v3 driver                                  |
| `v3/scenarios.ts` | Load, daily, reads, rebuild, recreate, many, racing, forks, sweep, schema                    |
| `v3/bench.ts`     | Suites of scenarios, workers, results                                                        |
| `v3/report.ts`    | The report page, from the results                                                            |

## The command line

```sh
cd testing
node --import tsx v3/cli.ts                      # every command
node --import tsx v3/cli.ts push records.ndjson -c demo --dir /tmp/ul
node --import tsx v3/cli.ts read work 10.1000/abc -c demo --dir /tmp/ul --requests
```

## The bench store

Every scenario reads and writes through `BenchStore`. It is the protocol's file store plus what
a local disk hides: latency (`--latency r2` or `r2-slow`), R2's documented limits (one write a
second to a key, then a 429; atomic create-if-absent, a loss still billed; lists of at most
1,000 keys; puts of at most 5 GiB; multipart parts of one size but the last), and counts of
requests by R2's billing class. Timings under simulated latency are lower bounds; bytes and
request counts are exact.
