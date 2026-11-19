/**
 * 柏宝书生图桥接 —— 独立酒馆扩展（不依赖酒馆助手）
 *
 *   /bbs-img            立刻出一次图
 *   /bbs-img preview    只看拼出来的提示词 + 各个字段的来源
 *   /bbs-img raw        倾倒柏宝书快照（排查用）
 *   /bbs-img on / off   自动出图开关
 *   /bbs-img maxchars=100
 *
 * v0.2.0 修正：外观以「角色卡」为主源，柏宝书只补动态状态。
 *   柏宝书的 protagonist.appearance 是「剧情里明确写过外貌变化才记录」，
 *   多数聊天里它就是空的 —— 空的不是故障。
 */

const LS_ENABLED = 'bbs_img_enabled';
const LS_MAXCHARS = 'bbs_img_maxchars';
const DEFAULT_MAX = 120;

const LOOKS_KEYWORDS = /外貌|长相|容貌|五官|发型|发色|头发|短发|长发|卷发|刘海|呆毛|眼睛|瞳|眼神|眉|唇|鼻|脸|下巴|皮肤|肤|身材|身高|体型|腰|腿|手臂|手腕|纹身|疤|痣|眼镜|穿着|打扮|服饰|appearance|looks|hair|eyes|skin|face|body/i;

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

/** 清掉会破坏 STscript 解析的字符（管道 / 命令起始 / 宏花括号） */
function sanitize(s) {
    return flatten(s)
        .replace(/[|｜]/g, '，')
        .replace(/\{\{/g, '{ {')
        .replace(/^\/+/, '');
}

/** echo 专用：保留花括号内容，只压行和去管道 */
function echoSafe(s) {
    return flatten(s).replace(/[|｜]/g, '，').replace(/\{\{/g, '{ {').replace(/^\/+/, '').slice(0, 1500);
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

/* ---------------- 角色卡 ---------------- */

/** 取当前角色（含群聊：退回到最后一条 AI 消息的角色） */
function getCard() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.characterId !== undefined && ctx.characterId !== null) {
            const ch = ctx.characters?.[ctx.characterId];
            if (ch) return ch;
        }
        const chat = ctx.chat || [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const item = chat[i];
            if (!item?.is_user && item?.original_avatar) {
                const ch = (ctx.characters || []).find(c => c.avatar === item.original_avatar);
                if (ch) return ch;
            }
        }
    } catch (e) {
        console.warn('[bbs-img] 取角色卡失败', e);
    }
    return null;
}

/** 从角色卡 description 里抠出「像外貌」的那几句，抠不到就取开头 */
function looksFromCard(desc) {
    const t = flatten(String(desc || '').replace(/\{\{char\}\}/gi, ''));
    if (!t) return '';
    const segs = t.split(/[。；;，,\n]/).map(x => x.trim()).filter(x => x.length >= 3);
    if (!segs.length) return t.slice(0, 60);

    // 按原顺序取带外貌关键词的句子，最多 3 句 / 80 字
    const picked = [];
    let len = 0;
    for (const seg of segs) {
        if (!LOOKS_KEYWORDS.test(seg)) continue;
        if (len + seg.length > 80) break;
        picked.push(seg);
        len += seg.length;
        if (picked.length >= 3) break;
    }
    if (picked.length) return picked.join('，');
    return t.slice(0, 60);
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

/**
 * 组装提示词，同时返回每个字段的来源，便于排查
 */
function compose(snap) {
    const report = [];
    const parts = [];
    let looksFrom = '无';

    const p = snap?.protagonist || {};
    const st = snap?.state || {};

    // 1) 外观：角色卡优先，柏宝书补
    let looks = '';
    const card = getCard();
    const cardLooks = looksFromCard(card?.description);
    if (cardLooks) {
        looks = cardLooks;
        looksFrom = `角色卡(${cardLooks.length}字)`;
    } else if (p.appearance) {
        looks = sanitize(p.appearance);
        looksFrom = '柏宝书';
    }

    if (looks) parts.push(clamp(looks, 80));
    report.push(`外观: ${looksFrom}`);

    // 2) 动态状态
    if (p.outfit) { parts.push(sanitize(p.outfit)); report.push('服装: 柏宝书'); }
    else report.push('服装: 无');

    if (st.location) { parts.push(sanitize(st.location)); report.push('地点: 柏宝书'); }
    else report.push('地点: 无');

    const light = lightFromTime(st.time);
    if (light) { parts.push(light); report.push('光线: ' + st.time); }
    else report.push('光线: 无');

    if (looks) parts.push('写实摄影，浅景深');

    return {
        prompt: (parts.length && looks) ? clamp(parts.join('，'), state.maxChars) : '',
        report,
        looksFrom,
    };
}

/* ---------------- 输出 ---------------- */

async function echo(text) {
    try {
        await SillyTavern.getContext().executeSlashCommandsWithOptions(`/echo ${echoSafe(text)}`);
    } catch (e) {
        console.warn('[bbs-img] echo 失败', e);
    }
}

async function doPreview() {
    const snap = getSnapshot();
    if (!getApi()) { await echo('[bbs-img] 柏宝书没加载'); return; }
    if (!snap) { await echo('[bbs-img] 拿不到快照'); return; }

    const { prompt, report, looksFrom } = compose(snap);

    await echo(`[bbs-img] revision=${snap.revision} 聊天楼层=${snap.chat?.length ?? '?'}`);
    await echo('[bbs-img] ' + report.join(' | '));

    if (!prompt) {
        await echo('[bbs-img] 组不出提示词：外观来源是「无」。角色卡 description 里没找到外貌描述，柏宝书 protagonist.appearance 也是空的（该字段只在剧情明确写到外貌变化时才记录，空是正常的）。');
        await echo('[bbs-img] 建议：在角色卡 description 里补一句外貌，例如「黑色短发，琥珀色眼睛，浅色皮肤，偏高瘦」。');
        return;
    }

    await echo(`[bbs-img] ${prompt.length} 字（外观来自${looksFrom}）：`);
    await echo(prompt);
}

async function doRaw() {
    const snap = getSnapshot();
    if (!snap) { await echo('[bbs-img] 拿不到快照'); return; }
    const slim = {
        revision: snap.revision,
        chat: snap.chat,
        protagonist: snap.protagonist,
        state: snap.state,
        npcs: (snap.npcs || []).slice(0, 3),
    };
    await echo('[bbs-img] ' + JSON.stringify(slim));
}

async function generate() {
    const snap = getSnapshot();
    if (!snap) return { ok: false, reason: '柏宝书没加载或没有快照' };

    const { prompt } = compose(snap);
    if (!prompt) {
        state.skipped++;
        return { ok: false, reason: '组不出提示词（没有外观来源），用 /bbs-img preview 看详情' };
    }

    if (prompt === state.lastPrompt && snap.revision === state.lastRevision) {
        state.skipped++;
        return { ok: false, reason: 'duplicate' };
    }
    if (state.busy) return { ok: false, reason: '上一张还没出完' };

    state.busy = true;
    state.lastPrompt = prompt;
    state.lastRevision = snap.revision;
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

            if (arg === 'preview') { await doPreview(); return ''; }
            if (arg === 'raw') { await doRaw(); return ''; }

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
            if (!r.ok && r.reason && r.reason !== 'duplicate') await echo(`[bbs-img] ${r.reason}`);
            return '';
        },
        helpString: '/bbs-img 出图 · preview 看提示词 · raw 看快照 · on|off 自动开关 · maxchars=120',
        returns: 'string',
    }));

    ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
        if (!state.enabled) return;
        generate().catch(e => console.warn('[bbs-img]', e));
    });

    console.log('[bbs-img] 已加载，自动出图' + (state.enabled ? '开启' : '关闭'));
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
