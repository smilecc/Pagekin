# SillyTavern 对话补全预设

在 **设置 → 提示词预设** 导入 JSON 文件。导入后可检查条目、点击「使用此预设」，再点击「保存预设设置」。配置保存在本机全局配置中，所有作品共用；可保存多个预设并切换或关闭。

## 条目与变量

- 保留 `prompts`、`prompt_order`、条目的角色、启用状态、插入深度和顺序。默认选择 `character_id = 100001` 的顺序组，也可手动切换。
- 在「提示词条目」中搜索、按启用状态筛选，在右侧编辑内容、角色或上下移动；可将预设库中尚未列入顺序的条目添加到当前顺序组。
- 在「变量与宏」列表中选择变量，查看启用条目计算出的值；待填写的宏优先显示，也可搜索或筛选已自定义值。勾选「使用自定义值」后，填写的值优先于预设的 `setvar`，取消勾选即可恢复预设行为。
- 支持中文变量名、多行及嵌套宏、大小写不敏感的宏名称。变量名称本身区分大小写。
- 支持下表中的常用宏，参数可用 `::`、空格和旧式单冒号分隔；允许分隔符周围留空白。
- `input` 为本次请求最后一条用户消息。角色描述、人格、场景、世界信息和对话示例等可在宏字段中填写，由相应 marker 插入。项目材料仍通过本应用原有任务消息传入。
- 未支持或由扩展提供的宏会原样保留并在预览中提示，可在对应宏字段中设置替代值。范本 `1.99__.json` 的 `count_total` 就需要自行配置；例如输入 `1` 作为叙事矩阵的序号。

「发送预览」显示角色、消息顺序和解析结果。每处 `random` 都独立选择，切换标签不会改变结果；点击「重新随机」可查看其他组合，此操作不修改预设设置。预览使用可复现的随机序列和示例 UUID；真实生成使用当次任务和新的随机值。`pick` 不随预览重新随机而改变。

切换编辑预设不会自动启用它，页面上方分别显示当前生效与保存后生效的选择。底部保存栏始终可见；支持 Ctrl/Cmd+S 保存。移除预设后可在保存前撤销。名称、顺序组、应用范围、导出及移除操作集中在「预设设置」标签页。

## 常用宏兼容表

| 分类 | 支持内容 |
| --- | --- |
| 随机选择 | `{{random::甲::乙}}`、`{{random 甲,乙}}`；旧式逗号列表用 `\,` 表示选项内的逗号；支持嵌套宏、多行和 Unicode 选项 |
| 稳定选择与骰子 | `pick` 按预设身份、源文本及位置稳定选择；`{{roll::6}}`、`{{roll::2d6+1}}`，最多 100 枚骰子 |
| 局部/全局变量 | `get/set/add/inc/dec/has/delete` + `var` / `globalvar`；`varexists/globalvarexists`、`flushvar/flushglobalvar` 别名；只读简写 `{{.变量}}`、`{{$变量}}` |
| 条件 | `{{if 条件}}成立内容{{else}}否则内容{{/if}}`，也支持 `{{if 条件::内容}}`；支持嵌套、`!` 取反、变量简写和上下文宏名称；空值、`false`、`off`、`0` 为假，只执行选中的分支 |
| 文本与空白 | `space/newline` 可带数量；`reverse` 按 Unicode 码点反转；`trim` 清理周围换行，或使用 `{{trim}} 内容 {{/trim}}` 去掉内容首尾空白；`noop` 返回空值 |
| 注释与块 | `//`、`comment` 注释不执行内部宏；支持 `{{//}}注释{{///}}`、`{{comment}}注释{{/comment}}`，以及 `setvar/setglobalvar/addvar/addglobalvar/reverse/trim/if` 的块形式；`#` 前缀保留参数/条件块的空白 |
| 参与者与角色 | `user/char`、`group/groupNotMuted/charIfNotGroup/notChar`（按单助手会话映射）；角色字段 `description/personality/scenario/persona/charPrompt/charInstruction/charDepthPrompt/charCreatorNotes/charVersion` 可在变量界面填写；`mesExamplesRaw` 默认使用 `mesExamples` |
| 请求上下文 | `input/lastMessage/lastUserMessage/lastCharMessage/lastMessageId/firstIncludedMessageId/allChatRange` 基于本次请求的历史消息；不包含应用追加的预设条目；`isMobile=false`、`lastGenerationType=normal`、`hasExtension=false` |
| 日期与其他 | `time/date/weekday/isodate/isotime`、`{{time::UTC+8}}`、`datetimeformat/timestamp`、`uuid` |
| 旧式名称 | `<USER>`、`<BOT>`、`<CHAR>`、`<GROUP>`、`<CHARIFNOTGROUP>` |

`我即浪潮-1105-Éclat·Turing.json` 的 148 个条目可完整导入。默认启用内容中的 1,358 处 `random`（其中噪声锚点 1,350 处）、变量赋值/读取、注释及用户名称均纳入回归测试；无需手动给 `random` 配置替代值。

## 与小说工作流的关系

默认只应用于文本生成；如需用于 JSON 等结构化任务，可选择「全部生成」。预设自己的输出格式要求可能与结构化任务冲突。本应用原有系统约束和任务内容始终保留，关闭 Chat History 标记也不会删除任务消息。

正文、规划、编辑等主进程生成链路在预算计算之前组合预设，新增内容计入上下文预算。运行会冻结当前预设；运行途中保存了生效预设变更，按现有来源变更规则停止并要求重新开始或恢复。流式与非流式旧生成入口也会应用配置；模型连接测试不应用预设。

## 兼容边界

- 这是提示词兼容层，不是 SillyTavern 插件运行环境。正则脚本、扩展、模型采样参数、工具调用设置和辅助聊天操作模板只保留，不执行或覆盖本应用设置。
- 仅执行普通生成（`normal`）触发条目；其他触发器会在预览中提示跳过。
- 局部与全局变量使用独立字典，在每个请求内计算。设置中的初始/覆盖值会持久化，预设执行期间的变量变化不会跨请求或跨作品写回。
- 不支持完整 STscript、任意扩展宏、通用块语法及变量简写中的赋值/算术/比较运算。仅支持上表列出的块和读取简写；未知宏继续保留并提示。
- 本应用没有 SillyTavern 的聊天 ID 与重掷命令；`pick` 使用预设身份作为种子，采用本地哈希算法，因此结果不会与 SillyTavern 逐项相同。更改源文本或位置可能改变选择。
- 日期格式支持 `YYYY/YY/M/MM/MMM/MMMM/D/DD/d/ddd/dddd/H/HH/h/hh/m/mm/s/ss/SSS/A/a/X/x` 和方括号字面量，日期/月份/星期名称按运行环境本地化；不包含完整 Moment.js 格式及 `timeDiff/idleDuration`。
- 模型容量、滑动回复、角色卡首条消息等专属于 SillyTavern 运行环境的数据不会臆造；相应宏需在设置中提供值。角色卡字段默认空值，群组名称按单助手处理。
- 导出原始 JSON 结构并保留未知字段，包括扩展。条目编辑和顺序随导出保存；本应用专用的变量覆盖、宏值和应用范围不写入 SillyTavern 文件。

兼容语义参考 SillyTavern 官方的 [Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/) 和 [Macros](https://docs.sillytavern.app/usage/core-concepts/macros/) 文档，并核对 [核心宏实现](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/macros/definitions/core-macros.js)、[变量宏实现](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/macros/definitions/variable-macros.js) 及 [时间宏实现](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/macros/definitions/time-macros.js)（2026-11-07）。
