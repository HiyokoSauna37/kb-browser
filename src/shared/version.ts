import fs from 'node:fs';
import path from 'node:path';

/**
 * kb のバージョン。package.json を単一の情報源とし、実行時に読む
 * (dist/shared/version.js から見て 2 つ上がパッケージルート)。
 */
export const KB_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
})();
