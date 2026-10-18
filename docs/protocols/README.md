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

## 记忆分类

| 维度 | 可选值 | 回答的问题 |
| --- | --- | --- |
| `memory_tier` | `short_term` / `long_term` | 这项理解保留多久？ |
| `memory_domain` | `user` / `relational` / `shared` | 这项理解描述谁？ |
| `memory_kind` | `episodic` / `semantic` / `procedural` | 这项理解在语义上是什么？ |

旧 `memory_type` 和 `proposed_type` 只作为输入兼容字段。Memory Engine 会在模块内部规范化，新写入必须包含三个独立维度。

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
