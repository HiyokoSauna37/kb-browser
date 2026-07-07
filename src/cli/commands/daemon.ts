import type { Command } from 'commander';
import { readDiskBuildId, removeDaemonInfo } from '../../shared/paths';
import { pingDaemon, releaseSpawnLock, rpcRaw, spawnDaemon, waitForDaemon } from '../../shared/client';
import { print, run } from '../output';

/** kb daemon — デーモン(ブラウザ)の起動・停止・状態表示。 */
export function registerDaemonCommands(program: Command): void {
  const daemon = program.command('daemon').description('デーモンの管理');

  daemon
    .command('start')
    .description('デーモン(ブラウザ)を起動する(フラグなしは headed。プロファイルは前回値を引き継ぐ)')
    .option('--headless', 'ヘッドレスで起動する')
    .option('--headed', 'ウィンドウ表示で起動する(既定)')
    .option('--profile <name>', 'ブラウザプロファイル')
    .option('--channel <channel>', '起動チャネルを明示する (chrome | msedge | chromium。"auto" で自動選択に戻す)')
    .option('--ua <string>', 'User-Agent を全タブで上書きする(headless の "HeadlessChrome" 対策)。--ua "" で解除')
    .option('--stealth', 'ステルスモード: navigator.webdriver を消す等、自動化の痕跡を実 Chrome 相当に均す(認可テスト向け。JA3/IP 等のサーバ側判定は別レイヤなので突破は保証しない)')
    .option('--cdp <url>', '起動済みブラウザにアタッチする (例: http://127.0.0.1:9222)。--remote-debugging-port 付きで起動した Chrome/Edge に接続し、そのサインイン状態をそのまま使う')
    .action(
      run(async (opts: { headless?: boolean; headed?: boolean; profile?: string; channel?: string; ua?: string; stealth?: boolean; cdp?: string }) => {
        if (opts.headless && opts.headed) throw new Error('--headless と --headed は同時に指定できません');
        if (opts.channel && !['chrome', 'msedge', 'chromium', 'auto'].includes(opts.channel)) {
          throw new Error('--channel は chrome | msedge | chromium | auto を指定してください');
        }
        if (opts.cdp && (opts.channel || opts.ua != null || opts.profile || opts.headless || opts.headed || opts.stealth)) {
          throw new Error('--cdp(アタッチ)は接続先ブラウザの起動条件を変更できないため、--channel / --ua / --profile / --headless / --stealth とは併用できません(アタッチ先は元から実ブラウザなので --stealth は不要)');
        }
        const running = await pingDaemon();
        if (running) {
          // 既存デーモンには start のフラグは適用されない。要求が現在の状態と食い違うなら
          // 黙って握りつぶさず、再起動が要る旨を伝える(特に --stealth は安全性に関わるため)。
          const status = await rpcRaw(running, 'daemon.status');
          const wants: string[] = [];
          if (opts.stealth && !status.stealth) wants.push('stealth');
          if (opts.headless && !status.headless) wants.push('headless');
          if (opts.profile && opts.profile !== status.profile) wants.push(`profile=${opts.profile}`);
          if (wants.length) {
            console.error(`kb: 既存デーモンには ${wants.join(' / ')} は適用されません。反映するには kb daemon stop してから start し直してください。`);
          }
          print({ alreadyRunning: true, ...status }, (s) =>
            `既に起動しています (pid=${s.pid}, headless=${s.headless}, profile=${s.profile}${s.stealth ? ', stealth=on' : ''})`,
          );
          return;
        }
        try {
          // 明示起動は「フラグなし = headed / stealth off」の契約を守る(last-run を継承するのは自動 spawn のみ)
          const child = spawnDaemon({ headless: !!opts.headless, profile: opts.profile, channel: opts.channel, userAgent: opts.ua, stealth: !!opts.stealth, cdpUrl: opts.cdp });
          // child を渡すと、起動に失敗して即終了した場合に 30 秒待たずエラーになる
          const info = await waitForDaemon(child);
          const status = await rpcRaw(info, 'daemon.status');
          // ステルス + headless では UA に "HeadlessChrome" が残り最大の綻びになる。--ua か headed を促す
          // (--ua "" は既定 UA へのリセット = HeadlessChrome が残るので、これも警告対象にする)
          if (opts.stealth && status.headless && !opts.ua) {
            console.error('kb: stealth + headless では UA に "HeadlessChrome" が残ります(JS で読める綻び)。--ua "<実Chromeの UA>" を渡すか headed を使ってください。');
          }
          print(status, (s) =>
            s.attached
              ? `起動しました (pid=${s.pid}, attach=${s.attached}, tabs=${s.tabs})`
              : `起動しました (pid=${s.pid}, channel=${s.channel}, headless=${s.headless}, profile=${s.profile}${s.stealth ? ', stealth=on' : ''})`,
          );
        } finally {
          releaseSpawnLock();
        }
      }),
    );

  daemon
    .command('stop')
    .description('デーモンを停止する')
    .action(
      run(async () => {
        const info = await pingDaemon();
        if (!info) {
          print({ running: false }, () => 'デーモンは起動していません');
          return;
        }
        await rpcRaw(info, 'daemon.stop');
        removeDaemonInfo();
        print({ stopped: true }, () => '停止しました');
      }),
    );

  daemon
    .command('status')
    .description('デーモンの状態を表示する')
    .action(
      run(async () => {
        const info = await pingDaemon();
        if (!info) {
          print({ running: false }, () => 'デーモンは起動していません');
          return;
        }
        const status = await rpcRaw(info, 'daemon.status');
        // 「旧コードで動作」警告が本物の mismatch か確認できるよう、実行中/ディスク上のビルドを併記する
        let build: { running?: string; disk?: string; match?: boolean } = {};
        const disk = readDiskBuildId();
        if (disk != null && info.buildId) {
          build = {
            running: new Date(info.buildId).toISOString(),
            disk: new Date(disk).toISOString(),
            match: disk === info.buildId,
          };
        }
        print({ running: true, ...status, build }, (s) => {
          const buildNote =
            build.match === undefined
              ? ''
              : build.match
                ? ', build=ok'
                : `, build=MISMATCH (running=${build.running} / disk=${build.disk} — kb daemon stop で新コードが反映されます)`;
          return `running (pid=${s.pid}, channel=${s.channel}, headless=${s.headless}, profile=${s.profile}, tabs=${s.tabs}, proxy=${s.proxy}${s.stealth ? ', stealth=on' : ''}${s.attached ? `, attach=${s.attached}` : ''}${buildNote})`;
        });
      }),
    );
}
