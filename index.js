/**
 * 柏宝书生图桥接 —— 独立酒馆扩展（不依赖酒馆助手）
 *
 * 把「整条消息原文」换成「柏宝书里的结构化短描述」，再交给 SD 扩展出图。
 *   /bbs-img            立刻出一次图
 *   /bbs-img preview    只看拼出来的提示词（echo 到聊天，手机上也看得到）
 *   /bbs-img on         开启自动：每条 AI 回复后出图
 *   /bbs-img off        关闭自动
 *   /bbs-img maxchars=100
 *
 * 取不到数据时直接跳过，绝不退回整条消息。
 */

const LS_ENABLED = 'bbs_img_enabled';
const LS_MAXCHARS = 'bbs_img_maxchars';
const DEFAULT_MAX = 120;

const state = {
    enabled: localStorage.getItem(LS_ENABLED) === 'true',
    maxChars: Number(localStorage.getItem(LS_MAXCHARS)) || DEFAULT_MAX,
    lastPrompt: '',
    lastRevision: -1,
    busy: false,
    fired: 0,
    skipped: 0,
};

/* ---------------- 工具 ---------------- */

function flatten(s) {
    return String(s ?? '').replace(/[\r\n]+/g, '，').replace(/\s+/g, ' ').trim();
}

/** 清掉会破坏 STscript 解析的字符 */
function sanitize(s) {
    return flatten(s)
        .replace(/[|｜]/g, '，')
        .replace(/[{}]/g, '')
        .replace(/^\/+/, '');
}

function clamp(s, n) {
    s = sanitize(s);
    return s.length > n ? s.slice(0, n) : s;
}

function lightFromTime(timeText) {
    const t = String(timeText ?? '');
    const m = t.match(/(\d{1,2})\s*[:：]\s*\d{2}/);
    if (m) {
        const h = Number(m[1]);
        if (h >= 5 && h < 8) return '清晨柔和侧光';
        if (h >= 8 && h < 11) return '上午自然光';
        if (h >= 11 && h < 14) return '正午顶光';
        if (h >= 14 && h < 17) return '午后暖光';
        if (h >= 17 && h < 19) return '黄昏逆光';
        if (h >= 19 && h < 23) return '夜晚暖色灯光';
        return '夜晚冷光低照度';
    }
    if (/清晨|早晨|黎明/.test(t)) return '清晨柔和侧光';
    if (/正午|中午/.test(t)) return '正午顶光';
    if (/黄昏|傍晚|日落/.test(t)) return '黄昏逆光';
    if (/夜|晚/.test(t)) return '夜晚暖色灯光';
    return '';
}

/* ---------------- 数据 ---------------- */

function getApi() {
    return globalThis.STBaiBaiBook;
}

function getSnapshot() {
    const api = getApi();
    if (!api || typeof api.getSnapshot !== 'function') return null;
    try {
        return api.getSnapshot();
    } catch (e) {
        console.warn('[bbs-img] 取快照失败', e);
        return null;
    }
}

function buildPrompt(snap) {
    if (!snap) return '';
    const p = snap.protagonist || {};
    const st = snap.state || {};

    let looks = sanitize(p.appearance || '');
    if (!looks) {
        try {
            const ctx = SillyTavern.getContext();
            const ch = ctx?.characters?.[ctx.characterId];
            looks = sanitize(ch?.description || '').slice(0, 60);
        } catch { /* ignore */ }
    }
    if (!looks) return '';

    const parts = [looks];
    if (p.outfit) parts.push(sanitize(p.outfit));
    if (st.location) parts.push(sanitize(st.location));
    const light = lightFromTime(st.time);
    if (light) parts.push(light);
    parts.push('写实摄影，浅景深');

    return clamp(parts.filter(Boolean).join('，'), state.maxChars);
}

/* ---------------- 输出 ---------------- */

async function echo(text) {
    try {
        await SillyTavern.getContext().executeSlashCommandsWithOptions(`/echo ${sanitize(text)}`);
    } catch (e) {
        console.warn('[bbs-img] echo 失败', e);
    }
}

async function generate({ preview = false } = {}) {
    const snap = getSnapshot();
    const prompt = buildPrompt(snap);

    if (!prompt) {
        state.skipped++;
        const why = !getApi() ? '柏宝书没加载' : '柏宝书还没有主角外貌数据（要先跑一楼摘要）';
        console.warn('[bbs-img] 跳过：' + why);
        if (preview) await echo(`[bbs-img] 跳过：${why}`);
        return { ok: false, reason: why };
    }

    if (preview) {
        await echo(`[bbs-img] ${prompt.length} 字：${prompt}`);
        return { ok: true, preview: true, prompt };
    }

    if (prompt === state.lastPrompt && snap?.revision === state.lastRevision) {
        state.skipped++;
        return { ok: false, reason: 'duplicate' };
    }

    if (state.busy) return { ok: false, reason: 'busy' };

    state.busy = true;
    state.lastPrompt = prompt;
    state.lastRevision = snap?.revision ?? -1;
    try {
        console.log('[bbs-img] 出图', prompt.length + ' 字', prompt);
        await SillyTavern.getContext().executeSlashCommandsWithOptions(`/sd extend=false ${prompt}`);
        state.fired++;
        return { ok: true, prompt };
    } catch (e) {
        console.warn('[bbs-img] 出图失败', e);
        return { ok: false, reason: String(e) };
    } finally {
        state.busy = false;
    }
}

/* ---------------- 注册 ---------------- */

function registerCommand() {
    const ctx = SillyTavern.getContext();
    const { SlashCommand, SlashCommandParser } = ctx;
    if (!SlashCommand || !SlashCommandParser) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'bbs-img',
        callback: async (_named, value) => {
            const arg = flatten(value || '').toLowerCase();
            if (arg === 'preview') { await generate({ preview: true }); return ''; }
            if (arg === 'on' || arg === 'off') {
                state.enabled = arg === 'on';
                localStorage.setItem(LS_ENABLED, String(state.enabled));
                await echo(`[bbs-img] 自动出图已${state.enabled ? '开启' : '关闭'}`);
                return '';
            }
            const mc = arg.match(/maxchars=(\d+)/);
            if (mc) {
                state.maxChars = Math.max(40, Math.min(400, Number(mc[1])));
                localStorage.setItem(LS_MAXCHARS, String(state.maxChars));
                await echo(`[bbs-img] 提示词上限 ${state.maxChars} 字`);
                return '';
            }
            const r = await generate();
            if (!r.ok && r.reason) await echo(`[bbs-img] ${r.reason}`);
            return '';
        },
        helpString: '柏宝书 → 生图。&lt;code&gt;/bbs-img&lt;/code&gt; 出图，&lt;code&gt;preview&lt;/code&gt; 只看提示词，&lt;code&gt;on|off&lt;/code&gt; 自动开关，&lt;code&gt;maxchars=120&lt;/code&gt;。',
        returns: 'string',
    }));

    ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
        if (!state.enabled) return;
        generate().catch(e => console.warn('[bbs-img]', e));
    });

    console.log('[bbs-img] 已加载，自动出图当前是' + (state.enabled ? '开启' : '关闭') + '，用 /bbs-img on 打开');
}

try {
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', registerCommand, { once: true });
        } else {
            registerCommand();
        }
    } else {
        console.warn('[bbs-img] 找不到 SillyTavern 上下文');
    }
} catch (e) {
    console.error('[bbs-img] 加载失败', e);
}
