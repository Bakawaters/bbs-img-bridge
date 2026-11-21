/**
 * bbs-img-bridge host 部分 —— 与 SillyTavern 打交道的那一半。
 * 由 build.mjs 与 src/scene.js 拼成 index.js（ST 只加载单个 js，不支持 import）。
 *
 * v2.0：只留管道。取快照 → 取镜头/兜底 → 拼 /sd → 去重。参数面只剩 style。
 */

const LS = {
    enabled: 'bbs_img_enabled',
    style: 'bbs_img_style',
};

const st = {
    enabled: localStorage.getItem(LS.enabled) === 'true',
    style: localStorage.getItem(LS.style),   // null = 不加画风前缀
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

/* ---------------- 出图 ---------------- */

function buildPrompt() {
    const snap = getSnapshot();
    if (!snap) return { ok: false, reason: '柏宝书没加载，或这个聊天还没有记忆数据' };

    const res = composeScene({
        snapshot: snap,
        cards: collectCards(),
        style: st.style || '',
    });

    if (!res.text) return { ok: false, reason: '拼不出提示词', report: res.report };
    return { ok: true, ...res, revision: snap.revision };
}

function sdCommand(res) {
    // STscript：/sd 只有一个非 split 的无名参数，parser 会把命令后所有字符原样收下
    // （见 SlashCommandParser.parseUnnamedArgument，split=false 分支），
    // 所以文本既不用引号也不能有管道符 —— 加了引号反而会变成字面字符。
    // 宽高不传：交给酒馆 Image Generation 面板，避免扩展和工作流各写一套。
    const text = String(res.text).replace(/[|｜]/g, '，');
    return `/sd extend=false ${text}`;
}

async function doGenerate(force = false) {
    const built = buildPrompt();
    if (!built.ok) return built;
    if (st.busy) return { ok: false, reason: '上一张还没出完' };

    const key = `${built.revision}|${built.text}`;
    if (!force && key === st.lastKey) return { ok: false, reason: 'duplicate' };

    const cmd = sdCommand(built);
    const ctx = ctxOrNull();
    if (!ctx?.executeSlashCommandsWithOptions) return { ok: false, reason: '宿主不支持斜杠命令' };

    st.busy = true;
    st.lastKey = key;
    st.lastCommand = cmd;
    try {
        console.log('[bbs-img] 出图', built.mode, built.text);
        const url = await ctx.executeSlashCommandsWithOptions(cmd);
        if (!url) return { ok: false, reason: '出图命令执行了但没拿到图片地址，用 /bbs-img rawcmd 看提交内容', cmd };
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

    if (built.report?.length) await echo('[bbs-img] ' + built.report.join(' | '));
    if (!built.ok) { await echo('[bbs-img] ' + built.reason); return; }

    await echo(`[bbs-img] ${built.mode}，提示词 ${built.text.length} 字`);
    if (verbose) {
        await echo('[bbs-img] ' + built.text);
        await echo('[bbs-img] 命令: ' + sdCommand(built));
    } else {
        const head = built.text.slice(0, 200);
        const tail = built.text.slice(-120);
        const shown = built.text.length > 320 ? `${head}……${tail}` : built.text;
        const more = built.text.length > 320 ? `（预览显示首尾，实际 ${built.text.length} 字，看全用 preview+）` : '';
        await echo('[bbs-img] ' + shown + more);
    }

    const sd = ctxOrNull()?.extensionSettings?.sd;
    if (sd && sd.comfy_workflow && !/moss/i.test(String(sd.comfy_workflow))) {
        await echo(`[bbs-img] ⚠ 当前 ComfyUI 工作流是 ${sd.comfy_workflow}，不是 MOSS 的（文件名里应含 moss）`);
    }
}

async function doRaw() {
    const snap = getSnapshot();
    if (!snap) { await echo('[bbs-img] 拿不到快照'); return; }
    const slim = {
        revision: snap.revision,
        vars: snap.vars,
        state: {
            time: snap.state?.time,
            location: snap.state?.location,
            locationPath: snap.state?.locationPath,
            sceneFocus: snap.state?.sceneFocus || null,
        },
        protagonist: snap.protagonist,
        scenes: (snap.scenes || []).slice(0, 3).map(s => ({ name: s.name, desc: s.desc })),
        npcs: (snap.npcs || []).slice(0, 6).map(n => ({ name: n.name, desc: n.desc, outfit: n.outfit, condition: n.condition })),
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
        if (!v || /^(auto|默认|自动|off)$/i.test(v)) {
            st.style = null;
            localStorage.removeItem(LS.style);
            await echo('[bbs-img] 画风前缀已清空，提示词只用镜头原文');
        } else {
            st.style = v;
            localStorage.setItem(LS.style, v);
            await echo(`[bbs-img] 画风前缀固定为：${st.style}`);
        }
    };

    const namedArgumentList = [];
    try {
        const N = ctx.SlashCommandNamedArgument ?? ctx.SlashCommandParser?.SlashCommandNamedArgument;
        if (N?.fromProps) {
            namedArgumentList.push(N.fromProps({
                name: 'style',
                description: '画风前缀，拼在镜头原文前面；auto/off 清空',
                typeList: ['string'],
                isRequired: false,
                acceptsMultiple: false,
            }));
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
            const arg = String(value || '').trim();

            /*
             * ST 的命名参数值遇到空格就截断：/bbs-img style=anima char
             * 会变成 named.style='anima' + value='char'，然后 'char' 被当成
             * 无名参数 → 直接出图。这里把剩下的词并回画风，并且不再出图。
             */
            const SUB = /^(preview\+?|full|raw|rawcmd|on|off|reset)$/i;
            if (n.style !== undefined) {
                if (arg && !SUB.test(arg)) {
                    await setStyle(`${String(n.style).trim()} ${arg}`.trim());
                    await echo('[bbs-img] 画风带空格时用双引号更稳：/bbs-img style="anima char"');
                    return '';
                }
                await setStyle(n.style);
                return '';
            }

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

            if (/^\w+=/.test(arg)) {
                await echo(`[bbs-img] 不认识的参数 ${arg}。v2.0 只保留 style=，view/bbox/people/size/detail/maxchars 已删除`);
                return '';
            }

            const r = await doGenerate(true);
            if (!r.ok && r.reason !== 'duplicate') await echo(`[bbs-img] ${r.reason}`);
            return '';
        },
        helpString: '/bbs-img 出图 · preview 看镜头来源 · preview+ 看完整提示词 · raw 看快照 · rawcmd 看提交命令 · on/off 自动出图 · style=xxx 画风前缀（auto 清空） · reset 清去重',
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
