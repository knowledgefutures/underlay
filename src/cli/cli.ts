#!/usr/bin/env node

import { Command } from 'commander'

import { add } from './commands/add.js'
import { commit } from './commands/commit.js'
import { diff } from './commands/diff.js'
import { init } from './commands/init.js'
import { log } from './commands/log.js'
import { pull } from './commands/pull.js'
import { push } from './commands/push.js'
import { remoteAdd, remoteRemove, remoteList } from './commands/remote.js'
import { schemaSet } from './commands/schema-set.js'
import { status } from './commands/status.js'

const program = new Command()

program
  .name('underlay')
  .description('CLI for the Underlay versioned data registry')
  .version('0.1.0')

program
  .command('init')
  .description('Initialize a new Underlay repository')
  .argument('[dir]', 'directory to initialize', '.')
  .action(init)

program
  .command('schema-set')
  .description('Stage a schema file')
  .argument('<file>', 'JSON file with type schemas')
  .action(schemaSet)

program
  .command('add')
  .description('Stage records from a JSONL file')
  .argument('<file>', 'JSONL file with records')
  .action(add)

program.command('status').description('Show staged changes vs HEAD').action(status)

program
  .command('commit')
  .description('Create a new local version from staged changes')
  .requiredOption('-m, --message <msg>', 'version message')
  .action((opts) => commit(opts.message))

program.command('log').description('Show version history').action(log)

program
  .command('diff')
  .description('Compare two local versions')
  .argument('<from>', 'source version number')
  .argument('<to>', 'target version number')
  .action(diff)

const remote = program.command('remote').description('Manage remote registries')

remote
  .command('add')
  .description('Add a remote')
  .argument('<name>', 'remote name')
  .argument('<url>', 'remote URL')
  .option('-t, --token <token>', 'API key')
  .option('-c, --collection <owner/slug>', 'collection path')
  .action(remoteAdd)

remote
  .command('remove')
  .description('Remove a remote')
  .argument('<name>', 'remote name')
  .action(remoteRemove)

remote.command('list').description('List remotes').action(remoteList)

program
  .command('push')
  .description('Push local HEAD to a remote via hash negotiation')
  .argument('[remote]', 'remote name', 'origin')
  .action(push)

program
  .command('pull')
  .description('Pull latest version from a remote')
  .argument('[remote]', 'remote name', 'origin')
  .action(pull)

program.parse()
