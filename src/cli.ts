#!/usr/bin/env node
import { Command } from 'commander';
import { KB_VERSION } from './shared/version';
import { setJsonOutput } from './cli/output';
import { registerDaemonCommands } from './cli/commands/daemon';
import { registerBrowseCommands } from './cli/commands/browse';
import { registerActionCommands } from './cli/commands/actions';
import { registerStateCommands } from './cli/commands/state';
import { registerLogCommands } from './cli/commands/log';
import { registerEnvCommands } from './cli/commands/env';
import { registerNetCommands } from './cli/commands/net';
import { registerProxyCommands } from './cli/commands/proxy';

/**
 * kb CLI のエントリポイント。コマンド定義はグループ別に src/cli/commands/ にあり、
 * ここでは登録順(= ヘルプの表示順)だけを決める。
 */

const program = new Command();

program
  .name('kb')
  .description('CLI-operable browser (Playwright + Chromium)')
  .version(KB_VERSION)
  .option('--json', 'JSON 形式で出力する')
  .hook('preAction', (cmd) => {
    setJsonOutput(!!cmd.optsWithGlobals().json);
  });

registerDaemonCommands(program);   // daemon start / stop / status
registerBrowseCommands(program);   // open / tabs / screenshot / text / html / snapshot / eval / request
registerActionCommands(program);   // click / fill / … / scroll / back / forward / reload / pdf
registerStateCommands(program);    // downloads / cookies / storage
registerLogCommands(program);      // log (操作記録)
registerEnvCommands(program);      // profile / mode / wait / login / auth / emulate
registerNetCommands(program);      // net / console / dom
registerProxyCommands(program);    // proxy

program.parse();
