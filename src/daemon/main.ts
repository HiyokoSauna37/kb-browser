import { Daemon, log, parseArgs } from './daemon';
import { removeDaemonInfoIfOwned } from '../shared/paths';

/** デーモンのエントリポイント。argv/env から構成を解決し、Daemon を起動する。 */
async function main(): Promise<void> {
  const config = parseArgs(process.argv, process.env);
  await new Daemon(config).start();
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  removeDaemonInfoIfOwned(process.pid);
  process.exit(1);
});
