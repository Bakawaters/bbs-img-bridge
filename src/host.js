/**
 * bbs-img-bridge host 部分 —— 与 SillyTavern 打交道的那一半。
 * 由 build.mjs 与 src/scene.js 拼成 index.js（ST 只加载单个 js，不支持 import）。
 */

const CFG = {
    maxPeople: 3,
    style: '写实摄影，浅景深',
    sizeMulti: { w: 1248, h: 832 },
};

const LS = {
    enabled: 'bbs_img_enabled',
    style: 'bbs_img_style',
    maxchars: 'bbs_img_maxchars',
    detail: 'bbs_img_detail',
    size: 'bbs_img_size',
    people: 'bbs_img_people',
    view: 'bbs_img_view',
};

const st = {
    enabled: localStorage.getItem(LS.enabled) === 'true',
    style: localStorage.getItem(LS.style),   // null = 没设过，走自动判断
    view: localStorage.getItem(LS.view) || 'auto',   // auto | pov | two
    summaryMax: Number(localStorage.getItem(LS.maxchars)) || 140,
    detail: (() => {
        const raw = localStorage.getItem(LS.detail);
        if (raw === null) return 0;            // 默认 0 = 分段不截断
        const m = Number(raw);
        return m > 0 ? m : 0;
    })(),
    size: JSON.parse(localStorage.getItem(LS.size) || 'null') || CFG.sizeMulti,
    maxPeople: Number(localStorage.getItem(LS.people)) || CFG.maxPeople,
    busy: false,
    lastKey: '',
    lastCommand: '',
};

/* ---------------- 宿主适配 ---------------- */

function ctxOrNull() {
    try {
        return typeof SillyTavern !== 'undefined' && SillyTavern.getContext ? SillyTavern.getContext() : null;
    } catch {
        return null;
    }
}

function getSnapshot() {
    const api = globalThis.STBaiBaiBook;
    if (!api || typeof api.getSnapshot !== 'function') return null;
    try {
        return api.getSnapshot();
    } catch (e) {
        console.warn('[bbs-img] 取快照失败', e);
        return null;
    }
}

/** 角色卡 + 用户人设的描述，按名字索引 */
function collectCards() {
    const ctx = ctxOrNull();
    const cards = {};
    if (!ctx) return cards;

    for (const ch of ctx.characters || []) {
        if (ch?.name) cards[ch.name] = String(ch.description || '');
    }
    // 群聊成员有时不在 characters 里（charId 索引）
    for (const g of ctx.groups || []) {
        for (const id of g?.members || []) {
            const ch = (ctx.characters || [])[Number(id)];
            if (ch?.name) cards[ch.name] = cards[ch.name] || String(ch.description || '');
        }
    }

    try {
        const personas = ctx.powerUserSettings?.personas || {};
        const pid = ctx.userAvatar || 'user-default.png';
        cards.__user__ = String(personas[pid] || ctx.powerUserSettings?.persona_description || '');
        if (ctx.name1) cards[ctx.name1] = cards[ctx.name1] || cards.__user__;
    } catch { /* 老版本没有 personas */ }

    return cards;
}

/**
 * 画风词优先级：显式设置 > 角色卡里的风格信号 > ST 的 Prompt Prefix > 兜底。
 * 不能一律「写实摄影」——角色是二次元设定时，真人质感会变成 cosplay 感。
 */
function resolveStyle(cards) {
    if (st.style) return { style: st.style, from: '手动设置' };

    const blob = Object.values(cards || {}).join(' ').slice(0, 6000);
    if (/动漫|二次元|日系插画|漫画风|赛璐璐|galgame|视觉小说|美少女|呆毛|猫耳|兽耳|异色瞳|anime|illustration/i.test(blob)) {
        return { style: '动漫插画，赛璐璐上色', from: '角色卡(二次元)' };
    }
    if (/写实|真人|照片|摄影|realistic|photo/i.test(blob)) {
        return { style: '写实摄影，浅景深', from: '角色卡(写实)' };
    }

    const sd = ctxOrNull()?.extensionSettings?.sd;
    const prefix = String(sd?.prompt_prefix || '').trim();
    if (prefix) return { style: '', from: 'ST 的 Prompt Prefix' };

    return { style: '写实摄影，浅景深', from: '兜底' };
}

function activeChatName() {
    const ctx = ctxOrNull();
    return ctx?.name2 || '';
}

/* ---------------- 出图 ---------------- */

function buildPrompt() {
    const snap = getSnapshot();
    if (!snap) return { ok: false, reason: '柏宝书没加载，或这个聊天还没有记忆数据' };

    const cards = collectCards();
    const { style, from } = resolveStyle(cards);
    const res = composeScene({
        snapshot: snap,
        cards,
        style,
        styleFrom: from,
        view: st.view,
        userName: ctxOrNull()?.name1 || '',
        summaryMax: st.summaryMax,
        detail: st.detail,
        maxPeople: st.maxPeople,
        width: st.size?.w || CFG.sizeMulti.w,
        height: st.size?.h || CFG.sizeMulti.h,
    });

    if (!res.text) return { ok: false, reason: '组不出提示词：柏宝书里当前场景没有可画的人', report: res.report };
    return { ok: true, ...res, revision: snap.revision };
}

function sdCommand(res) {
    // STscript：/sd 只有一个非 split 的无名参数，parser 会把命令后所有字符原样收下
    // （见 SlashCommandParser.parseUnnamedArgument，split=false 分支），
    // 所以 JSON 既不用引号也不能有管道符 —— 加了引号反而会变成字面字符。
    const text = String(res.text).replace(/[|｜]/g, '，');
    return `/sd extend=false width=${res.width} height=${res.height} ${text}`;
}

async function doGenerate(force = false) {
    const built = buildPrompt();
    if (!built.ok) {
        return built;
    }
    if (st.busy) return { ok: false, reason: '上一张还没出完' };

    const key = `${built.revision}|${built.text}`;
    if (!force && key === st.lastKey) {
        return { ok: false, reason: 'duplicate' };
    }

    const cmd = sdCommand(built);
    const ctx = ctxOrNull();
    if (!ctx?.executeSlashCommandsWithOptions) return { ok: false, reason: '宿主不支持斜杠命令' };

    st.busy = true;
    st.lastKey = key;
    st.lastCommand = cmd;
    try {
        console.log('[bbs-img] 出图', built.mode, built.width + 'x' + built.height, built.text);
        const url = await ctx.executeSlashCommandsWithOptions(cmd);
        if (!url) {
            return { ok: false, reason: '出图命令执行了但没拿到图片地址，用 /bbs-img rawcmd 看提交内容', cmd };
        }
        return { ok: true, mode: built.mode, report: built.report };
    } catch (e) {
        console.warn('[bbs-img] 出图失败', e);
        return { ok: false, reason: String(e?.message || e) };
    } finally {
        st.busy = false;
    }
}

/* ---------------- 输出 ---------------- */

function safeEcho(s) {
    return String(s ?? '').replace(/[|｜]/g, '，').replace(/\{\{/g, '{ {').replace(/[\r\n]+/g, ' ').slice(0, 4000);
}

async function echo(text) {
    const ctx = ctxOrNull();
    try {
        await ctx.executeSlashCommandsWithOptions(`/echo ${safeEcho(text)}`);
    } catch (e) {
        console.warn('[bbs-img] echo 失败', e);
    }
}

async function doPreview(verbose) {
    const built = buildPrompt();
    if (!built.ok && !built.report) { await echo('[bbs-img] ' + built.reason); return; }

    await echo('[bbs-img] ' + (built.report || []).join(' | '));
    if (!built.ok) { await echo('[bbs-img] ' + built.reason); return; }

    const one = built.mode === 'single' || built.mode === 'pov';
    const cap = built.cap || st.summaryMax;
    // maxchars 是天花板不是目标：内容不够就写不满，得靠 situation/场景/外貌 加料
    const shortNote = one && Number.isFinite(cap) && built.text.length < cap * 0.7
        ? `（上限 ${cap} 字，没写满：长度由 situation / 场景 / 外貌的内容量决定，调大上限不会让提示词变长）`
        : '';
    await echo(`[bbs-img] ${built.mode} ${built.width}x${built.height}，提示词 ${built.text.length} 字${shortNote}`);
    if (verbose) {
        await echo('[bbs-img] ' + built.text);
        await echo('[bbs-img] 命令: ' + sdCommand(built));
    } else {
        // 头 200 + 尾 120：画风这类追加在后缀的词，只显示开头会让人以为没生效
        const head = built.text.slice(0, 200);
        const tail = built.text.slice(-120);
        const shown = built.text.length > 320 ? `${head}……${tail}` : built.text;
        const more = built.text.length > 320 ? `（预览显示首尾，实际提交 ${built.text.length} 字，看全用 preview+）` : '';
        await echo('[bbs-img] ' + shown + more);
    }

    const sd = ctxOrNull()?.extensionSettings?.sd;
    if (sd && !/moss/i.test(String(sd.comfy_workflow || ''))) {
        await echo(`[bbs-img] ⚠ 当前 ComfyUI 工作流是 ${sd.comfy_workflow}，不是 MOSS 的（文件名里应含 moss）`);
    }
}

async function doRaw() {
    const snap = getSnapshot();
    if (!snap) { await echo('[bbs-img] 拿不到快照'); return; }
    const sf = snap.state?.sceneFocus || null;
    const slim = {
        revision: snap.revision,
        vars: snap.vars,
        state: { time: snap.state?.time, location: snap.state?.location, locationPath: snap.state?.locationPath, sceneFocus: sf },
        protagonist: snap.protagonist,
        scenes: (snap.scenes || []).slice(0, 3).map(s => ({ name: s.name, desc: s.desc })),
        npcs: (snap.npcs || []).slice(0, 4).map(n => ({ name: n.name, desc: n.desc, outfit: n.outfit, condition: n.condition })),
        coverage: snap.coverage,
    };
    await echo('[bbs-img] ' + JSON.stringify(slim));
}

/* ---------------- 注册 ---------------- */

function register() {
    const ctx = ctxOrNull();
    if (!ctx) return;
    const { SlashCommand, SlashCommandParser } = ctx;
    if (!SlashCommand || !SlashCommandParser) return;

    const setStyle = async (v) => {
        v = String(v ?? '').trim();
        if (!v || /^(auto|默认|自动)$/i.test(v)) {
            st.style = null;
            localStorage.removeItem(LS.style);
            await echo('[bbs-img] 画风改回自动（角色卡二次元→动漫插画，否则写实摄影）');
        } else {
            st.style = v;
            localStorage.setItem(LS.style, v);
            await echo(`[bbs-img] 画风固定为：${st.style}`);
        }
    };
    const setView = async (v) => {
        const t = String(v ?? '').trim().toLowerCase();
        let mode = 'auto';
        if (/^(pov|first|1st|第一人称)$/.test(t)) mode = 'pov';
        else if (/^(two|双人|多人|三人称|第三)$/.test(t)) mode = 'two';
        else if (!/^(auto|默认|自动)$/.test(t) && t) { await echo('[bbs-img] view= 只认 auto / pov / two'); return; }
        st.view = mode;
        localStorage.setItem(LS.view, mode);
        await echo(`[bbs-img] 视角：${{ auto: '自动（镜头里写第一人称才走 pov）', pov: '固定第一人称，画面只画对方', two: '固定双人同框' }[mode]}`);
    };
    const setPeople = async (v) => {
        const n = Number(String(v).match(/\d/)?.[0]);
        if (!n) { await echo('[bbs-img] people= 后面要跟数字 1–3'); return; }
        st.maxPeople = Math.max(1, Math.min(3, n));
        localStorage.setItem(LS.people, String(st.maxPeople));
        await echo(`[bbs-img] 最多画 ${st.maxPeople} 人`);
    };
    const setMaxchars = async (v) => {
        const asked = Number(String(v).match(/\d+/)?.[0]) || 140;
        st.summaryMax = Math.max(60, asked);   // 只有下限，没有上限
        localStorage.setItem(LS.maxchars, String(st.summaryMax));
        await echo(`[bbs-img] 镜头字数上限 ${st.summaryMax}`);
    };
    const setDetail = async (v) => {
        const m = Number(String(v).replace(/[^\d.]/g, ''));
        if (!Number.isFinite(m)) { await echo('[bbs-img] detail= 后面要跟倍数，比如 0.5；0 或 auto = 不截断'); return; }
        st.detail = m > 0 ? m : 0;
        localStorage.setItem(LS.detail, String(st.detail));
        if (!st.detail) { await echo('[bbs-img] 分段不截断：外貌/服装/状态/场景/item 原文有多少字进多少字'); return; }
        await echo(`[bbs-img] 分段截断 ×${st.detail}：外貌 ${Math.round(70 * st.detail)} / 服装 ${Math.round(30 * st.detail)} / 状态 ${Math.round(24 * st.detail)} / 场景 ${Math.round(70 * st.detail)} / item ${Math.round(90 * st.detail)}`);
    };
    const setSize = async (v) => {
        const m = String(v).match(/(\d+)\s*[xX*]\s*(\d+)/);
        if (!m) { await echo('[bbs-img] size= 要写成 1248x832 这样'); return; }
        st.size = { w: Number(m[1]), h: Number(m[2]) };
        localStorage.setItem(LS.size, JSON.stringify(st.size));
        await echo(`[bbs-img] 多人图尺寸 ${st.size.w}x${st.size.h}（bbox 会按新尺寸重算）`);
    };

    /*
     * ⚠️ ST 的解析器会把任何 `key=value` 当成命名参数（正则 /^(\w+)=/），
     * 所以 /bbs-img style=xxx 里的 style 根本不会出现在无名参数里 ——
     * 必须从第 1 个实参（named）里读，只读 value 会变成"啥也没设，直接出图"。
     */
    const namedArgumentList = [];
    try {
        const N = ctx.SlashCommandNamedArgument ?? ctx.SlashCommandParser?.SlashCommandNamedArgument;
        if (N?.fromProps) {
            for (const [name, description] of [
                ['style', '画风后缀；auto 回到自动判断'],
                ['view', '视角：auto 自动 / pov 第一人称 / two 双人同框'],
                ['maxchars', '镜头字数上限，默认 140；实测 90-120 最准（不设上限，填多少就是多少）'],
                ['detail', '分段截断倍数；不填=不截断，0.5=收一半，2=放宽一倍'],
                ['people', '最多画几个人 1–3'],
                ['size', '多人图尺寸，如 1248x832'],
            ]) {
                namedArgumentList.push(N.fromProps({
                    name, description, typeList: ['string'], isRequired: false, acceptsMultiple: false,
                }));
            }
        }
    } catch (e) {
        console.warn('[bbs-img] 命名参数声明失败（不影响使用）', e);
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bbs-img',
        returns: 'string',
        namedArgumentList,
        callback: async (named, value) => {
            const n = named || {};
            let touched = false;
            let arg = String(value || '').trim();

            /*
             * ST 的命名参数值遇到空格就截断：/bbs-img style=anima char
             * 会变成 named.style='anima' + value='char'，然后 'char' 被当成
             * 无名参数 → 直接出图。这里把剩下的词并回画风，并且不再出图。
             */
            const SUB = /^(preview\+?|full|raw|rawcmd|on|off|reset)$/i;
            if (n.style !== undefined && arg && !SUB.test(arg)) {
                const merged = `${String(n.style).trim()} ${arg}`.trim();
                await setStyle(merged);
                await echo('[bbs-img] 画风带空格时用双引号更稳：/bbs-img style="anima char"');
                return '';
            }

            if (n.style !== undefined) { await setStyle(n.style); touched = true; }
            if (n.view !== undefined) { await setView(n.view); touched = true; }
            if (n.people !== undefined) { await setPeople(n.people); touched = true; }
            if (n.size !== undefined) { await setSize(n.size); touched = true; }
            if (n.detail !== undefined) { await setDetail(n.detail); touched = true; }
            if (n.maxchars !== undefined) { await setMaxchars(n.maxchars); touched = true; }

            const low = arg.toLowerCase();

            if (low === 'preview') { await doPreview(false); return ''; }
            if (low === 'preview+' || low === 'full') { await doPreview(true); return ''; }
            if (low === 'raw') { await doRaw(); return ''; }
            if (low === 'rawcmd') { await echo('[bbs-img] ' + (st.lastCommand || sdCommand(buildPrompt()))); return ''; }

            if (low === 'on' || low === 'off') {
                st.enabled = low === 'on';
                localStorage.setItem(LS.enabled, String(st.enabled));
                await echo(`[bbs-img] 收到 AI 消息自动出图：${st.enabled ? '开' : '关'}`);
                return '';
            }

            if (low === 'reset') {
                st.lastKey = '';
                await echo('[bbs-img] 已清掉去重记录，下次一定出图');
                return '';
            }

            const mStyle = arg.match(/style=(.*)$/i);
            if (mStyle) { await setStyle(mStyle[1]); return ''; }

            const mView = arg.match(/view=(auto|pov|two|第一人称|双人)/i);
            if (mView) { await setView(mView[1]); return ''; }

            const mPeople = arg.match(/people=(\d)/i);
            if (mPeople) { await setPeople(mPeople[1]); return ''; }

            const mSize = arg.match(/size=(\d+)x(\d+)/i);
            if (mSize) { await setSize(`${mSize[1]}x${mSize[2]}`); return ''; }

            const mDetail = arg.match(/detail=(\d+(?:\.\d+)?)/i);
            if (mDetail) { await setDetail(mDetail[1]); return ''; }

            const mMaxchars = arg.match(/maxchars=(\d+)/i);
            if (mMaxchars) { await setMaxchars(mMaxchars[1]); return ''; }

            if (!arg && touched) return '';   // 只设参数，不出图

            const r = await doGenerate(true);
            if (!r.ok && r.reason !== 'duplicate') await echo(`[bbs-img] ${r.reason}`);
            return '';
        },
        helpString: '/bbs-img 出图 · preview 看字段来源 · preview+ 看完整提示词 · raw 看快照 · rawcmd 看提交命令 · on/off 自动 · style= 画风 · view=pov 第一人称 · people=3 · size=1248x832 · reset',
    }));

    try {
        ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
            if (!st.enabled) return;
            doGenerate().catch(e => console.warn('[bbs-img]', e));
        });
    } catch (e) {
        console.warn('[bbs-img] 事件订阅失败', e);
    }

    console.log('[bbs-img] 已加载 v' + VERSION + '，自动出图' + (st.enabled ? '开' : '关'));
}

if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', register, { once: true });
    } else {
        register();
    }
} else {
    console.warn('[bbs-img] 找不到 SillyTavern 上下文');
}
