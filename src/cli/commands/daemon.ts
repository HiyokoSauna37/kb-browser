import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { PROFILES_DIR, readDiskBuildId, removeDaemonInfo } from '../../shared/paths';
import { pingDaemon, releaseSpawnLock, rpcRaw, spawnDaemon, waitForDaemon } from '../../shared/client';
import { findOwnedDaemons, killTree, listProcesses } from '../../daemon/procscan';
import { splitExtensionsArg } from '../../shared/util';
import { print, run } from '../output';

/**
 * --extensions の値を解決する。'off' はそのまま(明示リセット)、'on' は空配列(有効化のみ)、
 * それ以外はカンマ区切りの拡張ディレクトリとして絶対パス化し、manifest.json の存在を検証する
 * (デーモンは別プロセス・別 cwd で走り、last-run 経由で再利用もされるため相対パスは渡せない)。
 */
function resolveExtensionsOption(value: string): string[] | 'off' {
  if (value === 'off') return 'off';
  const dirs = splitExtensionsArg(value).map((dir) => path.resolve(dir));
  for (const dir of dirs) {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
      throw new Error(
        `拡張ディレクトリに manifest.json が見つかりません: ${dir}\n` +
          '解凍済み(unpacked)拡張のフォルダを指定してください(.crx やストア URL は指定できません)。',
      );
    }
  }
  return dirs;
}

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
    .option('--ignore-https-errors', 'HTTPS 証明書エラーを無視する(自己署名証明書や、CA を信頼させていない MITM デバッグプロキシの escape hatch)')
    .option('--extensions <dirs|on|off>', 'Chrome 拡張機能を有効化する。カンマ区切りの解凍済み拡張ディレクトリを読み込む(同梱 Chromium で起動)。"on" は有効化のみ(プロファイルにインストール済みの拡張を使う)、"off" で無効に戻す')
    .option('--cdp <url>', '起動済みブラウザにアタッチする (例: http://127.0.0.1:9222)。--remote-debugging-port 付きで起動した Chrome/Edge に接続し、そのサインイン状態をそのまま使う')
    .option('--idle-timeout <min>', 'この分数だけ無活動(RPC もページ操作もなし)が続いたら自動終了する。0 で無効。既定 30 分', parseFloat)
    .action(
      run(async (opts: { headless?: boolean; headed?: boolean; profile?: string; channel?: string; ua?: string; stealth?: boolean; ignoreHttpsErrors?: boolean; extensions?: string; cdp?: string; idleTimeout?: number }) => {
        if (opts.headless && opts.headed) throw new Error('--headless と --headed は同時に指定できません');
        if (opts.idleTimeout != null && (!Number.isFinite(opts.idleTimeout) || opts.idleTimeout < 0)) {
          throw new Error('--idle-timeout は 0 以上の分数で指定してください(0 で無効)');
        }
        if (opts.channel && !['chrome', 'msedge', 'chromium', 'auto'].includes(opts.channel)) {
          throw new Error('--channel は chrome | msedge | chromium | auto を指定してください');
        }
        if (opts.cdp && (opts.channel || opts.ua != null || opts.profile || opts.headless || opts.headed || opts.stealth || opts.ignoreHttpsErrors || opts.extensions != null)) {
          throw new Error('--cdp(アタッチ)は接続先ブラウザの起動条件を変更できないため、--channel / --ua / --profile / --headless / --stealth / --ignore-https-errors / --extensions とは併用できません(アタッチ先のブラウザに直接インストールされた拡張はそのまま使えます)');
        }
        const extensions = opts.extensions != null ? resolveExtensionsOption(opts.extensions) : undefined;
        // Chrome 137+ の stable は --load-extension を無視する(サイドロード対策で削除)。
        // 明示チャネルで未パック拡張を要求されたときは、黙って読み込まれないより先に警告する。
        if (Array.isArray(extensions) && extensions.length && (opts.channel === 'chrome' || opts.channel === 'msedge')) {
          console.error(
            `kb: ${opts.channel} チャネルでは未パック拡張(--load-extension)が無視される可能性が高いです(Chrome 137+ の stable はこのフラグを削除済み。Edge も追随している可能性があります)。確実に読み込むには --channel を外すか --channel chromium(同梱 Chromium)を使ってください。`,
          );
        }
        const running = await pingDaemon();
        if (running) {
          // 既存デーモンには start のフラグは適用されない。要求が現在の状態と食い違うなら
          // 黙って握りつぶさず、再起動が要る旨を伝える(特に --stealth は安全性に関わるため)。
          const status = await rpcRaw(running, 'daemon.status');
          const wants: string[] = [];
          if (opts.stealth && !status.stealth) wants.push('stealth');
          if (opts.ignoreHttpsErrors && !status.ignoreHttpsErrors) wants.push('ignore-https-errors');
          if (opts.headless && !status.headless) wants.push('headless');
          if (opts.profile && opts.profile !== status.profile) wants.push(`profile=${opts.profile}`);
          if (opts.idleTimeout != null && Math.round(opts.idleTimeout * 60) !== status.idleTimeoutSec) {
            wants.push(`idle-timeout=${opts.idleTimeout}分`);
          }
          if (extensions != null) {
            const current = Array.isArray(status.extensions) ? status.extensions : undefined;
            const wanted = extensions === 'off' ? undefined : extensions;
            if (JSON.stringify(current ?? null) !== JSON.stringify(wanted ?? null)) wants.push('extensions');
          }
          if (wants.length) {
            console.error(`kb: 既存デーモンには ${wants.join(' / ')} は適用されません。反映するには kb daemon stop してから start し直してください。`);
          }
          print({ alreadyRunning: true, ...status }, (s) =>
            `既に起動しています (pid=${s.pid}, headless=${s.headless}, profile=${s.profile}${s.stealth ? ', stealth=on' : ''})`,
          );
          return;
        }
        try {
          // 明示起動は「フラグなし = headed / stealth off」の契約を守る(last-run を継承するのは自動 spawn のみ)。
          // --idle-timeout は分指定なので秒に変換して渡す(未指定なら last-run 継承 → デーモン側の env/既定)。
          const idleTimeoutSec = opts.idleTimeout != null ? Math.round(opts.idleTimeout * 60) : undefined;
          const child = spawnDaemon({ headless: !!opts.headless, profile: opts.profile, channel: opts.channel, userAgent: opts.ua, stealth: !!opts.stealth, ignoreHttpsErrors: !!opts.ignoreHttpsErrors, extensions, cdpUrl: opts.cdp, idleTimeoutSec });
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
              : `起動しました (pid=${s.pid}, channel=${s.channel}, headless=${s.headless}, profile=${s.profile}${s.stealth ? ', stealth=on' : ''}${s.ignoreHttpsErrors ? ', ignore-https-errors=on' : ''}${s.extensions ? `, extensions=${s.extensions.length || 'on'}` : ''})`,
          );
        } finally {
          releaseSpawnLock();
        }
      }),
    );

  daemon
    .command('restart')
    .description('デーモンを再起動する(前回の構成 channel/profile/UA/headless/stealth/extensions/ignore-https-errors を引き継ぐ。ビルド更新の反映にも使える)')
    .action(
      run(async () => {
        const info = await pingDaemon();
        if (!info) throw new Error('デーモンは起動していません。kb daemon start で起動してください。');
        const status = await rpcRaw(info, 'daemon.status');
        // 停止 → プロセス(と子 Chromium)の消滅を待つ → 同じ構成で起動し直す。
        // 消滅を待たずに spawn すると同じ profile の user-data-dir で ProcessSingleton 競合になる。
        await rpcRaw(info, 'daemon.stop').catch(() => {});
        removeDaemonInfo();
        const aliveP = (pid: number) => {
          try {
            process.kill(pid, 0);
            return true;
          } catch {
            return false;
          }
        };
        for (let i = 0; i < 40 && aliveP(info.pid); i++) await new Promise((r) => setTimeout(r, 200)); // 最大 ~8 秒
        if (aliveP(info.pid)) {
          throw new Error(`旧デーモン (pid=${info.pid}) が終了しませんでした。kb daemon stop --all で回収してから start してください。`);
        }
        try {
          // アタッチ(--cdp)は同じ CDP エンドポイントへ再接続。通常起動は last-run を継承(= 直前の明示構成)。
          const child = status.attached ? spawnDaemon({ cdpUrl: status.attached }) : spawnDaemon();
          const newInfo = await waitForDaemon(child);
          const s = await rpcRaw(newInfo, 'daemon.status');
          print(s, (r) =>
            r.attached
              ? `再起動しました (pid=${r.pid}, attach=${r.attached}, tabs=${r.tabs})`
              : `再起動しました (pid=${r.pid}, channel=${r.channel}, headless=${r.headless}, profile=${r.profile}${r.stealth ? ', stealth=on' : ''}${r.ignoreHttpsErrors ? ', ignore-https-errors=on' : ''})`,
          );
        } finally {
          releaseSpawnLock();
        }
      }),
    );

  daemon
    .command('stop')
    .description('デーモンを停止する(--all でこの KB_HOME の孤児デーモンも子 Chromium ごと回収)')
    .option('--all', 'daemon.json に登録されていない孤児デーモンも含め、この KB_HOME のデーモンを全て停止する')
    .option('--dry-run', '--all の対象を表示するだけで停止しない')
    .action(
      run(async (opts: { all?: boolean; dryRun?: boolean }) => {
        if (!opts.all) {
          const info = await pingDaemon();
          if (!info) {
            print({ running: false }, () => 'デーモンは起動していません');
            return;
          }
          await rpcRaw(info, 'daemon.stop');
          removeDaemonInfo();
          print({ stopped: true }, () => '停止しました');
          return;
        }

        // --all: プロセス一覧からこの KB_HOME(PROFILES_DIR)に属するデーモンを列挙する。
        // 子 Chromium の --user-data-dir が profiles 配下のものだけを所有とみなし、他 KB_HOME や
        // 自プロセスは誤爆しない(procscan.findOwnedDaemons)。
        const owned = findOwnedDaemons(listProcesses(), PROFILES_DIR, process.pid);

        if (opts.dryRun) {
          print({ dryRun: true, owned }, () =>
            owned.length ? `停止対象デーモン (pid): ${owned.join(', ')}` : 'この KB_HOME に該当するデーモンはありません',
          );
          return;
        }

        // 登録済み(生存)デーモンはまず graceful に止めてジャーナル/ブラウザを綺麗に閉じる。
        const info = await pingDaemon();
        if (info) {
          try {
            await rpcRaw(info, 'daemon.stop');
            // graceful 停止(ジャーナル最終書き込み・ブラウザ close)の完了を最大 5 秒待ってから
            // ツリーキルへ進む。即 /F すると後始末が中断されるため。
            const aliveP = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
            for (let i = 0; i < 25 && aliveP(info.pid); i++) await new Promise((r) => setTimeout(r, 200));
          } catch {
            /* 応答なしなら下のツリーキルで回収する */
          }
        }
        // 残った(または登録の外れた)孤児を子 Chromium ごとツリーキルする(graceful 済みの pid への
        // killTree は no-op)。
        for (const pid of owned) killTree(pid);
        removeDaemonInfo();
        print({ stopped: true, reclaimed: owned }, () =>
          owned.length
            ? `${owned.length} 個のデーモンを停止しました(子 Chromium 含む。pid: ${owned.join(', ')})`
            : 'この KB_HOME に該当するデーモンはありませんでした',
        );
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
          const idleNote = s.idleTimeoutSec ? `, idle=${s.idleTimeoutSec}s` : ', idle=off';
          const extNote = s.extensions ? `, extensions=${s.extensions.length || 'on'}` : '';
          return `running (pid=${s.pid}, channel=${s.channel}, headless=${s.headless}, profile=${s.profile}, tabs=${s.tabs}, proxy=${s.proxy}${s.stealth ? ', stealth=on' : ''}${s.ignoreHttpsErrors ? ', ignore-https-errors=on' : ''}${extNote}${s.attached ? `, attach=${s.attached}` : ''}${idleNote}${buildNote})`;
        });
      }),
    );
}
