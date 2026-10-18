# 阶段五：混合召回

`RecallRequest` 可提供 `query_text`、`topics`、`predicates`、`required_memory_ids`、`trip_id`、`situation`、`permissions`、`current_state` 和 `limit`。State 只随本次请求传入并检查有效期，不晋升为长期记忆。

1. 读取用户记忆，先按状态、敏感权限、有效期与适用范围硬过滤；不合格项不会进入全文、向量或图检索。
2. 在结构化、词项、可选 PostgreSQL 全文、可选向量、条件规则与一跳关系通道查找候选。无数据库向量命中时，可使用注入的 embedder 做小规模内存语义检索。
3. 以 RRF 合并排名，再结合置信度、显著性、时间、适用范围与证据量重排。直接文本/语义命中优先于仅由图扩展的候选。
4. 将预算、健康/安全约束、提醒频率、当前行程短期意图及显式要求的记忆列为必须证据；其冲突对方也一并保留。必须证据可能使结果超过 `limit`。
5. 返回 `mandatory_evidence`、`ranked_memories`、`matched_rules`、`current_state`、冲突与关系边，以及每项的通道名/排名、分数和排除原因；召回日志只记录 ID 与计划统计。

`flat` / `typed` / `hybrid` 保持同一接口；`flat` 是只用结构化通道的安全基线，`typed` 增加词项、全文、向量和规则，`hybrid` 再增加图扩展。三者都保留硬过滤与必须证据，避免拿隐私或安全约束换基线分数。

`npm run evaluate:recall` 对固定样例计算 Recall@K、Precision@K、Hit@1、MRR、nDCG、必须证据遗漏、禁入记忆泄漏、冲突覆盖及平均时延。数据在 [`evaluation/recall-cases.json`](../evaluation/recall-cases.json)。这些人工样例只适合防回归；下一步需要盲标真实查询、困难负例、跨语言改写和人工判断“证据是否真正帮助行动”。
