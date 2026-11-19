import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

const scene = read('src/scene.js')
    .replace(/^export\s+/gm, '')
    .replace(/^import[^\n]*\n/gm, '');

const host = read('src/host.js');

const banner = `/**
 * 柏宝书 · 场景生图桥接 v${pkg.version}
 * https://github.com/Bakawaters/bbs-img-bridge
 *
 * 本文件由 src/scene.js + src/host.js 自动拼装，勿手改。
 *   /bbs-img            按柏宝书当前场景出图
 *   /bbs-img preview    看每个字段的来源
 *   /bbs-img preview+   看完整提示词 / 提交命令
 *   /bbs-img raw        倾倒快照（排查）
 *   /bbs-img on|off     收到 AI 消息自动出图
 *   /bbs-img style=xxx  改画风后缀
 *   /bbs-img people=3   最多画几个人
 *   /bbs-img size=1248x832  多人图尺寸
 *   /bbs-img reset      清去重
 */`;

const out = `${banner}
(function () {
'use strict';
const VERSION = '${pkg.version}';

${scene}

${host}
})();
`;

fs.writeFileSync(path.join(root, 'index.js'), out, 'utf8');
console.log('built index.js', out.length, 'bytes');
