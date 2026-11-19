import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
const echoes = [];
const commands = [];
let captured = null;
const store = {};   // 所有 run 共享，模拟 localStorage 持久化

const snapshots = {
    pair: {
        revision: 7,
        chat: { length: 42, characterName: '林夏' },
        state: {
            time: '2026-11-19 22:10', location: '城南旧书店二楼',
            locationPath: ['城南', '旧书店', '二楼'],
            sceneFocus: { situation: '沈砚从背后环抱住林夏的腰，两人贴得很近，林夏侧头微笑', participants: ['林夏', '沈砚'] },
        },
        protagonist: { gender: '女', outfit: '灰色针织衫' },
        scenes: [{ name: '二楼', desc: '木质地板的老书店二楼，成排到顶的书架，暖黄壁灯' }],
        npcs: [
            { name: '林夏', desc: '黑色短发，琥珀色眼睛，皮肤偏白，个子不高', outfit: '灰色针织衫', important: true },
            { name: '沈砚', desc: '亚麻色长卷发，浅褐色眼睛，身形高瘦', outfit: '深蓝色衬衫' },
        ],
        coverage: { complete: true, missingAiFloors: [] },
    },
    empty: { revision: 8, state: { sceneFocus: null }, npcs: [], scenes: [], protagonist: {} },
};

function makeCtx(snap) {
    const context = {
        SillyTavern: {
            getContext: () => ({
                characters: [
                    { name: '林夏', description: '一位二十出头的女性，黑色短发，琥珀色眼睛。性格安静。' },
                    { name: '沈砚', description: '身材高瘦的女性，亚麻色长卷发，浅褐色眼睛。' },
                ],
                groups: [],
                name1: '旅人', name2: '林夏', userAvatar: 'user-default.png',
                powerUserSettings: { personas: { 'user-default.png': '一位年轻女性，黑色长发扎成低马尾，穿深色外套' } },
                extensionSettings: { sd: { comfy_workflow: 'MOSS_Image_8步.json', comfy_url: 'http://127.0.0.1:8188' } },
                SlashCommand: { fromProps: o => o },
                SlashCommandParser: { addCommandObject: o => { captured = o; } },
                eventSource: { on: () => {} },
                eventTypes: { MESSAGE_RECEIVED: 'msg' },
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
        console,
    };
    context.globalThis = context;
    vm.createContext(context);
    return context;
}

function run(name, snap, arg, named = {}) {
    echoes.length = 0; commands.length = 0; captured = null;
    const ctx = makeCtx(snap);
    vm.runInContext(code, ctx);
    if (!captured) throw new Error(`${name}: 命令没注册`);
    return captured.callback(named, arg).then(() => ({ echoes: [...echoes], commands: [...commands] }));
}

const ok = (c, m) => console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);

let r = await run('pair-preview', snapshots.pair, 'preview+');
const joined = r.echoes.join('\n');
ok(joined.includes('在场: 林夏/沈砚'), 'preview 报告在场人物');
ok(joined.includes('npc.desc'), 'preview 报告外貌来源');
ok(joined.includes('"bbox_coord_space":"abs_centralized"'), 'preview 输出 layout JSON');
ok(joined.includes('"label":"character"'), 'preview 用 character 标签');
ok(joined.includes('背对镜头'), '「从背后」被解析成朝向');
ok(joined.includes('/sd extend=false width=1248 height=832'), '命令带多人尺寸');

r = await run('pair-generate', snapshots.pair, '');
ok(r.commands.length === 1, '默认参数触发一次出图');
ok(r.commands[0].startsWith('/sd extend=false width=1248 height=832 {'), '命令裸传紧凑 JSON（无引号包裹）');
ok(!/[|｜]/.test(r.commands[0]), '命令里没有管道符');
const jsonPart = r.commands[0].slice(r.commands[0].indexOf('{'));
try { JSON.parse(jsonPart); ok(true, '命令尾巴是合法 JSON'); } catch (e) { ok(false, '命令尾巴是合法 JSON: ' + e.message); }

r = await run('empty', snapshots.empty, 'preview');
ok(r.echoes.join('\n').includes('组不出提示词') || r.echoes.join('\n').includes('没有可画的人'), '空场景给出明确原因');

r = await run('style', snapshots.pair, 'style=动漫赛璐璐');
ok(r.echoes.join('\n').includes('动漫赛璐璐'), 'style= 可改画风');

r = await run('people', snapshots.pair, 'people=1');
ok(r.echoes.join('\n').includes('最多画 1 人'), 'people= 生效');

/* ---- 命名参数：ST 会把 key=value 从无名参数里拿走，必须从 named 读 ---- */
const mem = {};
globalThis.__mem = mem;
r = await run('style-named', snapshots.pair, '', { style: '动漫插画，赛璐璐上色' });
ok(r.echoes.join('\n').includes('动漫插画'), 'style= 走命名参数也能设上');
ok(r.commands.length === 0, '只设 style 不触发出图');

r = await run('style-used', snapshots.pair, 'preview+');
ok(r.echoes.join('\n').includes('画风: 动漫插画，赛璐璐上色（手动设置）'), '设置了 style 后 preview 显示手动来源');

r = await run('people-named', snapshots.pair, '', { people: '2' });
ok(r.echoes.join('\n').includes('最多画 2 人'), 'people= 走命名参数生效');
ok(r.commands.length === 0, '只设 people 不触发出图');

r = await run('size-named', snapshots.pair, '', { size: '1024x1024' });
ok(r.echoes.join('\n').includes('1024x1024'), 'size= 走命名参数生效');
