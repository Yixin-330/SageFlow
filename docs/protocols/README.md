# SageFlow 用户智能数据协议

## 数据流

```text
ObservationEvent
  -> DecisionContext
  -> recalled MemoryItem[]
  -> StateSnapshot
  -> ActionCandidate[]
  -> DecisionRecord
  -> ActionExecution
  -> FeedbackEvent
  -> MemoryMutation[]
```

## Memory Engine 接口

调用方只需要理解两个操作：

```text
observe(ObservationEvent[]) -> candidates + mutations + rejections + current memories
recall(RecallRequest) -> mandatory_evidence + ranked_memories + matched_rules + current_state + conflicts + relations + omitted + trace
```

抽取、证据校验、敏感性策略、匹配、晋升、冲突、衰减和重排均属于模块内部实现。用户纠正与反馈继续作为 Observation Event 进入 `observe`，不提供无证据的直接覆盖接口。

行动反馈可在 `payload.recall_trace_id` 中指向本次决策的召回记录。Memory Engine 校验该记录属于同一用户，记录 `RECALLED_BEFORE_FEEDBACK` 关系；它只表示召回曝光，不声称某条记忆导致了用户反馈。接受、拒绝或忽略一次行动本身不等于长期偏好确认，模型仅凭这些反馈生成的记忆候选会被拒绝。没有追踪 ID 的旧反馈仍可记录保守的频率/无长期变化 mutation，但无法关联到具体记忆。

显式遗忘调用 `forget({user_id, memory_id, permissions:["memory:forget"]})`，按精确 ID 删除目标及 `DERIVED_FROM`/拆分后代，清理关联证据事件、图边、冲突、Pending、召回日志和可选向量，留下不含陈述内容的 tombstone 与 `FORGET` mutation。若证据事件同时支撑范围外的其他记忆，操作拒绝部分删除，需扩大删除范围；不会静默破坏其他记忆的证据链。PostgreSQL 需要先应用 `005_memory_forgetting.sql` 迁移，删除在同一事务内执行。此接口仅提供后端能力，尚未接入面向用户的授权与确认页面。

## 不变量

1. Observation Event 是不可修改事实；推断不能回写成事实。
2. Decision Context 是一次决策的临时读取模型，不作为长期记忆保存。
3. Memory Item 必须带证据、置信度、时间和适用范围。
4. State Snapshot 必须带证据和过期时间，不能变成永久用户标签。
5. Silent Action 是正式候选行动，不是系统失败。
6. Decision 与 Action Execution 分开记录；决定执行不代表执行成功。
7. Feedback Event 只记录结果，不直接假设拒绝或忽略的原因。
8. Memory Mutation 保留原记录和证据链，禁止无痕覆盖。
9. Memory Candidate 在通过证据、权限、范围和冲突策略前不是正式记忆。
10. Recall Bundle 必须同时说明召回、冲突和排除项。
11. `memory_tier`、`memory_domain`、`memory_kind` 是相互独立的维度，不能合并为一个类型字段。
12. 当前疲劳、压力和即时意图属于 State；只有经过事件证据与晋升策略后才能形成 Memory Item。
13. 低置信候选进入 Pending 区等待更多证据，不能伪装成正式记忆。
14. 版本更新必须通过 Memory Edge 保留来源、替代、拆分、例外和冲突关系。
15. 召回先做租户、权限、有效期和适用范围硬过滤，随后才能在全文、向量和图通道中扩展；必须证据允许超过请求的 `limit`。
16. Decision Record 保留 `recall_trace_id` 和 `matched_rule_ids`；Baseline 的召回追踪为空，Memory/SageFlow 的判断必须能追溯到本次 Recall Bundle。
17. `retention=current_trip` 的候选必须有唯一的证据行程 ID；写入时强制归为短期并绑定该行程，缺失或跨多个行程则拒绝。此规则只保护范围，不能单独证明候选陈述忠于原话，也不能自动判断长期稳定性。
18. State Snapshot 仅在证据、TTL、用户与行程身份均有效且具备敏感权限时随召回返回；缺失条件不能当作永久状态。
19. 短期记忆写入 `expires_at`：本次行程候选取行程结束加 24 小时与写入后 14 天中的较早时间；`short_lived` 必须提供显式截止时间。强化短期记忆不得延长其 `expires_at` 超过原有截止时间。`trip.ended` / `trip.cancelled` 将该行程活跃短期记忆标记 `expired` 并留下 `EXPIRE` mutation。
20. Recall Bundle 分列长期背景、本次行程记忆、其他短期记忆和有效 State。普通短期观察参与排序，不自动成为必须证据；硬约束与明确承诺可成为必须证据。超过安全容量，或因范围无法确认、敏感读取权限缺失导致关键约束不可用时，记录为上下文不完整并让主动决策保持静默。

## 记忆分类

| 维度 | 可选值 | 回答的问题 |
| --- | --- | --- |
| `memory_tier` | `short_term` / `long_term` | 这项理解保留多久？ |
| `memory_domain` | `user` / `relational` / `shared` | 这项理解描述谁？ |
| `memory_kind` | `episodic` / `semantic` / `procedural` | 这项理解在语义上是什么？ |

旧 `memory_type` 和 `proposed_type` 只作为输入兼容字段。Memory Engine 会在模块内部规范化，新写入必须包含三个独立维度。

范围优先使用结构化 `scope.trips`、`sessions`、`days`、`entities`、`situations` 与 `time_window`；这些条件跨维度同时满足。旧 `applies_when` 仍可读取，但缺少必要情境时返回 `SCOPE_UNRESOLVED`，不再放行。`scope` 不设条件才表示全局。行程范围与 TTL 是不同约束：行程结束主动失效，TTL 在没有结束事件时兜底。

## 冲突语义

冲突判定由谓词基数和范围关系共同决定，不再仅凭“同一谓词、不同值”判冲突。`prefers_travel_pace`、`current_trip_pace`、活动预算、通知频率和活动强度按单值处理；`likes_experience`、`health_constraint`、`service_policy` 按可并存的多值处理。未登记谓词保守地不自动判冲突，登记谓词的值类型在写入前校验，不自动把字符串金额转成数字。

结构化范围比较会区分相等、包含、部分重叠、不相交和无法确定：单值谓词在相同或部分重叠范围且值不同时形成开放冲突；包含关系记录从窄范围指向宽范围的 `EXCEPTION_TO`，不视为互相覆盖；不相交或无法确定的范围暂时并存。旧 `applies_when` 的不同标签不能证明包含或排斥，因此不推断例外。召回中可见的开放冲突会给相关记忆标记 `disputed`，供决策端审慎处理。

用户明确纠正（候选标记或 `feedback.user_corrected` 事件）可以替代相同范围的旧值，同时保留 `SUPERSEDES` 与 `RESOLVED_BY` 证据链；范围拆分和短期记忆到期也会关闭所涉及的开放冲突。独立的较新陈述目前不会仅凭时间或置信度自动覆盖旧记忆，仍保留待澄清冲突。短期证据只强化或替代短期记忆，不会改写长期置信度、最后确认时间或长期版本；跨层相同范围的相反值记录为从短期指向长期的 `EXCEPTION_TO`（`temporal_override=true`），长期记忆保持 active。此策略同样用于内存仓库的种子数据和运行时写入。

## 晋升候选池

第 0–5 步见[晋升候选池说明](../promotion-pool.md)：Pending 与已生效短期记忆按稳定 group ID 收集；满足共同 scope 和独立证据门槛的低风险组可原子晋升，保留原短期记忆及来源谱系。观察到期由独立任务执行；模拟评测门禁已建立，用户确认交互和真实用户验证仍待完成。

## 架构模式

- `flat`：阶段 0 回归基线，不写入关系边。
- `typed`：启用三维记忆协议、路由与生命周期，不写入关系边。
- `hybrid`：在 typed 基础上记录证据、冲突、例外和版本关系；当前默认模式。

三种模式均保持相同的 `observe` / `recall` 外部接口。

## 通用追踪字段

- `schema_version`: 协议版本。
- `trace_id`: 串联一次感知到学习的完整链路。
- `occurred_at`: 事实实际发生时间。
- `recorded_at`: 系统收到事实的时间。
- `evidence_ids`: 推断引用的事件或记忆标识。
- `model_version` / `policy_version`: 支持版本回放与回归。

核心 JSON Schema 位于 [`schemas`](../../schemas/)；模拟故事位于 [`scenarios/catalog.json`](../../scenarios/catalog.json)。
