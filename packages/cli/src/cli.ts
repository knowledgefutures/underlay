/**
 * underlay: the command line for Underlay v2. A local repository in .underlay/
 * (local.ts), versions built by the protocol's commit engine, and tree sync with
 * a registry.
 */
import { Command } from 'commander'

import { commit } from './commands/commit.js'
import { diff, fsck, log, remoteAdd, remoteList, remoteRemove, status } from './commands/info.js'
import { add, fileAdd, metaSet, rm, schemaSet } from './commands/stage.js'
import { clone, pull, push } from './commands/sync.js'
import { CliError, Local } from './local.js'

const say = (line: string) => console.log(line)
const here = () => Local.require()
/** Commander wants actions that resolve to nothing. */
const run = async (p: Promise<unknown>) => {
  await p
}

const program = new Command()
  .name('underlay')
  .description('Underlay: versioned, content-addressed collections of records')
  .version('0.2.0')

program
  .command('init')
  .description('Create a local repository')
  .argument('[dir]', 'directory', '.')
  .action((dir: string) => {
    Local.init(dir)
    say(`Initialized an Underlay repository in ${dir}`)
  })

program
  .command('clone')
  .description('Create a local repository from a registry collection')
  .argument('<url>', 'registry URL, e.g. https://www.underlay.org')
  .argument('<collection>', 'owner/slug')
  .argument('[dir]', 'directory (default: the slug)')
  .option('-t, --token <token>', 'API key (also fetches the private sets you can read)')
  .action((url: string, collection: string, dir: string | undefined, o: { token?: string }) =>
    run(clone(url, collection, dir ?? collection.split('/')[1]!, o, say)),
  )

program
  .command('schema-set')
  .description('Stage the type set from a JSON file of {type: schema}')
  .argument('<file>')
  .action((file: string) => schemaSet(here(), file, say))

program
  .command('add')
  .description('Stage records from an NDJSON file of {id, type, data, private?}')
  .argument('<file>')
  .option('--strip-unknown-fields', 'drop fields the schema does not define')
  .action((file: string, o: { stripUnknownFields?: boolean }) => run(add(here(), file, o, say)))

program
  .command('rm')
  .description('Stage deletes')
  .argument('<type>')
  .argument('<ids...>')
  .action((type: string, ids: string[]) => rm(here(), type, ids, say))

program
  .command('meta-set')
  .description('Stage the version metadata from a JSON file')
  .argument('[file]')
  .option('--clear', 'stage no metadata')
  .action((file: string | undefined, o: { clear?: boolean }) => {
    if (!file && !o.clear) throw new CliError('Give a metadata file, or --clear')
    metaSet(here(), o.clear ? null : file!, say)
  })

const files = program.command('file').description('Files records can reference')
files
  .command('add')
  .description('Store files locally and print their $file references')
  .argument('<paths...>')
  .action((paths: string[]) => run(fileAdd(here(), paths, say)))

program
  .command('status')
  .description('Show the head, remotes and staged changes')
  .action(() => status(here(), say))

program
  .command('commit')
  .description('Make a local version from the staged changes')
  .requiredOption('-m, --message <message>')
  .action((o: { message: string }) => run(commit(here(), o.message, say)))

program
  .command('log')
  .description('List local versions')
  .action(() => log(here(), say))

program
  .command('diff')
  .description('Compare two local versions')
  .argument('<from>')
  .argument('<to>')
  .action((from: string, to: string) => diff(here(), from, to, say))

program
  .command('fsck')
  .description('Check the local repository: versions, trees, bodies, files and logs')
  .option('--files', 'hash every file, not just check it is there at its size')
  .action((o: { files?: boolean }) => run(fsck(here(), o, say)))

const remote = program.command('remote').description('Manage registries')
remote
  .command('add')
  .argument('<name>')
  .argument('<url>')
  .requiredOption('-c, --collection <owner/slug>')
  .option('-t, --token <token>', 'API key')
  .action((name: string, url: string, o: { collection: string; token?: string }) =>
    remoteAdd(here(), name, url, o, say),
  )
remote
  .command('remove')
  .argument('<name>')
  .action((name: string) => remoteRemove(here(), name, say))
remote.command('list').action(() => remoteList(here(), say))

program
  .command('pull')
  .description("Fetch a remote's newest version and make it the head")
  .argument('[remote]', 'remote name', 'origin')
  .option('--force', 'replace local versions that were not pushed')
  .action((name: string, o: { force?: boolean }) => run(pull(here(), name, o, say)))

program
  .command('push')
  .description('Publish the head to a remote')
  .argument('[remote]', 'remote name', 'origin')
  .action((name: string) => run(push(here(), name, {}, say)))

program.parseAsync().catch((err: unknown) => {
  if (err instanceof CliError) {
    console.error(err.message)
    process.exit(1)
  }
  throw err
})
