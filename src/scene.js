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
 * 单句清洗：去掉这一句里不可画的成分。
 * 注意只洗「句子内部」，不决定留不留这一句 —— 去留由 visualOnly 统一管。
 */
function cleanOneSentence(s) {
    return String(s ?? '')
        .replace(/[（(][^）)]*[）)]/g, '')                      // 成对的括注
        .replace(/[（(][^）)]*$/, '')                           // 没闭合的括注：连同后半句一起丢
        .replace(/(她|他|它|对方|两人|二人)(心里|心中|暗自|似乎|好像|可能|觉得|感到|想着|打算|决定|犹豫)/g, '')
        .replace(/(想要|准备|打算|试图|企图|好像要|似乎要|可能会)/g, '')
        .replace(/[「」“”"'’]/g, '')
        .replace(/[|｜{}]/g, '，')
        // 「动作：」「地点:」这类字段名前缀，镜头按字段写时要去掉，否则进提示词是噪声
        .replace(/^[\u4e00-\u9fa5A-Za-z]{1,6}\s*[:：]\s*/, '')
        .replace(/，{2,}/g, '，')
        .replace(/^[，、\s]+|[，、；;．。\s]+$/g, '')
        .trim();
}

/**
 * 去掉叙事里不可画的东西：心理活动、因果、将来时、选项。
 *
 * v1.4.0 起**不再「只取第一句」**。原来的 `.split(/[。；;]/)[0]` 会从第一个
 * 句号处把整段砍掉：镜头按「朝向。手。相对位置。接触」分句写时，后三句全丢，
 * 这就是「字段没发送出去 / 只剩半句」的主因。现在改成逐句清洗、全部保留。
 */
function visualOnly(s) {
    return flatten(s)
        .split(/[。；;！？!?]/)
        .map(cleanOneSentence)
        .filter(x => x.length >= 2)                            // 洗完变空的句子才丢
        .join('，');
}

/** item.caption 禁止出现指代别人的短语，否则模型会多画一个人 */
function selfOnly(s) {
    return visualOnly(s)
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
function personProfile(name, snap, cards = {}) {
    const key = String(name ?? '').trim();
    const npcs = snap?.npcs || [];
    const p = snap?.protagonist || {};
    const hit = npcs.find(n => n?.name && (n.name === key || key.includes(n.name) || n.name.includes(key)));

    if (hit) {
        return {
            name: hit.name,
            looks: sentenceClamp(stripLeadingName(hit.desc || cards[hit.name] || '', hit.name), 70),
            outfit: sentenceClamp(hit.outfit || '', 30),
            condition: sentenceClamp(hit.condition || '', 24),
            src: hit.desc ? 'npc.desc' : (cards[hit.name] ? '角色卡' : '无'),
        };
    }

    // 没命中 NPC → 当主角
    const isUser = /^(我|你|user|主角|{{user}})$/i.test(key) || key === '';
    return {
        name: isUser ? '' : key,
        looks: sentenceClamp(stripLeadingName(p.appearance || cards[key] || cards['__user__'] || '', key), 70),
        outfit: sentenceClamp(p.outfit || '', 30),
        condition: sentenceClamp(p.condition || '', 24),
        src: p.appearance ? 'protagonist.appearance' : (cards[key] || cards['__user__'] ? '角色卡/人设' : '无'),
    };
}

/* ---------------- 场景描述 ---------------- */

function sceneDesc(snap) {
    const st = snap?.state || {};
    const scenes = snap?.scenes || [];
    const out = [];
    let from = '无';

    // locationPath 由粗到细，取最细一级有 desc 的
    const path = Array.isArray(st.locationPath) ? st.locationPath : [];
    if (path.length) {
        for (let i = path.length - 1; i >= 0; i--) {
            const node = scenes.find(s => s?.name === path[i] && s?.desc);
            if (node) { out.push(sentenceClamp(flatten(node.desc), 70)); from = `scenes.${path[i]}.desc`; break; }
        }
        if (!out.length && path.length) { out.push(flatten(path[path.length - 1])); from = 'locationPath'; }
    }
    if (!out.length && st.location) { out.push(sentenceClamp(flatten(st.location), 70)); from = 'state.location'; }
    if (!out.length) {
        const any = scenes.find(s => s?.desc);
        if (any) { out.push(sentenceClamp(flatten(any.desc), 70)); from = `scenes.${any.name}.desc`; }
    }

    return { text: sentenceClamp(out.join('，'), 60), from };
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
export function composeScene(o = {}) {
    const snap = o.snapshot || {};
    const cards = o.cards || {};
    // style 为空字符串 = 调用方已决定不加画风词（比如 ST 的 Prompt Prefix 已经在管）
    const style = o.style === undefined ? STYLE_DEFAULT : String(o.style || '').trim();
    // 镜头字数上限：实测单句甜区 90–120 字（文档第十二节），默认 140
    const sumMaxBase = Math.max(60, Math.min(400, Number(o.summaryMax) || 140));
    const maxPeople = Math.max(1, Math.min(3, o.maxPeople || 3));
    const report = [];
    const st = snap.state || {};
    const sf = st.sceneFocus || {};

    // 0) 局面：自定义变量 situation 优先，回退内置局势卡
    const shot = pickShot(snap.vars);
    const varShot = visualOnly(shot.text);
    const builtinShot = visualOnly(sf.situation || '');
    const situation = varShot || builtinShot;
    const situationFrom = varShot ? `自定义变量 ${shot.from.replace(/^vars\./, '')}` : (builtinShot ? 'sceneFocus.situation' : '');
    if (situationFrom) {
        const lost = shot.text ? shot.text.length - varShot.length : 0;
        const fld = shot.fields ? `${shot.fields} 个字段，` : '';
        report.push(`镜头: ${situationFrom}（${fld}原 ${shot.text.length || builtinShot.length} 字${lost > 3 ? `，清洗掉 ${lost} 字` : '，无截断'}）`);
    }

    // 镜头本身超上限时按内容放宽，否则六要素会被 sentenceClamp 砍掉后三条
    const sumMax = Math.max(sumMaxBase, Math.min(400, situation.length + 60));

    // 1) 谁在场
    let names = Array.isArray(sf.participants) ? sf.participants.map(flatten).filter(Boolean) : [];
    if (!names.length) {
        // 局势卡没更新时，从画面镜头/局面的正文里反找名册中的人名
        const pool = `${situation} ${sceneDesc(snap).text}`;
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

    let people = names.map(n => personProfile(n, snap, cards));

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
    const scene = sceneDesc(snap);
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
        const text = sentenceClamp([medium, povClause, head || '一人物', baseParts.join('，'), tail].filter(Boolean).join('，'), 240);
        report.push(`外貌来源: ${p.src}`);
        return { mode: povMode ? 'pov' : 'single', text, width: 1024, height: 1024, people, report };
    }

    // 4) 多人：layout JSON
    const width = o.width || 1248;
    const height = o.height || 832;

    // 官方规则:caption 以媒介开头(Anime-style digital illustration of / Studio photograph of),
    // 不能以动词或动作开头。画风词里逗号前那段当媒介,后面的当尾缀。
    const [medium, ...styleRest] = String(style || '').split(/[，,]/).map(x => x.trim()).filter(Boolean);
    const summaryBits = [];
    if (medium) summaryBits.push(medium);
    if (situation) summaryBits.push(situation);
    if (scene.text) summaryBits.push(scene.text);
    if (light) summaryBits.push(light);
    if (styleRest.length) summaryBits.push(styleRest.join('，'));
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
        if (p.looks) parts.push(p.looks);
        if (p.outfit) parts.push(p.outfit);
        if (p.condition) parts.push(p.condition);
        // 只写本人：朝向 + 方位，绝不复述对方的动作
        const face = facing[p.name || (i === 0 ? '#0' : '#1')];
        if (face) parts.push(face);
        if (posOf[i]) parts.push(posOf[i]);
        return {
            label: 'character',
            caption: sentenceClamp(selfOnly(parts.filter(Boolean).join('，')), 90),
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
    report.push(`提示词 ${text.length} 字`);

    return { mode: 'layout', text, width, height, people, report, layout };
}
