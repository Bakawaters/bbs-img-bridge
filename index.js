/**
 * 柏宝书 · 场景生图桥接 v1.4.9
 * https://github.com/Bakawaters/bbs-img-bridge
 *
 * 本文件由 src/scene.js + src/host.js 自动拼装，勿手改。
 *   /bbs-img            按柏宝书当前场景出图
 *   /bbs-img preview    看每个字段的来源
 *   /bbs-img preview+   看完整提示词 / 提交命令
 *   /bbs-img raw        倾倒快照（排查）
 *   /bbs-img on|off     收到 AI 消息自动出图
 *   /bbs-img style=xxx  改画风后缀
 *   /bbs-img people=3   最多画几个人
 *   /bbs-img size=1248x832  多人图尺寸
 *   /bbs-img reset      清去重
 */
(function () {
'use strict';
const VERSION = '1.4.9';

/**
 * bbs-scene —— 柏宝书快照 → MOSS 生图提示词/布局
 *
 * 纯函数，不碰 DOM / SillyTavern，便于用 node 桩测试。
 *
 * 设计依据（本机实测，1024×1024 / 1248×832，MOSS-SFT int8 + dmd8 LoRA，8 步 CFG1.0 er_sde）：
 *  1. MOSS 的文本编码器是 Qwen3.5-9B 语言模型，prompt 原样进 user turn；
 *     官方 layout 提示词就是一段 JSON 文本，直接用 CLIPTextEncode 喂即可，
 *     不需要 CreateBoundingBoxes 节点（省掉手工拉框）。
 *  2. 双人写成一句话（"左边 A 抱住右边 B"）时，两张脸挤在画面中线（cx 402 / 583），
 *     模型分不清主体；给每个角色一个 bbox 后，两人稳定落到各自半区（cx 271 / 746）。
 *  3. 把交互动作写进各自的 item.caption 会多长出一张脸（实测 2 人 → 3 张脸）；
 *     交互只写在 summary.caption，item.caption 只写这个角色本人的外观+朝向。
 *  4. 交互姿态要求 bbox 相邻或轻微重叠：重叠 180px 时两张脸间距 ≈ 1 个脸宽（贴身），
 *     完全不重叠时模型会把人拉到画面两侧，看起来像并排站着没接触。
 */

/**
 * 兜底画风。MOSS 不给画风词时会掉进「3D 渲染」——皮肤过度平滑、头发像塑料、
 * 眼神是贴图。所以空白默认不是"中性"，是"最差"。三选一实测见文档第 11 节。
 */
const STYLE_DEFAULT = '写实摄影，浅景深';
// 各段的「参考字数」（仅在 detail>0 时作为截断基准被乘）。
// detail 不设 = 0 = 完全不截断，原文有多少字进多少字；想要收窄才自己给倍数。
const SEG_DEFAULT = { looks: 70, outfit: 30, condition: 24, scene: 70, item: 90 };
const segCap = (n, k = 0) => {
    const m = Number(k);
    if (!(m > 0)) return Infinity;           // 默认：不截断
    return Math.max(8, Math.round(n * m));
};

/* ---------------- 通用清洗 ---------------- */

function flatten(s) {
    return String(s ?? '').replace(/[\r\n]+/g, '，').replace(/\s+/g, ' ').trim();
}

/**
 * 标点归一化 —— 只在「中文为主」的文本上做。
 *
 * 柏宝书的 location / scene.desc / npc.desc 里经常混着半角逗号（"转角处,绿化带深处…"），
 * v1.4.0 之前这些字符会原样进 caption。语义上模型能懂，但会带来三个实际麻烦：
 *   1. 中英标点混排，同一句里出现「，」和「,」两种分隔，Qwen 分词后是两类 token，白白占注意力；
 *   2. 半角逗号后面常跟空格，中文串里夹空格会被切成额外 token；
 *   3. 拼接时前一段以「。」结尾、后一段用「，」连，产生「。，」这种双标点。
 * 英文为主的 caption（比如 ST 的 Prompt Prefix）不碰，否则会把 ", " 变成全角，破坏英文格式。
 */
function normalizePunct(s) {
    const raw = String(s ?? '').replace(/[\u200b-\u200f\ufeff]/g, '');
    const compact = raw.replace(/\s/g, '');
    if (!compact) return '';
    const cjk = (raw.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk < compact.length * 0.35) {
        // 英文为主：只压多余空白，标点原样
        return raw.replace(/[ \t\u00a0]{2,}/g, ' ').replace(/[\r\n]+/g, ' ').trim();
    }
    return raw
        .replace(/[ \t\u00a0\u3000]+/g, '')                 // 中文串里不留空格
        .replace(/,/g, '，').replace(/;/g, '；').replace(/:/g, '：')
        .replace(/!/g, '！').replace(/\?/g, '？')
        .replace(/。/g, '，')                                // caption 是一段逗号串联的话，句号统一成逗号
        .replace(/[，、；：]{2,}/g, m => m[0])               // 「，，」「，、」只留一个
        .replace(/[（(]\s*[）)]/g, '')                        // 空括号
        .replace(/^[，、；：]+|[，、；：]+$/g, '')
        .trim();
}

/**
 * situation 已经是完整 caption 时，画风只能追加在后缀 —— 前置会破坏「媒介 + 主体」开头。
 * caption 里已经出现过的画风段就不再重复。
 */
function styleTail(situation, style) {
    const seg = String(style || '').split(/[，,]/).map(x => x.trim()).filter(Boolean);
    if (!seg.length) return '';
    const [first, ...others] = seg;
    const use = String(situation || '').includes(first) ? others : seg;
    if (!use.length) return '';
    const sep = isCJKText(situation) ? '，' : ', ';
    return sep + use.join(sep);
}

/** 中文为主的文本（≥35% 汉字）—— 用来决定要不要往里面掺中文行为词 */
function isCJKText(s) {
    const str = String(s ?? '');
    const compact = str.replace(/\s/g, '');
    if (!compact) return false;
    return (str.match(/[\u4e00-\u9fff]/g) || []).length >= compact.length * 0.35;
}

/** item.caption 禁止出现指代别人的短语，否则模型会多画一个人 */
function selfOnly(s) {
    return flatten(s)
        .replace(/(旁边|身边|对面|前面|后面|另一个|另一位|对方|她|他)的/g, '')
        .replace(/(抱住|搂住|抱住|牵住|扶住|按住|靠住)(旁边|身边)?(女性|男性|女孩|男孩|人)?的?(腰|肩|手|头|脸|手臂)/g, (m, v, _a, _b, part) => `${v}${part}`)
        .trim();
}

/**
 * 按句读截断：宁可短一截，也不要留半句话。
 * 模型拿到「…性器在大衣」这种断句会自己往下脑补，比不写更糟。
 */
function sentenceClamp(s, n) {
    s = flatten(s).replace(/[。．]+$/g, '');
    if (s.length <= n) return normalizePunct(s);
    const cut = s.slice(0, n);
    const at = Math.max(
        cut.lastIndexOf('，'), cut.lastIndexOf('。'),
        cut.lastIndexOf('；'), cut.lastIndexOf('、'),
        cut.lastIndexOf(','), cut.lastIndexOf('.'),
    );
    return normalizePunct((at > n * 0.4 ? cut.slice(0, at) : cut).replace(/[，,、；;.]$/, ''));
}

/* ---------------- 时间 → 光线 ---------------- */

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
    if (/清晨|早晨|黎明|拂晓/.test(t)) return '清晨柔和侧光';
    if (/正午|中午|晌午/.test(t)) return '正午顶光';
    if (/黄昏|傍晚|日落|夕阳/.test(t)) return '黄昏逆光';
    if (/深夜|午夜|凌晨/.test(t)) return '夜晚冷光低照度';
    if (/夜|晚/.test(t)) return '夜晚暖色灯光';
    if (/下午|午后/.test(t)) return '午后暖光';
    if (/上午|早上/.test(t)) return '上午自然光';
    return '';
}

/* ---------------- 交互动词 → 构图 ---------------- */

/** 身体接触 / 贴身类：bbox 必须相邻或轻微重叠 */
const CLOSE_WORDS = /抱|搂|拥|亲|吻|依偎|倚|靠(在|着)|贴(着|近|住)|紧贴|牵(着|手)|握(着|住)|扶(着|住)|搭(在|着)|揽|环(住|绕|抱)|攀|挂在|背(着|起)|抱起|坐在.*(腿|怀)|枕|膝|贴面|贴耳|蹭|蹭着|抚摸|摩挲|相连|连在一起|没有分开|黏|粘/;
/** 并排 / 同行类 */
const SIDE_WORDS = /并排|并肩|一起走|同行|并肩|一齐|一同|走在|站着|坐在一旁|挨着/;
/** 对峙 / 分离类 */
const APART_WORDS = /相距|隔着|分开|对立|对峙|疏远|远处|另一头/;

function pickInteraction(situation) {
    const s = String(situation ?? '');
    if (CLOSE_WORDS.test(s)) return 'close';
    if (APART_WORDS.test(s)) return 'apart';
    if (SIDE_WORDS.test(s)) return 'side';
    return 'neutral';
}

/**
 * 「A 从背后抱住 B」这类动作，只有一人背对镜头才成立。
 * 返回 { [人名]: 朝向词 }，识别不出就返回空对象（不写朝向，交给 bbox）。
 */
function facingFromSituation(situation, people) {
    const s = String(situation ?? '');
    const m = s.match(/(?:从背后|从后面|自背后|从身后|在身后)/);
    if (!m) return {};

    const before = s.slice(0, m.index).replace(/[，,、]/g, '');
    let actor = null;
    // 取关键词前「最后出现的」参与者，通常是施动者
    for (const p of people) {
        if (!p.name) continue;
        const at = before.lastIndexOf(p.name);
        if (at >= 0 && (!actor || at > actor.at)) actor = { p, at };
    }
    if (!actor) return {};
    const target = people.find(p => p !== actor.p);
    const out = {};
    out[actor.p.name || '#0'] = '背对镜头，侧身';
    if (target) out[target.name || '#1'] = '面向镜头';
    return out;
}

/* ---------------- 构图模板 ---------------- */
/**
 * 返回 [{x0,y0,x1,y1}]，单位：画面像素/2（abs_centralized 坐标）。
 * 纵向统一留 4% 上下边距。
 */
function layoutFor(count, kind) {
    const top = -1, bottom = 1;   // 归一化后乘半宽/半高
    if (count <= 1) {
        return [{ x0: -0.82, y0: -0.94, x1: 0.82, y1: 1.0 }];
    }
    if (count === 2) {
        if (kind === 'close') {
            // 各占 62% 宽，中间重叠 ~15%（贴身/拥抱）
            return [
                { x0: -0.98, y0: -0.94, x1: 0.28, y1: 1.0 },
                { x0: -0.28, y0: -0.94, x1: 0.98, y1: 1.0 },
            ];
        }
        if (kind === 'apart') {
            return [
                { x0: -0.98, y0: -0.94, x1: -0.08, y1: 1.0 },
                { x0: 0.08, y0: -0.94, x1: 0.98, y1: 1.0 },
            ];
        }
        // side / neutral：各半，留 2% 缝
        return [
            { x0: -0.98, y0: -0.94, x1: -0.02, y1: 1.0 },
            { x0: 0.02, y0: -0.94, x1: 0.98, y1: 1.0 },
        ];
    }
    // 3 人：左中右，中间略大
    return [
        { x0: -0.98, y0: -0.94, x1: -0.26, y1: 1.0 },
        { x0: -0.34, y0: -0.94, x1: 0.34, y1: 1.0 },
        { x0: 0.26, y0: -0.94, x1: 0.98, y1: 1.0 },
    ];
}

function toBBox(b, w, h) {
    const hw = w / 2, hh = h / 2;
    return [
        Math.round(b.y0 * hh), Math.round(b.x0 * hw),
        Math.round(b.y1 * hh), Math.round(b.x1 * hw),
    ];
}

/* ---------------- 人物档案 ---------------- */

/** 柏宝书的 desc 经常以角色名开头，caption 里已经有名字了，去掉重复 */
function stripLeadingName(s, name) {
    let t = String(s || '').trim();
    const n = String(name || '').trim();
    if (!n) return t;
    for (let i = 0; i < 2; i++) {
        if (t.startsWith(n)) t = t.slice(n.length).replace(/^[，,、:：\s]+/, '');
    }
    return t;
}

/**
 * cards: { [name]: description }，由宿主从角色卡/人物设定里取
 * 返回 { name, looks, outfit, condition, src }
 */
function personProfile(name, snap, cards = {}, k = 0) {
    const key = String(name ?? '').trim();
    const npcs = snap?.npcs || [];
    const p = snap?.protagonist || {};
    const hit = npcs.find(n => n?.name && (n.name === key || key.includes(n.name) || n.name.includes(key)));

    if (hit) {
        return {
            name: hit.name,
            looks: sentenceClamp(stripLeadingName(hit.desc || cards[hit.name] || '', hit.name), segCap(SEG_DEFAULT.looks, k)),
            outfit: sentenceClamp(hit.outfit || '', segCap(SEG_DEFAULT.outfit, k)),
            condition: sentenceClamp(hit.condition || '', segCap(SEG_DEFAULT.condition, k)),
            src: hit.desc ? 'npc.desc' : (cards[hit.name] ? '角色卡' : '无'),
        };
    }

    // 没命中 NPC → 当主角
    const isUser = /^(我|你|user|主角|{{user}})$/i.test(key) || key === '';
    return {
        name: isUser ? '' : key,
        looks: sentenceClamp(stripLeadingName(p.appearance || cards[key] || cards['__user__'] || '', key), segCap(SEG_DEFAULT.looks, k)),
        outfit: sentenceClamp(p.outfit || '', segCap(SEG_DEFAULT.outfit, k)),
        condition: sentenceClamp(p.condition || '', segCap(SEG_DEFAULT.condition, k)),
        src: p.appearance ? 'protagonist.appearance' : (cards[key] || cards['__user__'] ? '角色卡/人设' : '无'),
    };
}

/* ---------------- 场景描述 ---------------- */

function sceneDesc(snap, k = 0) {
    const st = snap?.state || {};
    const scenes = snap?.scenes || [];
    const out = [];
    let from = '无';
    const cap = segCap(SEG_DEFAULT.scene, k);

    // locationPath 由粗到细，取最细一级有 desc 的
    const path = Array.isArray(st.locationPath) ? st.locationPath : [];
    if (path.length) {
        for (let i = path.length - 1; i >= 0; i--) {
            const node = scenes.find(s => s?.name === path[i] && s?.desc);
            if (node) { out.push(sentenceClamp(flatten(node.desc), cap)); from = `scenes.${path[i]}.desc`; break; }
        }
        if (!out.length && path.length) { out.push(flatten(path[path.length - 1])); from = 'locationPath'; }
    }
    if (!out.length && st.location) { out.push(sentenceClamp(flatten(st.location), cap)); from = 'state.location'; }
    if (!out.length) {
        const any = scenes.find(s => s?.desc);
        if (any) { out.push(sentenceClamp(flatten(any.desc), cap)); from = `scenes.${any.name}.desc`; }
    }

    return { text: sentenceClamp(out.join('，'), cap), from };
}

/* ---------------- 自定义变量里的「画面镜头」 ---------------- */

/**
 * 柏宝书的内置局势卡 sceneFocus 有「局面实质切换才更新」的门槛，
 * 很多楼它不会动。所以允许用户在自定义变量里放一个每楼都刷新的画面镜头，
 * 优先用它，没有才回退到 sceneFocus.situation。
 *
 * 认这几种写法：vars.situation = "…" / vars.画面 = "…" /
 * vars.situation = { text|value|desc|situation: "…" }
 */
const SHOT_KEYS = ['situation', '画面', '镜头', 'shot', 'visual'];
/** 镜头对象里这些键是元数据，不是画面内容 */
const SHOT_SKIP = /^(updatedAt|updated|ts|time|createdAt|created|rev|revision|_)/i;

/** 把任意形态的镜头值铺平成文本：字符串原样、对象逐字段、数组逐项 */
function shotValueText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(shotValueText).filter(Boolean).join('，');
    if (typeof v === 'object') {
        const out = [];
        for (const [k, val] of Object.entries(v)) {
            if (SHOT_SKIP.test(k)) continue;
            const t = shotValueText(val);
            if (t) out.push(t);
        }
        return out.join('，');
    }
    return '';
}

/**
 * 取「画面镜头」。
 *
 * v1.4.0：镜头是对象时**不再只取第一个命中子键**（原来只读 situation/text/value/desc），
 * 而是按字段顺序把所有字段拼成一段 —— 多字段镜头原来会静默丢掉其后全部内容，
 * 只剩下扩展自己从名册/场景/时间拼出来的东西，读起来就是「截断 + 拼凑」。
 *
 * 认这几种写法：
 *   vars.situation = "…"
 *   vars.situation = { 位置: "…", 动作: "…", 接触: "…" }   ← 全部合并
 *   vars.situation = ["…", "…"]
 */
function pickShot(vars) {
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return { text: '', from: '', fields: 0 };
    for (const k of SHOT_KEYS) {
        const v = vars[k];
        const t = shotValueText(v);
        if (!t) continue;
        const fields = v && typeof v === 'object' && !Array.isArray(v)
            ? Object.keys(v).filter(x => !SHOT_SKIP.test(x)).length
            : 0;
        return { text: t, from: `vars.${k}`, fields };
    }
    return { text: '', from: '', fields: 0 };
}

/* ---------------- 主函数 ---------------- */

/**
 * @param {object} o
 * @param {object} o.snapshot  柏宝书 getSnapshot()
 * @param {object} [o.cards]   { 人名: 角色卡描述 }
 * @param {string} [o.style]   画风后缀
 * @param {number} [o.maxPeople]
 * @param {number} [o.width]
 * @param {number} [o.height]
 * @returns {{mode:string,text:string,width:number,height:number,people:object[],report:string[]}}
 */
function composeScene(o = {}) {
    const snap = o.snapshot || {};
    const cards = o.cards || {};
    // style 为空字符串 = 调用方已决定不加画风词（比如 ST 的 Prompt Prefix 已经在管）
    const style = o.style === undefined ? STYLE_DEFAULT : String(o.style || '').trim();
    // 镜头字数上限：实测单句甜区 90–120 字（文档第十二节），默认 140。用户设多少就是多少，不压。
    const sumMaxBase = Math.max(60, Number(o.summaryMax) || 140);
    // 分段上限倍数：1 = 默认（外貌70/服装30/状态24/场景70/item90），不设上限
    // 分段截断倍数：0 / 不设 = 不截断（默认），>0 = 按 SEG_DEFAULT 乘
    const k = (() => {
        const m = Number(o.detail);
        return m > 0 ? m : 0;
    })();
    const maxPeople = Math.max(1, Math.min(3, o.maxPeople || 3));
    const report = [];
    const st = snap.state || {};
    const sf = st.sceneFocus || {};

    // 0) 局面：自定义变量 situation 优先，回退内置局势卡
    const shot = pickShot(snap.vars);
    const varShot = flatten(shot.text);
    const builtinShot = flatten(sf.situation || '');
    const situation = varShot || builtinShot;
    const situationFrom = varShot ? `自定义变量 ${shot.from.replace(/^vars\./, '')}` : (builtinShot ? 'sceneFocus.situation' : '');
    if (situationFrom) {
        const fld = shot.fields ? `${shot.fields} 个字段，` : '';
        report.push(`镜头: ${situationFrom}（${fld}原 ${shot.text.length || builtinShot.length} 字，原样使用）`);
    }

    // 镜头本身超上限时按内容放宽，否则六要素会被 sentenceClamp 砍掉后三条
    const sumMax = Math.max(sumMaxBase, situation.length + 60);
    if (k > 0) {
        report.push(`分段截断 ×${k}（外貌${segCap(SEG_DEFAULT.looks, k)} 服装${segCap(SEG_DEFAULT.outfit, k)} 状态${segCap(SEG_DEFAULT.condition, k)} 场景${segCap(SEG_DEFAULT.scene, k)} item${segCap(SEG_DEFAULT.item, k)}）`);
    } else {
        report.push('分段不截断（外貌/服装/状态/场景/item 原文全进，要收窄用 detail=0.5）');
    }

    // 1) 谁在场
    let names = Array.isArray(sf.participants) ? sf.participants.map(flatten).filter(Boolean) : [];
    if (!names.length) {
        // 局势卡没更新时，从画面镜头/局面的正文里反找名册中的人名
        const pool = `${situation} ${sceneDesc(snap, k).text}`;
        names = (snap.npcs || [])
            .filter(n => n?.name && pool.includes(n.name))
            .map(n => n.name);
        if (names.length) report.push('在场名单来自画面镜头里的人名');
    }
    if (!names.length) {
        const npcs = (snap.npcs || []).filter(n => n?.important || n?.follow);
        if (npcs.length) names = npcs.slice(0, maxPeople).map(n => n.name);
    }
    if (!names.length) {
        report.push('柏宝书里没有在场人物（sceneFocus.participants 为空，画面镜头里也没出现名册中的人）');
        return { mode: 'none', text: '', width: 1024, height: 1024, people: [], report };
    }
    if (names.length > maxPeople) {
        report.push(`在场 ${names.length} 人，只画前 ${maxPeople} 人`);
        names = names.slice(0, maxPeople);
    }
    report.push(`在场: ${names.filter(Boolean).join('/') || '主角'}`);

    let people = names.map(n => personProfile(n, snap, cards, k));

    /*
     * 视角：pov = 第一人称。
     * 酒馆正文本来就是「我」在看，第三人称全身构图常常和叙事对不上；
     * 固定 pov 后画面只画对方一人，bbox/朝向/多人交互全部不用赌。
     */
    const view = String(o.view || 'auto').toLowerCase();
    const povWanted = /^(pov|first|1st|第一人称)$/.test(view)
        || (view === 'auto' && /第一人称|POV|从我的视角|我的视角|主角视角/i.test(situation));
    let povMode = false;
    if (povWanted && people.length) {
        const userName = String(o.userName || snap.protagonist?.name || '').trim();
        const isMe = p => !p.name || (userName && p.name === userName) || /^(我|你|user|主角)$/i.test(p.name);
        const kept = people.filter(p => !isMe(p));
        if (kept.length) {
            if (kept.length < people.length) people = kept;
            povMode = true;
            report.push(`视角: 第一人称（画面里只有 ${people.map(p => p.name || '对方').join('/')}）`);
        }
    }

    // 2) 场景 / 光线 / 交互
    const scene = sceneDesc(snap, k);
    report.push(`场景: ${scene.from}`);
    const light = lightFromTime(st.time);
    report.push(`光线: ${st.time || '无'}`);
    report.push(`局面 ${situation.length} 字: ${situation ? situation.slice(0, 60) + (situation.length > 60 ? '…' : '') : '无'}`);
    const kind = pickInteraction(situation);
    report.push(`构图: ${people.length}人/${kind}`);

    // 3) 单人：自然语言，不用 JSON（更短更稳）
    const baseParts = [];
    if (scene.text) baseParts.push(scene.text);
    if (light) baseParts.push(light);

    if (people.length === 1) {
        const p = people[0];
        const bits = [p.looks, p.outfit, p.condition].filter(Boolean).map((x, i) =>
            i === 0 ? x : x);
        const head = (povMode && p.name ? [p.name, ...bits] : bits).filter(Boolean).join('，');
        // 官方 Prompt Enhancer 规则:开头必须是「媒介 + 主体」,不能以动作开头
        const [medium, ...rest] = String(style || '').split(/[，,]/).map(x => x.trim()).filter(Boolean);
        // POV 必须显式写清「镜头即主角眼睛」，否则模型会退回第三人称画两个全身
        const povClause = povMode && !/第一人称|POV/i.test(situation)
            ? '第一人称视角，镜头位于主角双眼高度，画面中只有对方，主角的手从画面下缘伸入前景'
            : '';
        const tail = [situation, ...rest].filter(Boolean).join('，');
        if (o.styleFrom) report.push(`画风: ${style || '不加'}（${o.styleFrom}）`);
        // 总长 = 各段可容纳之和；分段不截断时就是不限（Infinity → 原样全发）
        const totalCap = segCap(SEG_DEFAULT.looks, k) + segCap(SEG_DEFAULT.outfit, k) + segCap(SEG_DEFAULT.condition, k)
            + segCap(SEG_DEFAULT.scene, k) + sumMax
            + String(medium || '').length + String(light || '').length + String(povClause || '').length + 20;
        // 有 situation 就只用它：它已经是一段自足的 caption（外貌/场景/光线/画风都在里面），
        // 再拼中文段落只会变成「亚麻色长卷发，夜晚暖色灯光，Studio photograph of ...」这种混排。
        const full = !!situation;
        // POV 锚点只在中文镜头上补：英文 caption 由生成它的 prompt 自己负责机位
        const povPre = povMode && full && isCJKText(situation) ? povClause : '';
        const text = sentenceClamp(
            full
                ? [povPre, situation].filter(Boolean).join('，') + styleTail(situation, style)
                : [medium, povClause, head || '一人物', baseParts.join('，'), tail].filter(Boolean).join('，'),
            totalCap,
        );
        report.push(full ? 'summary: 只用 situation 原文（不再拼外貌/场景/光线/画风）' : `外貌来源: ${p.src}`);
        // 字数分解：调大 maxchars 却不见变长时，看这一段就知道是哪一块没料
        const capText = Number.isFinite(totalCap) ? totalCap : '不限';
        report.push(full
            ? `拼接 ${text.length}/${capText} 字（situation ${situation.length}）`
            : `拼接 ${text.length}/${capText} 字（画风${medium ? medium.length : 0} 外貌${head.length} 场景${(scene.text || '').length} 光线${(light || '').length} 镜头${situation.length}）`);
        if (!full && !head) report.push('外貌为空 —— 角色卡没有这个人的 description，名册 npc.desc 也为空');
        return { mode: povMode ? 'pov' : 'single', text, width: 1024, height: 1024, people, report, cap: totalCap };
    }

    // 4) 多人：layout JSON
    const width = o.width || 1248;
    const height = o.height || 832;

    // 官方规则:caption 以媒介开头(Anime-style digital illustration of / Studio photograph of),
    // 不能以动词或动作开头。画风词里逗号前那段当媒介,后面的当尾缀。
    const [medium, ...styleRest] = String(style || '').split(/[，,]/).map(x => x.trim()).filter(Boolean);
    const summaryBits = [];
    if (situation) {
        // situation 已是自足的英文 caption，原样用；画风只追加后缀，不叠场景/光线
        summaryBits.push(situation + styleTail(situation, style));
    } else {
        if (medium) summaryBits.push(medium);
        if (scene.text) summaryBits.push(scene.text);
        if (light) summaryBits.push(light);
        if (styleRest.length) summaryBits.push(styleRest.join('，'));
    }
    if (o.styleFrom) report.push(`画风: ${style || '不加'}（${o.styleFrom}）`);

    const boxes = layoutFor(people.length, kind);
    // 方位词按 bbox 中心的 x 排序分配，保证「说左边的人真的在左边」
    const posWord = people.length >= 3
        ? ['位于画面左侧', '位于画面中间', '位于画面右侧']
        : ['位于画面左侧', '位于画面右侧'];
    const posOf = {};
    boxes
        .map((b, i) => ({ i, c: (b.x0 + b.x1) / 2 }))
        .sort((a, b) => a.c - b.c)
        .forEach((o, rank) => { posOf[o.i] = posWord[rank] || ''; });

    const facing = facingFromSituation(situation, people);

    const items = people.map((p, i) => {
        const parts = [];
        if (p.name) parts.push(p.name);
        // 有 situation 时不再放名册外貌/服装/状态：caption 里已经描述过，重复只会打架
        if (!situation) {
            if (p.looks) parts.push(p.looks);
            if (p.outfit) parts.push(p.outfit);
            if (p.condition) parts.push(p.condition);
        }
        // 只写本人：朝向 + 方位，绝不复述对方的动作
        const face = facing[p.name || (i === 0 ? '#0' : '#1')];
        if (face) parts.push(face);
        if (posOf[i]) parts.push(posOf[i]);
        return {
            label: 'character',
            caption: sentenceClamp(selfOnly(parts.filter(Boolean).join('，')), segCap(SEG_DEFAULT.item, k)),
            bbox: toBBox(boxes[i], width, height),
        };
    });

    const layout = {
        summary: { caption: sentenceClamp(summaryBits.join('，'), sumMax) },
        items,
        bbox_coord_space: 'abs_centralized',
        bbox_format: 'yxyx',
    };
    const text = JSON.stringify(layout, null, 0);
    report.push(`外貌来源: ${people.map(p => p.src).join(' / ')}`);
    report.push(`summary ${layout.summary.caption.length}/${sumMax} 字（${situation ? 'situation 原文' : '画风+场景+光线拼接'}）`);
    report.push(situation ? 'items: 姓名+朝向+方位（外貌/服装不再重复）' : 'items: 姓名+外貌+服装+状态+朝向+方位');
    report.push(`提示词 ${text.length} 字`);

    return { mode: 'layout', text, width, height, people, report, layout, cap: sumMax };
}


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
        // 不写省略号会被当成「提示词被截断了」——它只是预览，完整内容用 preview+
        const shown = built.text.slice(0, 300);
        const more = built.text.length > 300 ? `…（预览只显示前 300 字，实际提交 ${built.text.length} 字，看全用 preview+）` : '';
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
            if (n.style !== undefined) { await setStyle(n.style); touched = true; }
            if (n.view !== undefined) { await setView(n.view); touched = true; }
            if (n.people !== undefined) { await setPeople(n.people); touched = true; }
            if (n.size !== undefined) { await setSize(n.size); touched = true; }
            if (n.detail !== undefined) { await setDetail(n.detail); touched = true; }
            if (n.maxchars !== undefined) { await setMaxchars(n.maxchars); touched = true; }

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

})();
