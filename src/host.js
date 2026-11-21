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

/**
 * STscript 把裸 `|` 当命令分隔符，提示词里出现就会把后半段切成下一条命令。
 * 必须转义成 `\|`（parser 的 testSymbol 会吃掉反斜杠、只留字面竖线），
 * 不能换成别的字符 —— MOSS 的控制标签就是 <|center_frame|> 这种形式，
 * 换成 `，` 会变成 <，center_frame，>，模型读到的是根本不存在的标签。
 */
function escapePipes(s) {
    return String(s ?? '').replace(/\|/g, '\\|');
}

function sdCommand(res) {
    // STscript：/sd 只有一个非 split 的无名参数，parser 会把命令后所有字符原样收下
    // （见 SlashCommandParser.parseUnnamedArgument，split=false 分支），
    // 所以文本不用加引号 —— 加了引号反而会变成字面字符。
    // 宽高不传：交给酒馆 Image Generation 面板，避免扩展和工作流各写一套。
    return `/sd extend=false ${escapePipes(res.text)}`;
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

/* ---------------- 幽灵楼:不参与柏宝书记忆 ---------------- */

/*
 * 用户点消息菜单里的「幽灵」按钮把某楼移出 AI 上下文(ST 的 /hide → is_system=true)。
 * 柏宝书 1.3.5 仍会把这种楼当成真实 AI 回复摘进记忆,再以摘要形式注入回去 ——
 * 等于绕过用户的隐藏操作偷偷塞回上下文。
 *
 * 桥接不改柏宝书一行代码:走它公开认可的「番外」通道(extra.bbs_omit = 此楼对记忆引擎不存在),
 * 自动给幽灵楼补标记;楼恢复可见时撤回。你自己在楼内面板点掉过番外(标记还在、omit 没了)则视为
 * 你的决定,不再强加。
 */
const OMIT_BY = 'bbs-img-bridge';

function ensureExtra(m) {
    if (!m.extra || typeof m.extra !== 'object') m.extra = {};
    return m.extra;
}

/** 这楼摘过没有(只认物理存在的叶子) */
function hasLeaf(m) {
    const l = m?.extra?.bbs_leaf;
    return !!(l && l.id && l.delta);
}

/** 幽灵楼 = ST 隐藏(is_system) 且不是柏宝书隐藏的、不是原生系统楼、不是搬运锚点楼 */
function isGhostFloor(m) {
    if (!m || typeof m !== 'object') return false;
    const ex = m.extra || {};
    if (ex.type) return false;              // /sys、叙事注入等原生系统楼
    if (ex.bbs_hidden) return false;        // 柏宝书自己隐藏的旧楼(先摘后隐)
    if (ex.bbs_leaf && ex.bbs_leaf.seed) return false; // 带数据开新聊天时的锚点楼
    return m.is_system === true;
}

/**
 * 被柏宝书「盖过章」的幽灵楼(2.1.0 的坑):
 * 柏宝书的 syncWindowHiddenState 会给窗口外、已被覆盖、又还没打 bbs_hidden 的楼补写 bbs_hidden
 * (它不区分是自己藏的、还是用户藏的)。一旦被补写,这楼就不再满足 isGhostFloor,标记被撤回 →
 * 柏宝书把它当「自家的隐藏旧楼」重新排队摘要 → 楼内面板显示「待摘要」。
 *
 * 判据:隐藏 + 有 bbs_hidden + 从没摘过(无叶子) + 非用户楼 + 无 extra.type / 种子叶子。
 * 柏宝书只会隐藏「已被摘要覆盖」的楼,所以「它盖了章却从来没有叶子」基本只可能是被误盖的那种。
 */
function isOrphanGhost(m) {
    if (!m || typeof m !== 'object' || m.is_user) return false;
    const ex = m.extra || {};
    if (ex.type) return false;
    if (!ex.bbs_hidden) return false;
    if (ex.bbs_leaf && ex.bbs_leaf.seed) return false;
    if (hasLeaf(m)) return false;           // 有摘录 → 柏宝书正常隐藏的旧楼,别碰
    return m.is_system === true;
}

/**
 * 同步一遍。就地改 chat[].extra,返回 { marked, restored, healed }。
 * 纯逻辑、无 IO,方便单测。
 *
 * 状态以**自己的标记**(bbs_omit_by)为准,不看 bbs_hidden —— 因为柏宝书随时可能给同一楼补写
 * bbs_hidden,用 bbs_hidden 反推会把标记撤掉(这就是 2.1.0 的 bug)。
 */
function sweepGhostFloors(chat) {
    let marked = 0;
    let restored = 0;
    let healed = 0;
    if (!Array.isArray(chat)) return { marked, restored, healed };

    for (const m of chat) {
        if (!m || typeof m !== 'object') continue;
        const ex = m.extra || {};
        const hidden = m.is_system === true;
        const mine = ex.bbs_omit_by === OMIT_BY;

        if (mine) {
            if (hidden) {
                if (ex.bbs_omit === true) continue;  // 已在排除状态,保持
                // 番外被取消(你点掉了按钮)→ 交还控制权,不再强加
                delete ex.bbs_omit_by;
                continue;
            }
            // 楼恢复可见 → 撤回标记,记忆照旧恢复
            delete ex.bbs_omit;
            delete ex.bbs_omit_by;
            restored++;
            continue;
        }

        if (!hidden) continue;
        if (ex.bbs_omit === true) continue; // 已经是番外(你自己标的),不接管、不改来源

        if (isGhostFloor(m)) {
            const e = ensureExtra(m);
            e.bbs_omit = true;
            e.bbs_omit_by = OMIT_BY;
            marked++;
        } else if (isOrphanGhost(m)) {
            const e = ensureExtra(m);
            e.bbs_omit = true;
            e.bbs_omit_by = OMIT_BY;
            healed++;
        }
    }
    return { marked, restored, healed };
}

/** 扫当前聊天并落盘。没有变化就什么都不做(不空写 chat 文件)。 */
function runGhostSweep(reason) {
    const ctx = ctxOrNull();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return { marked: 0, restored: 0, healed: 0 };

    const r = sweepGhostFloors(chat);
    if (!r.marked && !r.restored && !r.healed) return r;

    console.log(`[bbs-img] 幽灵楼同步(${reason}):标记 ${r.marked},撤回 ${r.restored},修复 ${r.healed}`);
    try { ctx.saveChat?.(); } catch (e) { console.warn('[bbs-img] 保存聊天失败', e); }
    return r;
}

let ghostTimer = null;
/** 合并短时间内的多次触发(点一下幽灵按钮会连带好几个 ST 事件)。 */
function scheduleGhostSweep(reason) {
    if (ghostTimer) return;
    ghostTimer = setTimeout(() => {
        ghostTimer = null;
        try { runGhostSweep(reason); } catch (e) { console.warn('[bbs-img] 幽灵楼同步失败', e); }
    }, 300);
}

function bindGhostSweep() {
    const ctx = ctxOrNull();
    runGhostSweep('启动'); // 历史遗留的幽灵楼立刻处理

    try {
        const es = ctx?.eventSource;
        const et = ctx?.eventTypes || {};
        for (const name of ['CHAT_CHANGED', 'CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_SWIPED']) {
            if (et[name]) es.on(et[name], () => scheduleGhostSweep(name));
        }
    } catch (e) {
        console.warn('[bbs-img] 幽灵楼事件订阅失败', e);
    }

    // 幽灵按钮就在消息菜单里:聊天区内任何点击后补扫一次(比轮询省)。
    if (typeof document !== 'undefined' && document.addEventListener) {
        document.addEventListener('click', ev => {
            const t = ev?.target;
            if (t && typeof t.closest === 'function' && t.closest('#chat .mes')) scheduleGhostSweep('click');
        }, true);
    }
}

/* ---------------- 输出 ---------------- */

function safeEcho(s) {
    // 回显里不能留裸 `|`（同样会切断命令），换成全角 `｜`：看起来一样，解析器不认。
    return String(s ?? '').replace(/\|/g, '｜').replace(/\{\{/g, '{ {').replace(/[\r\n]+/g, ' ').slice(0, 4000);
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

async function doGhostReport() {
    const ctx = ctxOrNull();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) { await echo('[bbs-img] 拿不到聊天'); return; }

    const r = runGhostSweep('手动');
    let hidden = 0;
    let excluded = 0;
    for (const m of chat) {
        if (!m || m.is_system !== true) continue;
        if (!(isGhostFloor(m) || isOrphanGhost(m) || m.extra?.bbs_omit_by === OMIT_BY)) continue;
        hidden++;
        if (m.extra?.bbs_omit === true) excluded++;
    }
    await echo(`[bbs-img] 幽灵楼 ${hidden} 个,已排除出记忆 ${excluded} 个;本次新标 ${r.marked}、修复 ${r.healed}、撤回 ${r.restored}`);
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
            const SUB = /^(preview\+?|full|raw|rawcmd|ghosts|on|off|reset)$/i;
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
            if (low === 'ghosts') { await doGhostReport(); return ''; }
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
        helpString: '/bbs-img 出图 · preview 看镜头来源 · preview+ 看完整提示词 · raw 看快照 · rawcmd 看提交命令 · ghosts 看幽灵楼是否已排除 · on/off 自动出图 · style=xxx 画风前缀（auto 清空） · reset 清去重',
    }));

    try {
        ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED, () => {
            if (!st.enabled) return;
            doGenerate().catch(e => console.warn('[bbs-img]', e));
        });
    } catch (e) {
        console.warn('[bbs-img] 事件订阅失败', e);
    }

    // 幽灵楼(用户自己 /hide 的楼)自动标番外,不让柏宝书把它们摘进记忆。
    try {
        bindGhostSweep();
    } catch (e) {
        console.warn('[bbs-img] 幽灵楼同步初始化失败', e);
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
