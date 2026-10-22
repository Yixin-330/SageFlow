# 晋升候选池、写入与评测：第 0–5 步

当前实现覆盖候选来源、准入、证据收集、确定性判定和原子写入。自动晋升仅对策略允许的低风险谓词开放。

## 候选来源与身份

`PromotionCandidate` 可以来自低置信/待确认的 Pending Candidate，或已写入的短期 Memory Item。两者进入同一个 `PromotionGroup`，但保留 `source_type` 和来源 ID；Pending 不被当成正式记忆。候选组的稳定 ID 由用户、subject、memory_domain、memory_kind、规范化 predicate/value 及安全的 scope anchor 计算，不含 trip/session/day/entity ID。已声明的 `trip_kind` 可作为 anchor；缺少可验证的情境时，anchor 保留原 trip ID，避免跨行程误合并。第一版只有显式 alias map，不用向量相似度自动归组。

一个 event ID 在组内只占一条证据记录；同一次话语的多个事件保留 `occurrence_id`，判定时按话语与行程去重。候选池记录行程、会话、首次/最后出现时间、策略版本、观察截止时间、最近评估时间和状态历史。短期记忆到期不删除组中证据；遗忘来源记忆会删除受影响组及其晋升产物。

## 准入策略

[`promotion-policy.mjs`](../src/memory-engine/promotion-policy.mjs) 按谓词声明 promotable、风险、独立行程/时间跨度门槛、可收集的证据种类、最低证据置信度、是否需要确认、观察天数和 scope 策略。明确陈述且具备稳定范围的已知谓词可走 `direct_long_term`；高风险健康信息需确认，行为推断不能直接入长期。`current_trip_pace` 和 `current_trip_budget_intent` 不进入晋升池；未知谓词默认不允许直接长期写入。

目前 direct-long-term 的兼容路径依赖明确陈述类型和非临时 scope，尚未对自然语言中的“今天/这次”做充分核验；真实模型接入前需要补人工金标与误归层评测。`explicit_generalization` 仅用于标明显式全局声明的分组 anchor，不是绕过确认的授权。

## 生命周期与运行

新组状态为 `collecting`。同一观察批次的冲突、纠正和反馈处理完毕后，只重评本批受影响的组。纯函数 [`decidePromotion`](../src/memory-engine/promotion-decision.mjs) 先求共同 scope，再检查独立行程、时间跨度、同 scope 反证及现有长期记忆。两次 leisure trip 只能泛化到 leisure trip；business + leisure 不会被合成全局。单行程重复、同 utterance 重复、低置信 Pending、纯 inference 不算独立证据。显式全局泛化仍需确认。

满足门槛时创建**新**长期记忆（或强化等价长期记忆），原短期记忆的 ID、tier、scope、TTL 不变。长期记忆携带 evidence event/trip IDs、promotion ID、策略版本、泛化 scope 和来源 ID；写入 `PROMOTE` mutation、`PROMOTED_FROM` edge 与幂等结果。PostgreSQL 的观察事务、claim/group 级锁和结果唯一约束共同防止并发/重放重复写入；内存仓库只用于原型测试，不提供跨进程事务保证。反证阻断或现有长期冲突进入 `blocked_by_counter_evidence` / `needs_confirmation`，不会自动写入。确认交互本身尚未在本阶段实现。

每个组默认观察 90 天；Pending 候选也有独立截止时间。`npm run expire:promotion` 是一次性后台清理任务，需由部署环境的调度器定期执行，不依赖用户新事件。到期只更新状态并保留审计，不进入召回；到期后的新证据开启同一 group 的下一代观察窗，旧代留在 `history`，不混算。PostgreSQL 使用迁移 `006_promotion_groups.sql`、`007_promotion_results.sql`。

第 5 步的模拟场景、指标定义、自动门禁和双人独立人工评审流程见[晋升评测说明](promotion-evaluation.md)。
