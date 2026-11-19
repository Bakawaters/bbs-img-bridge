# 柏宝书生图桥接（bbs-img-bridge）

一个独立酒馆扩展，**不依赖酒馆助手**。作用是把「整条消息原文」替换成「柏宝书里的结构化短描述」再交给 SD 出图。

解决的问题：ST 的 SD 扩展默认走 `RAW_LAST` 分支，把整条 GM 回复塞进 `%prompt%`。实测 9250 字会多花约 40 秒，而且模型抓不到「谁、什么姿势、什么构图」。

## 依赖

- SillyTavern ≥ 1.12.13
- [柏宝书](https://github.com/baibai-git/ST-BaiBai-Book)，并且至少要跑完一楼摘要（否则没有 `protagonist` 数据）
- SD 扩展已连上 ComfyUI

## 用法

| 命令 | 作用 |
|---|---|
| `/bbs-img` | 立刻出一次图 |
| `/bbs-img preview` | 只看拼出来的提示词（echo 到聊天，手机上也看得到） |
| `/bbs-img on` / `off` | 自动出图开关（存在 localStorage，刷新不丢） |
| `/bbs-img maxchars=100` | 改提示词字数上限（默认 120） |

## 拼装顺序（v0.2）

```
外观 → outfit → state.location → 时间→光照 → 写实摄影，浅景深
```

**外观的主源是角色卡的 `description`，不是柏宝书。** 柏宝书的 `protagonist.appearance` 只在「剧情里明确写到外貌变化」时才记录（见它 `MemProtagonist` 的定义：「当前稳定外貌/身体特征；永久变身、伤疤等变化后覆盖」），大多数聊天里这个字段是空的 —— 空的不是故障。

所以：

| 要素 | 来源 |
|---|---|
| 静态外观 | 角色卡 description（按关键词抠出外貌句，≤80 字） |
| 当前服装 / 伤病 | 柏宝书 `protagonist.outfit` / `condition` |
| 地点 | 柏宝书 `state.location` |
| 光线 | 柏宝书 `state.time` → 光照描述 |

角色卡也没写外貌时，直接跳过并提示去补，**绝不退回整条消息**。

## 已知边界

- 只做单人主体。双人同框需要 `CreateBoundingBoxes` + `MOSSImageLayoutPrompt` 的布局工作流，不在本扩展范围内。
- 跨主体的接触动作（握手、拥抱）5B 模型表达不了，别指望。
- 提示词不支持权重语法（`(word:1.5)` 会被当字面量）。

## 安装

酒馆「扩展 → 安装扩展」填本仓库地址。
