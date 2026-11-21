/**
 * bbs-scene —— 柏宝书快照 → 一段提示词
 *
 * v2.0 只做两件事：
 *   1. 有「画面镜头」（vars.situation / sceneFocus.situation）→ **原文直通**，一个字不改；
 *   2. 没有 → 用场景 desc + 在场人物的外貌/服装/状态拼一句最小兜底。
 *
 * 不再做的事（v1.x 的装配层，2026-11-21 删除）：
 *   bbox 布局、朝向推断、交互动词→构图三档、时间→光线词表、画风媒介头替换、
 *   标点归一化、按句读截断、画风自检正则、第一人称自动判定。
 *   理由：镜头由 LLM 写出来之后，这些规则全都在 full 分支里被跳过，属于不再生效的分支。
 */

/** 画面镜头可能待的变量名，按优先级 */
const SHOT_KEYS = ['situation', '画面', '镜头', 'shot', 'visual'];
/** 镜头对象里这些键是元数据，不是画面内容 */
const SHOT_SKIP = /^(updatedAt|updated|ts|time|createdAt|created|rev|revision|_)/i;

/** 压平成一行：换行 → 逗号，多余空白收掉。不做标点归一化。 */
function flatten(s) {
    return String(s ?? '').replace(/[\r\n]+/g, '，').replace(/[ \t\u00a0\u3000]+/g, ' ').trim();
}

function hasCJK(s) {
    return /[\u4e00-\u9fff]/.test(String(s ?? ''));
}

/** 把任意形态的镜头值铺平成文本：字符串原样、对象逐字段、数组逐项 */
function shotText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(shotText).filter(Boolean).join('，');
    if (typeof v === 'object') {
        const out = [];
        for (const [k, val] of Object.entries(v)) {
            if (SHOT_SKIP.test(k)) continue;
            const t = shotText(val);
            if (t) out.push(t);
        }
        return out.join('，');
    }
    return '';
}

/**
 * 取画面镜头。认 vars.situation / vars.画面 / vars.镜头 / vars.shot / vars.visual，
 * 值可以是字符串、对象（多字段合并）、数组。
 * @returns {{text:string, from:string, fields:number}}
 */
export function pickShot(vars) {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return { text: '', from: '', fields: 0 };
    for (const k of SHOT_KEYS) {
        const v = vars[k];
        const t = shotText(v);
        if (!t) continue;
        const fields = v && typeof v === 'object' && !Array.isArray(v)
            ? Object.keys(v).filter(x => !SHOT_SKIP.test(x)).length
            : 0;
        return { text: t, from: `vars.${k}`, fields };
    }
    return { text: '', from: '', fields: 0 };
}

/** 场景：locationPath 从细到粗取第一个有 desc 的 */
function sceneText(snap) {
    const st = snap?.state || {};
    const scenes = snap?.scenes || [];
    const path = Array.isArray(st.locationPath) ? st.locationPath : [];
    for (let i = path.length - 1; i >= 0; i--) {
        const node = scenes.find(s => s?.name === path[i] && s?.desc);
        if (node) return { text: flatten(node.desc), from: `scenes.${path[i]}.desc` };
    }
    if (path.length) return { text: flatten(path[path.length - 1]), from: 'locationPath' };
    if (st.location) return { text: flatten(st.location), from: 'state.location' };
    const any = scenes.find(s => s?.desc);
    return any ? { text: flatten(any.desc), from: `scenes.${any.name}.desc` } : { text: '', from: '无' };
}

/** 在场人物：局势卡的 participants，空则取名册里 important / follow 的 */
function activeNames(snap) {
    const sf = snap?.state?.sceneFocus || {};
    const names = Array.isArray(sf.participants) ? sf.participants.map(flatten).filter(Boolean) : [];
    if (names.length) return { names, from: 'sceneFocus.participants' };
    const npcs = (snap?.npcs || []).filter(n => n?.important || n?.follow).map(n => n.name).filter(Boolean);
    return { names: npcs, from: npcs.length ? 'npcs(important/follow)' : '无' };
}

/** 人物档案：名册 npc → 角色卡 → 主角人设 */
function profile(name, snap, cards = {}) {
    const key = String(name ?? '').trim();
    const hit = (snap?.npcs || []).find(n => n?.name && n.name === key);
    const p = snap?.protagonist || {};
    if (hit) {
        return {
            name: hit.name,
            looks: flatten(hit.desc || cards[hit.name] || ''),
            outfit: flatten(hit.outfit || ''),
            condition: flatten(hit.condition || ''),
            src: hit.desc ? 'npc.desc' : (cards[hit.name] ? '角色卡' : '无'),
        };
    }
    return {
        name: key,
        looks: flatten(p.appearance || cards[key] || cards.__user__ || ''),
        outfit: flatten(p.outfit || ''),
        condition: flatten(p.condition || ''),
        src: p.appearance ? 'protagonist.appearance' : ((cards[key] || cards.__user__) ? '角色卡/人设' : '无'),
    };
}

/**
 * @param {object} o
 * @param {object} o.snapshot  柏宝书 getSnapshot()
 * @param {object} [o.cards]   { 人名: 角色卡描述 }
 * @param {string} [o.style]   画风前缀，空字符串 = 不加
 * @returns {{mode:string, text:string, people:object[], report:string[]}}
 */
export function composeScene(o = {}) {
    const snap = o.snapshot || {};
    const cards = o.cards || {};
    const style = String(o.style ?? '').trim();
    const report = [];

    // 1) 画面镜头 → 原文直通
    const shot = pickShot(snap.vars);
    const builtin = flatten(snap.state?.sceneFocus?.situation || '');
    const situation = flatten(shot.text) || builtin;
    if (situation) {
        const from = shot.text ? `自定义变量 ${shot.from.replace(/^vars\./, '')}` : 'sceneFocus.situation';
        report.push(`镜头: ${from}${shot.fields ? `（${shot.fields} 个字段）` : ''}，${situation.length} 字，原文直通`);
        const text = style ? `${style}${hasCJK(situation) ? '，' : ', '}${situation}` : situation;
        if (style) report.push(`画风: 前置《${style}》`);
        return { mode: 'shot', text, people: [], report };
    }

    // 2) 兜底：场景 + 在场人物
    const { names, from: namesFrom } = activeNames(snap);
    if (!names.length) {
        report.push('没有画面镜头（vars.situation / sceneFocus.situation 都是空的），也没有在场人物');
        return { mode: 'none', text: '', people: [], report };
    }

    const scene = sceneText(snap);
    report.push(`场景: ${scene.from || '无'}`);
    report.push(`人物: ${names.join('/')}（${namesFrom}）`);

    const people = names.map(n => profile(n, snap, cards));
    report.push(`外貌来源: ${people.map(p => `${p.name || '主角'}=${p.src}`).join(' / ')}`);

    const body = [
        scene.text,
        ...people.flatMap(p => [p.looks, p.outfit, p.condition].filter(Boolean)),
    ].filter(Boolean).join('，');

    if (!body) {
        report.push('兜底拼不出内容：场景描述和人物档案都是空的');
        return { mode: 'none', text: '', people, report };
    }

    const text = style ? `${style}${hasCJK(body) ? '，' : ', '}${body}` : body;
    if (style) report.push(`画风: 前置《${style}》`);
    report.push('没有画面镜头，走兜底（场景+人物档案，不猜光线/构图/朝向）');
    return { mode: 'fallback', text, people, report };
}
