/**
 * bbs-img-bridge host 部分 —— 与 SillyTavern 打交道的那一半。
 * 由 build.mjs 与 src/scene.js 拼成 index.js（ST 只加载单个 js，不支持 import）。
 */

const CFG = {
    maxPeople: 3,
    style: '写实摄影，浅景深',
    sizeSingle: { w: 1024, h: 1024 },
    sizeMulti: { w: 1248, h: 832 },
    autoOnReceive: false,
};

const LS = {
    enabled: 'bbs_img_enabled',
    style: 'bbs_img_style',
    size: 'bbs_img_size',
    people: 'bbs_img_people',
};

const st = {
    enabled: localStorage.getItem(LS.enabled) === 'true',
    style: localStorage.getItem(LS.style),   // null = 没设过，走自动判断
    size: JSON.parse(localStorage.getItem(LS.size) || 'null') || CFG.sizeMulti,
    maxPeople: Number(localStorage.getItem(LS.people)) || CFG.maxPeople,
    busy: false,
    lastKey: '',
    fired: 0,
    skipped: 0,
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
        st.skipped++;
        return built;
    }
    if (st.busy) return { ok: false, reason: '上一张还没出完' };

    const key = `${built.revision}|${built.text}`;
    if (!force && key === st.lastKey) {
        st.skipped++;
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
        st.fired++;
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
    return String(s ?? '').replace(/[|｜]/g, '，').replace(/\{\{/g, '{ {').replace(/[\r\n]+/g, ' ').slice(0, 1600);
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

    await echo(`[bbs-img] ${built.mode} ${built.width}x${built.height}，提示词 ${built.text.length} 字`);
    if (verbose) {
        await echo('[bbs-img] ' + built.text);
        await echo('[bbs-img] 命令: ' + sdCommand(built));
    } else {
        await echo('[bbs-img] ' + built.text.slice(0, 300));
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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bbs-img',
        returns: 'string',
        callback: async (_named, value) => {
            const arg = String(value || '').trim();
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
            if (mStyle) {
                const v = mStyle[1].trim();
                if (!v || /^(auto|默认|自动)$/i.test(v)) {
                    st.style = null;
                    localStorage.removeItem(LS.style);
                    await echo('[bbs-img] 画风改回自动（角色卡二次元→动漫插画，否则写实摄影）');
                } else {
                    st.style = v;
                    localStorage.setItem(LS.style, v);
                    await echo(`[bbs-img] 画风固定为：${st.style}`);
                }
                return '';
            }

            const mPeople = arg.match(/people=(\d)/i);
            if (mPeople) {
                st.maxPeople = Math.max(1, Math.min(3, Number(mPeople[1])));
                localStorage.setItem(LS.people, String(st.maxPeople));
                await echo(`[bbs-img] 最多画 ${st.maxPeople} 人`);
                return '';
            }

            const mSize = arg.match(/size=(\d+)x(\d+)/i);
            if (mSize) {
                st.size = { w: Number(mSize[1]), h: Number(mSize[2]) };
                localStorage.setItem(LS.size, JSON.stringify(st.size));
                await echo(`[bbs-img] 多人图尺寸 ${st.size.w}x${st.size.h}（bbox 会按新尺寸重算）`);
                return '';
            }

            const r = await doGenerate(true);
            if (!r.ok && r.reason !== 'duplicate') await echo(`[bbs-img] ${r.reason}`);
            return '';
        },
        helpString: '/bbs-img 出图 · preview 看字段来源 · preview+ 看完整提示词 · raw 看快照 · rawcmd 看提交命令 · on/off 自动 · style= 画风 · people=3 · size=1248x832 · reset',
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
