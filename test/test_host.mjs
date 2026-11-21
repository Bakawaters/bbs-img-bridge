/**
 * v2.0 测试：跑 index.js 在 vm 里，桩掉 SillyTavern 与柏宝书。
 * 只测管道行为：镜头直通、兜底、画风前缀、/sd 命令格式、去重、参数面。
 */
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const echoes = [];
const commands = [];
const store = {};          // 跨 run 共享，模拟 localStorage 持久化
let captured = null;       // 注册的 /bbs-img 命令对象
let onMessage = null;      // MESSAGE_RECEIVED 回调
let handlers = {};         // 其余 ST 事件回调
let saveCount = 0;         // ctx.saveChat 调用次数

const snapshots = {
    shot: {
        revision: 7,
        vars: { situation: '林夏跪坐在木地板上，右手扶着茶几边缘，侧头看向门外。' },
        state: { time: '2026-11-21 22:10', location: '城南旧书店二楼', locationPath: ['城南', '旧书店', '二楼'], sceneFocus: { participants: ['林夏'], situation: '' } },
        protagonist: { outfit: '灰色针织衫' },
        scenes: [{ name: '二楼', desc: '木质地板的老书店二楼，成排到顶的书架，暖黄壁灯' }],
        npcs: [{ name: '林夏', desc: '黑色短发，琥珀色眼睛，皮肤偏白', outfit: '灰色针织衫' }],
    },
    builtin: {
        revision: 8,
        state: { sceneFocus: { situation: '沈砚从背后环抱住林夏的腰', participants: ['林夏', '沈砚'] } },
        npcs: [
            { name: '林夏', desc: '黑色短发，琥珀色眼睛' },
            { name: '沈砚', desc: '亚麻色长卷发，浅褐色眼睛' },
        ],
    },
    fallback: {
        revision: 9,
        state: { locationPath: ['二楼'], sceneFocus: { participants: ['林夏'] } },
        scenes: [{ name: '二楼', desc: '木质地板的老书店二楼' }],
        npcs: [{ name: '林夏', desc: '黑色短发，琥珀色眼睛', outfit: '灰色针织衫', condition: '左臂缠着绷带' }],
    },
    empty: { revision: 10, state: { sceneFocus: null }, vars: {}, npcs: [], scenes: [], protagonist: {} },
};

function makeCtx(snap, opts = {}) {
    const context = {
        SillyTavern: {
            getContext: () => ({
                characters: [{ name: '林夏', description: '一位二十出头的女性，黑色短发。' }],
                groups: [],
                name1: '旅人', name2: '林夏', userAvatar: 'user-default.png',
                powerUserSettings: { personas: { 'user-default.png': '一位年轻女性，黑色长发' } },
                extensionSettings: { sd: { comfy_workflow: 'MOSS_质量版_25步.json' } },
                SlashCommand: { fromProps: o => o },
                SlashCommandParser: { addCommandObject: o => { captured = o; } },
                eventSource: {
                    on: (ev, fn) => {
                        handlers[ev] = fn;
                        if (ev === 'msg') onMessage = fn;
                    },
                },
                eventTypes: {
                    MESSAGE_RECEIVED: 'msg',
                    CHAT_CHANGED: 'chat',
                    CHARACTER_MESSAGE_RENDERED: 'cmr',
                    USER_MESSAGE_RENDERED: 'umr',
                    MESSAGE_SWIPED: 'swipe',
                },
                chat: opts.chat || [],
                saveChat: () => { saveCount++; },
                executeSlashCommandsWithOptions: async (cmd) => {
                    if (cmd.startsWith('/echo ')) { echoes.push(cmd.slice(6)); return ''; }
                    commands.push(cmd);
                    return 'http://127.0.0.1:8001/api/images/view/abc.png';
                },
            }),
        },
        STBaiBaiBook: { getSnapshot: () => snap },
        localStorage: {
            getItem: k => (k in store ? store[k] : null),
            setItem: (k, v) => { store[k] = String(v); },
            removeItem: k => { delete store[k]; },
        },
        document: { readyState: 'complete', addEventListener: () => {} },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: id => clearTimeout(id),
        console,
    };
    context.globalThis = context;
    vm.createContext(context);
    return context;
}

function run(name, snap, arg, named = {}) {
    echoes.length = 0; commands.length = 0; captured = null; onMessage = null;
    handlers = {}; saveCount = 0;
    const ctx = makeCtx(snap);
    vm.runInContext(code, ctx);
    if (!captured) throw new Error(`${name}: 命令没注册`);
    return captured.callback(named, arg).then(() => ({ echoes: [...echoes], commands: [...commands] }));
}

let pass = 0, fail = 0;
const ok = (c, m) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); };

/* ---- 1. 镜头原文直通 ---- */
let r = await run('shot', snapshots.shot, '');
ok(r.commands.length === 1, '有镜头时默认触发一次出图');
ok(r.commands[0].startsWith('/sd extend=false 林夏跪坐在木地板上'), '命令直接以镜头原文开头');
ok(r.commands[0].endsWith('侧头看向门外。'), '镜头原文一字不改，末尾标点保留');
ok(!/bbox|items|summary/.test(r.commands[0]), '不再输出 layout JSON');

r = await run('shot-preview', snapshots.shot, 'preview+');
let e = r.echoes.join('\n');
ok(e.includes('自定义变量 situation'), '报告点明镜头来自 vars.situation');
ok(e.includes('原文直通'), '报告写明原文直通');
ok(e.includes('林夏跪坐在木地板上'), 'preview+ 打印完整提示词');

/* ---- 2. 回退内置局势卡 ---- */
r = await run('builtin', snapshots.builtin, 'preview+');
e = r.echoes.join('\n');
ok(e.includes('sceneFocus.situation'), 'vars 空时回退 sceneFocus.situation');
ok(e.includes('沈砚从背后环抱'), '内置镜头的动作原文保留');
ok(!e.includes('背对镜头'), '不再推断朝向');

/* ---- 3. 对象镜头合并全部字段 ---- */
const snapObj = { ...snapshots.shot, vars: { situation: { 位置: '林夏在左', 接触: '手掌与肩相触' } } };
r = await run('obj', snapObj, 'preview+');
e = r.echoes.join('\n');
ok(e.includes('手掌与肩相触') && e.includes('林夏在左'), '对象镜头把所有字段合并');
ok(e.includes('2 个字段'), '报告写出字段数');

/* ---- 4. 无镜头 → 最小兜底 ---- */
r = await run('fallback', snapshots.fallback, 'preview+');
e = r.echoes.join('\n');
ok(e.includes('走兜底'), '无镜头时报告走兜底');
ok(e.includes('木质地板的老书店二楼'), '兜底包含场景 desc');
ok(e.includes('左臂缠着绷带'), '兜底包含人物状态');
ok(!e.includes('正午顶光') && !e.includes('夜晚暖色灯光'), '兜底不再猜光线');

r = await run('fallback-cmd', snapshots.fallback, '');
ok(r.commands[0].startsWith('/sd extend=false 木质地板的老书店二楼'), '兜底提示词以场景开头');

/* ---- 5. 空场景 ---- */
r = await run('empty', snapshots.empty, 'preview');
e = r.echoes.join('\n');
ok(e.includes('没有画面镜头'), '空场景给出明确原因');
ok(r.commands.length === 0, '空场景不出图');

/* ---- 6. 画风前缀 ---- */
r = await run('style-named', snapshots.shot, '', { style: '水粉厚涂，可见笔触' });
ok(r.echoes.join('\n').includes('水粉厚涂'), 'style 走命名参数能设上');
ok(r.commands.length === 0, '只设 style 不触发出图');

r = await run('style-used', snapshots.shot, '');
ok(r.commands[0].startsWith('/sd extend=false 水粉厚涂，可见笔触，林夏跪坐'), '画风前缀拼在镜头原文最前');
ok(r.commands[0].indexOf('水粉厚涂') < r.commands[0].indexOf('林夏'), '画风在前，镜头在后');

r = await run('style-off', snapshots.shot, 'style=auto');
ok(r.echoes.join('\n').includes('画风前缀已清空'), 'style=auto 清空前缀');
r = await run('style-off-used', snapshots.shot, '');
ok(r.commands[0].startsWith('/sd extend=false 林夏'), '清空后命令回到纯镜头原文');

/* ---- 7. 参数面 ---- */
r = await run('style-space', snapshots.shot, 'char', { style: 'anima' });
e = r.echoes.join('\n');
ok(e.includes('画风前缀固定为：anima char'), '画风带空格时把剩余词并回画风');
ok(r.commands.length === 0, '被截断的尾词不再触发出图');

r = await run('dropped-arg', snapshots.shot, 'people=1');
e = r.echoes.join('\n');
ok(e.includes('不认识的参数'), 'people= 已删，给出明确提示');
ok(r.commands.length === 0, '传旧参数不误触发出图');

/* ---- 8. 去重（自动出图路径） ---- */
echoes.length = 0; commands.length = 0; captured = null; onMessage = null;
{
    const ctx = makeCtx(snapshots.shot);
    vm.runInContext(code, ctx);
    await captured.callback({}, 'on');
    commands.length = 0;
    const before = echoes.length;
    await onMessage();
    await onMessage();
    ok(commands.length === 1, '同一 revision+提示词只自动出一次图');
    ok(echoes.slice(before).join('\n').trim() === '', '重复时静默跳过（不刷屏）');
    await captured.callback({}, 'off');
}

/* ---- 9. 管道清洁度 ---- */
r = await run('clean', snapshots.shot, '');
ok(!/[|｜]/.test(r.commands[0]), '命令里没有管道符');
ok(!/width=|height=/.test(r.commands[0]), '不再传宽高（交给面板）');

/* ---- 10. 幽灵楼自动排除(不参与柏宝书记忆) ---- */
const ghostChat = () => ([
    { name: '林夏', is_user: false, is_system: false, mes: '可见回复' },
    { name: '林夏', is_user: false, is_system: true, mes: '用户点了幽灵按钮' },
    { name: '林夏', is_user: false, is_system: true, mes: '柏宝书隐藏的旧楼', extra: { bbs_hidden: true, bbs_leaf: { id: 'l1', delta: {} } } },
    { name: 'SillyTavern System', is_user: false, is_system: true, mes: '系统楼', extra: { type: 'narrator' } },
    { name: '林夏', is_user: false, is_system: true, mes: '', extra: { bbs_leaf: { seed: true, id: 's', delta: {} } } },
    { name: '林夏', is_user: false, is_system: true, mes: '用户自己标的番外', extra: { bbs_omit: true } },
    { name: '林夏', is_user: false, is_system: true, mes: '被柏宝书补写了 bbs_hidden,从没摘过', extra: { bbs_hidden: true } },
    { name: '旅人', is_user: true, is_system: true, mes: '用户自己的楼被隐藏', extra: { bbs_hidden: true } },
]);

{
    const chat = ghostChat();
    echoes.length = 0; commands.length = 0; captured = null; handlers = {}; saveCount = 0;
    const ctx = makeCtx(snapshots.shot, { chat });
    vm.runInContext(code, ctx); // 加载即扫一遍

    const ghost = chat[1];
    ok(ghost.extra?.bbs_omit === true, '幽灵楼被标番外(柏宝书按不存在处理)');
    ok(ghost.extra?.bbs_omit_by === 'bbs-img-bridge', '标记带来源,便于撤回');
    ok(!chat[2].extra.bbs_omit, '柏宝书正常隐藏的旧楼(有叶子)不动');
    ok(!chat[3].extra.bbs_omit, '原生系统楼不动');
    ok(!chat[4].extra.bbs_omit, '搬运锚点楼(种子叶子)不动');
    ok(chat[5].extra.bbs_omit_by === undefined, '用户自己标的番外不抢来源');
    ok(chat[6].extra.bbs_omit === true && chat[6].extra.bbs_omit_by === 'bbs-img-bridge',
        '被补写 bbs_hidden 的幽灵楼自动修复(2.1.0 那个坑)');
    ok(!chat[7].extra.bbs_omit, '被隐藏的用户楼不按幽灵楼处理');
    ok(chat[0].extra === undefined, '可见楼不被写入任何标记');
    ok(saveCount === 1, '有改动才落盘一次');

    echoes.length = 0;
    await captured.callback({}, 'ghosts');
    const rep = echoes.join('\n');
    ok(rep.includes('幽灵楼 3 个'), 'ghosts 报告幽灵楼总数');
    ok(rep.includes('已排除出记忆 3 个'), 'ghosts 报告已排除数');
    ok(rep.includes('新标 0') && rep.includes('修复 0'), '已处理过的不重复计数');

    // 核心回归:柏宝书给已标好的幽灵楼补写 bbs_hidden → 标记必须保住
    ghost.extra.bbs_hidden = true;
    echoes.length = 0;
    await captured.callback({}, 'ghosts');
    ok(ghost.extra.bbs_omit === true && ghost.extra.bbs_omit_by === 'bbs-img-bridge',
        '柏宝书补写 bbs_hidden 后仍保持排除(不再退回待摘要)');

    // 取消隐藏 → 撤回标记
    ghost.is_system = false;
    echoes.length = 0;
    await captured.callback({}, 'ghosts');
    ok(ghost.extra?.bbs_omit === undefined && ghost.extra?.bbs_omit_by === undefined,
        '取消隐藏后自动撤回标记,记忆恢复');
    ok(echoes.join('\n').includes('撤回 1'), 'ghosts 报告撤回数');

    // 用户手动点掉番外(保留来源标记)→ 不再强加
    ghost.is_system = true;
    ghost.extra = { bbs_omit_by: 'bbs-img-bridge' };
    echoes.length = 0;
    await captured.callback({}, 'ghosts');
    ok(ghost.extra.bbs_omit === undefined, '用户手动撤销后不再强加 omit');
    ok(ghost.extra.bbs_omit_by === undefined, '顺手清掉来源标记');

    // 已标好的不重复写、也不额外落盘
    saveCount = 0;
    ghost.is_system = true;
    ghost.extra = { bbs_omit: true, bbs_omit_by: 'bbs-img-bridge' };
    echoes.length = 0;
    await captured.callback({}, 'ghosts');
    ok(ghost.extra.bbs_omit === true && saveCount === 0, '已排除的楼不重复写盘');
}

console.log(`\n${pass} PASS / ${fail} FAIL`);
process.exit(fail ? 1 : 0);
