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
ok(r.echoes.join('\n').includes('赛璐璐上色'), '有 situation 时画风追加到单图提示词里');

/* ---- v1.4.10：caption 自带的媒介必须被用户画风顶掉 ---- */
const snapMedium = {
    ...snapshots.pair,
    state: { ...snapshots.pair.state, sceneFocus: { situation: '', participants: ['林夏', '沈砚'] } },
    vars: { situation: 'Photorealistic digital illustration: two women stand by the window of a bookstore.' },
};
r = await run('style-override', snapMedium, '');
{
    const cmd = r.commands.join('\n');
    ok(cmd.includes('动漫插画，赛璐璐上色: ') || cmd.includes('动漫插画，赛璐璐上色：'), '画风整段（含后缀段）顶到最前面');
    ok(!cmd.includes('Photorealistic'), 'caption 原有媒介不再进提交文本');
}

r = await run('people-named', snapshots.pair, '', { people: '2' });
ok(r.echoes.join('\n').includes('最多画 2 人'), 'people= 走命名参数生效');
ok(r.commands.length === 0, '只设 people 不触发出图');

r = await run('size-named', snapshots.pair, '', { size: '1024x1024' });
ok(r.echoes.join('\n').includes('1024x1024'), 'size= 走命名参数生效');

/* ---- 自定义变量 situation（柏宝书 vars）优先于内置局势卡 ---- */
const snapVarShot = {
    revision: 12,
    state: { time: '2026-11-19 23:40', location: '街心绿化带', sceneFocus: null },
    vars: { situation: '沈砚从背后环抱住林夏的腰，两人贴得很近，林夏侧头微笑' },
    protagonist: {},
    scenes: [],
    npcs: [
        { name: '林夏', desc: '黑色短发，琥珀色眼睛' },
        { name: '沈砚', desc: '亚麻色长卷发，身形高瘦' },
    ],
};
r = await run('var-shot', snapVarShot, 'preview+');
const vt = r.echoes.join('\n');
ok(vt.includes('自定义变量 situation'), '画面镜头取自自定义变量');
ok(vt.includes('在场: 林夏/沈砚'), 'participants 为空时从镜头里的人名推断在场');
ok(vt.includes('构图: 2人/close'), '「环抱住」被判为贴身接触');
ok(vt.includes('"caption":"动漫插画，') || vt.includes('动漫插画，'), '提示词以媒介开头');
ok(vt.includes('赛璐璐上色'), '有 situation 时画风也进 summary.caption（多人同理）');

const snapNoVar = { ...snapVarShot, vars: {}, state: { ...snapVarShot.state, sceneFocus: { situation: '两人在绿化带里站着', participants: ['林夏'] } } };
r = await run('no-var-shot', snapNoVar, 'preview');
ok(r.echoes.join('\n').includes('sceneFocus.situation'), '没有自定义变量时回退内置局势卡');

r = await run('maxchars-named', snapshots.pair, '', { maxchars: '240' });
ok(r.echoes.join('\n').includes('镜头字数上限 240'), 'maxchars= 走命名参数生效');
ok(r.commands.length === 0, '只设 maxchars 不触发出图');

/* ---- v1.4.2：maxchars 天花板 400 → 800 ---- */
r = await run('maxchars-800', snapshots.pair, '', { maxchars: '800' });
ok(r.echoes.join('\n').includes('镜头字数上限 800'), 'maxchars=800 不再被静默压回 400');
r = await run('maxchars-over', snapshots.pair, '', { maxchars: '1200' });
ok(r.echoes.join('\n').includes('镜头字数上限 1200'), 'maxchars 没有天花板，填 1200 就是 1200');
r = await run('detail-named', snapshots.pair, '', { detail: '2' });
{
    const e = r.echoes.join('\n');
    ok(e.includes('分段截断 ×2') && e.includes('外貌 140'), 'detail=2 把外貌截断放到 140');
}
r = await run('detail-off', snapshots.pair, '', { detail: '0' });
ok(r.echoes.join('\n').includes('分段不截断'), 'detail=0 回到不截断（默认态）');
r = await run('maxchars-back', snapshots.pair, '', { maxchars: '140' });
ok(r.echoes.join('\n').includes('镜头字数上限 140'), 'maxchars 可以改回 140');

/* ---- v1.4.5：英文长描述不能被中文正则误伤 ---- */
const snapEn = {
    ...snapVarShot,
    state: { ...snapVarShot.state, sceneFocus: { participants: ['沈砚'] } },
    vars: { situation: 'Studio photograph of a woman with teal hair (shoulder length). The sign reads "MOSS BOOKS" in gold serif! Lighting: warm tungsten from the right.' },
};
r = await run('shot-english', snapEn, 'preview+');
{
    const e = r.echoes.join('\n');
    ok(e.includes('(shoulder length)'), '英文括注不被删');
    ok(e.includes('"MOSS BOOKS"'), '英文双引号文案不被删');
    ok(e.includes('serif'), '英文句子完整保留');
    ok(e.includes('原样使用'), '英文长描述原样通过（报告显示原样使用）');
}

/* ---- v1.4.0：镜头不能截断、不能只取第一个字段 ---- */
const snapMulti = {
    ...snapVarShot,
    vars: { situation: '林夏站在左侧，面向沈砚。重心落在右腿，右手扶着沈砚的左肩。两人相距半步，沈砚侧头看她。' },
};
r = await run('shot-multi-sentence', snapMulti, 'preview+');
const mt = r.echoes.join('\n');
ok(mt.includes('沈砚侧头看她'), '多句镜头保留到最后一句（不再只取第一句）');
ok(mt.includes('重心落在右腿'), '多句镜头中间句没丢');
ok(mt.includes('原样使用'), '报告写明镜头原样使用');

const snapObj = {
    ...snapVarShot,
    vars: { situation: { 位置: '林夏在左，沈砚在右', 手: '林夏右手扶在沈砚肩上', 接触: '手掌与肩相触' } },
};
r = await run('shot-object', snapObj, 'preview+');
const ot = r.echoes.join('\n');
ok(ot.includes('手掌与肩相触'), '对象镜头把所有字段合并发送（不再只取第一个子键）');
ok(ot.includes('3 个字段'), '报告写出镜头字段数');

const snapPov = {
    revision: 13,
    state: { time: '2026-11-20 21:00', location: '卧室', sceneFocus: null },
    vars: { situation: '林夏俯身靠近，右手撑着椅背，视线落在镜头上' },
    protagonist: { name: '旅人' },
    scenes: [],
    npcs: [{ name: '林夏', desc: '黑色短发，琥珀色眼睛' }],
};
r = await run('view-pov', snapPov, 'preview+', { view: 'pov' });
const pt = r.echoes.join('\n');
ok(pt.includes('第一人称视角，镜头位于主角双眼高度'), 'view=pov 注入第一人称镜头描述');
ok(pt.includes('视角: 第一人称'), 'view=pov 报告视角来源');
ok(!pt.includes('"items"'), 'pov 走单人自然语言，不出 layout JSON');

r = await run('view-reset', snapshots.pair, '', { view: 'auto' });
ok(r.echoes.join('\n').includes('视角：自动'), 'view=auto 可复位');
