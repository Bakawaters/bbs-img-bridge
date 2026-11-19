# 柏宝书生图桥接（bbs-img-bridge）

把**柏宝书维护的当前场景**（谁在场、在哪、在做什么）翻译成 MOSS 能吃的一张图。

v1.0 的核心不是"再拼一句提示词"，而是解决**多人同框 + 人物交互**：

- 两人以上不再靠一句话描述，而是给每个角色一个 **bbox 布局框**（MOSS 官方 layout JSON，直接当 prompt 文本提交，不需要 ComfyUI 布局节点）
- **交互动作只写在 `summary.caption`**，每个角色的 `caption` 只写本人的外观/朝向 —— 实测把"抱住对方的腰"写进角色 caption 会多长出一张脸
- 构图按交互动词分档：贴身接触 → 两框重叠；并排 → 对半分；对峙 → 拉开

## 依赖

- SillyTavern ≥ 1.12.13（TauriTavern 亦可）
- [柏宝书](https://github.com/baibai-git/ST-BaiBai-Book) 且已有摘要（`state.sceneFocus` 是主数据源）
- SD 扩展已连上 ComfyUI，工作流是 MOSS 的（文件名含 `moss`）

## 用法

| 命令 | 作用 |
|---|---|
| `/bbs-img` | 按当前场景出图 |
| `/bbs-img preview` | 看每个字段取自哪里（不消耗 GPU） |
| `/bbs-img preview+` | 额外打印完整提示词与将要提交的命令 |
| `/bbs-img raw` | 倾倒柏宝书快照（排查用） |
| `/bbs-img rawcmd` | 打印上一次提交的 `/sd` 命令 |
| `/bbs-img on` / `off` | 收到 AI 消息自动出图 |
| `/bbs-img style=动漫赛璐璐` | 换画风后缀 |
| `/bbs-img people=2` | 最多画几个人（1–3） |
| `/bbs-img size=1248x832` | 多人图尺寸（bbox 会按新尺寸重算） |
| `/bbs-img reset` | 清去重记录 |

## 字段映射

| 画面要素 | 来源 |
|---|---|
| 画几个人、画谁 | `state.sceneFocus.participants`；空则取 `npcs` 里 `important` / `follow` 的第一人 |
| 外貌（静态） | `npcs[].desc` → 角色卡 `description` → `protagonist.appearance` → 用户人设 |
| 当前服装 | `npcs[].outfit` / `protagonist.outfit` |
| 伤病状态 | `npcs[].condition` / `protagonist.condition` |
| 场景 | `state.locationPath` 命中的 `scenes[].desc` → `state.location` |
| 光线 | `state.time` → 时间词表 |
| **交互/动作** | `state.sceneFocus.situation`（只保留第一句、剥掉心理与因果） |
| 构图 | `situation` 里的动词 + 人数 |

## 已知边界

- 最多 3 人。第 4 人开始每个角色分到的像素低于 MOSS 的有效下限。
- `situation` 是叙事句不是画面句，规则清洗只能去掉明显不可画的部分；它写成"她犹豫着要不要开口"这种没有动作的句子时，图会退化成人物摆拍。
- 柏宝书没摘要过的聊天没有 `sceneFocus`，此时**直接跳过并说明**，不会退回整条消息。
- 支持自然语言，不支持权重语法（`(word:1.5)` 会被当字面量）。

## 安装

酒馆「扩展 → 安装扩展」填本仓库地址。

## 开发

```bash
npm run build   # src/scene.js + src/host.js → index.js（ST 只加载单文件）
npm test        # 桩测试：字段映射、命令格式、空场景
```
