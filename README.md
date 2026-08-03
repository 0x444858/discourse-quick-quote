# discourse-quick-quote

一个 Discourse 主题组件（Theme Component），将帖子回复按钮的行为改为**单击自动引用**，并对引用内容进行智能截断与格式化。

A Discourse Theme Component that changes Post Reply buttons to automatically quote a post in a single click, with smart truncation and formatting.

---

## 功能特性 / Features

- **单击引用**：点击回复按钮时自动插入引用内容，无需手动选中文字。
- **智能截断**：超出字符限制时，按结构化分段截断——链接的显示文字可截断，但 URL 保持完整可点击。
- **链接保护**：截断后链接以 `[text](url)` Markdown 输出，确保点击可达。
- **裸链预截断**：当链接的显示文字与 URL 相同时，自动将显示文字缩短为首个路径段 + `...`（如 `https://example.com/info/1035/13639.htm` → `https://example.com/info/...`）。
- **图片保留**：用户上传的图片以 `![title](url)` 格式保留，使用 Discourse 的 `upload://` 短链，跨实例可移植。图片按固定宽度计入字符预算，完整保留或整体丢弃。
- **Emoji 保留**：内联 emoji（`:wave:` 等）始终保留为原始文本，计为 2 字符宽度（视觉宽度 ≈ 2 个 ASCII 字符）。
- **双倍宽度 Unicode**：截断时将非 ASCII 字符（中文/CJK/全角符号等）计为 2 倍宽度，使中英文混排文本的截断视觉长度更均匀。
- **Spoiler（模糊内容）保留**：引用中的模糊块（`<div class="spoiler">` / `<span class="spoiler">` 及其 `spoiled`、`spoiler-blurred` 等变体）自动转换为 `[spoiler]…[/spoiler]` BBCode。截断时包装器始终完整，内部内容按需截断，不会出现 BBCode 残缺。
- **嵌套引用剥离**：自动移除引用中的嵌套 `<aside>` 引用块，防止内容膨胀。
- **位置感知**：可配置距离最新回复多少层以内的帖子不触发截断，避免截断正在进行的讨论。

---

## 配置项 / Settings

| 设置项 | 类型 | 默认值 | 说明 |
| ------ | ---- | ------ | ---- |
| `quick_quote_post_location_threshold` | integer | `1` | 距离最新帖子多少层以内时禁用截断（0 = 始终启用） |
| `quick_quote_character_limit` | integer | `100` | 引用内容最大字符数，超出时截取开头部分 |
| `quick_quote_keep_link_reachable` | bool | `true` | 截断时仅截断链接显示文字，保留完整 URL |
| `quick_quote_truncate_bare_links` | bool | `false` | 主动截断裸链接（显示文字 = URL 的链接） |
| `quick_quote_double_width_unicode` | bool | `true` | 非 ASCII 字符计为双倍宽度 |
| `quick_quote_keep_image` | bool | `true` | 在引用中保留图片 |
| `quick_quote_image_character_width` | integer | `40` | 图片在字符预算中占用的固定宽度 |

---

## 截断流程 / Truncation Pipeline

```text
原始 BBCode
  │
  ├─ 剥离嵌套引用 (<aside>...</aside>)
  │
  ├─ 提取 spoiler 块（占位符保护）
  │   ├─ 块级: <div class="spoiler|spoiled …">…</div>  →  \x01SPOILER_0\x01
  │   └─ 内联: <span class="spoiler|spoiled …">…</span>  →  \x01SPOILER_0\x01
  │
  ├─ 解析为结构化分段
  │   ├─ TextSegment    — 纯文本
  │   ├─ EmojiSegment   — emoji（宽度=2，全有或全无）
  │   ├─ LinkSegment    — 链接/图片（只截文字，保留 href）
  │   └─ SpoilerSegment — 模糊块（包装器不计宽度，内部递归截断）
  │
  ├─ 占位符注入: 将 \x01SPOILER_N\x01 文本段替换为 SpoilerSegment
  │
  ├─ [可选] 裸链预截断
  │
  ├─ [可选] 字符限长截断
  │   ├─ keep_link_reachable=true  → 智能截断（保护链接与 spoiler 包装器）
  │   └─ keep_link_reachable=false → 笨拙截断（segmentsToFlatText 保留 [spoiler] 后 cut）
  │
  └─ 重建输出
      ├─ keep_link_reachable=true  → segmentsToContent  (Markdown + [spoiler])
      └─ keep_link_reachable=false → segmentsToFlatText (纯文本 + [spoiler])
```

### 占位符机制 / Placeholder System

Spoiler 的 HTML 包装器必须在解析管道早期被提取，但在 HTML 标签剥离步骤 `extractTextFromHtml` 之后才能定位回原文位置。为此引入了一个**三步占位符模式**：

| 步骤 | 函数 | 输入 | 输出 |
| ---- | ---- | ---- | ---- |
| **1. 提取** | `extractBlockSpoilers` / `extractInlineSpoilers` | `<div class="spoiler">隐藏内容</div>` | 占位符 `\x01SPOILER_0\x01` + 已解析的内部段 |
| **2. 解析** | `parseHtmlContent` / `parseInlineContent` | 含占位符的普通文本 | 普通段 + 含占位符的 TextSegment |
| **3. 注入** | `injectSpoilerSegments` | 含占位符的 TextSegment | SpoilerSegment（结构完整） |

占位符格式：`` \x01SPOILER_N\x01 ``（`N` 为递增整数）

**选择 `\x01`（SOH 控制字符）的原因：**

- 不是 HTML 标签 → `extractTextFromHtml` 的 `<[^>]*>` 剥离不会触及它
- 不是空白字符 → `/\s+/` 合并和 `.trim()` 不会移除它
- 不会在正常用户输入中出现 → 零误匹配

整个模式等价于：**先用标记「占坑」保护 spoiler 边界 → 管道正常加工 → 最后用结构化段换回标记**。

---

## 兼容性 / Compatibility

- Discourse 2.9+

---

## 许可 / License

[MIT](LICENSE)
