export const MODES = {
  baseline: { label: "Baseline", short: "当前事实", capability: "只使用当前情境，不使用历史记忆。" },
  memory: { label: "Memory", short: "事实 + 记忆", capability: "召回长期理解，但不进行状态推断和主动策略控制。" },
  sageflow: { label: "SageFlow", short: "记忆 + 状态 + 决策", capability: "综合证据、打扰成本和约束，允许主动行动或静默。" }
};

const clone = (value) => JSON.parse(JSON.stringify(value));

function merge(target, patch) {
  const output = { ...target };
  for (const [key, value] of Object.entries(patch ?? {})) {
    output[key] = value && typeof value === "object" && !Array.isArray(value)
      ? merge(output[key] ?? {}, value)
      : value;
  }
  return output;
}

export function createSession(scenario, catalog) {
  const memoryMap = new Map(catalog.memory_catalog.map((item) => [item.memory_id, clone(item)]));
  return {
    scenario: clone(scenario),
    context: clone(scenario.initial),
    memories: scenario.initial_memory_ids.map((id) => memoryMap.get(id)).filter(Boolean),
    appliedEvents: [],
    cursor: 0,
    feedback: [],
    mutations: [],
    frequencyPolicy: "normal"
  };
}

export function advanceSession(session) {
  if (session.cursor >= session.scenario.timeline.length) return session;
  const event = session.scenario.timeline[session.cursor];
  session.context = merge(session.context, event.payload.patch ?? {});
  session.appliedEvents.push(event);
  session.cursor += 1;
  return session;
}

export function runToEnd(session) {
  while (session.cursor < session.scenario.timeline.length) advanceSession(session);
  return session;
}

function evidence(session, eventType, fallback) {
  const event = [...session.appliedEvents].reverse().find((item) => item.event_type.includes(eventType));
  return [event?.event_id ?? fallback].filter(Boolean);
}

export function inferState(session) {
  const c = session.context;
  const dimensions = {};

  if (c.selfReportedEnergy === "high") {
    dimensions.fatigue = { value: "low", confidence: 0.88, evidence_ids: evidence(session, "dialogue", "current_user_statement") };
  } else if (c.steps >= 10000 && c.activityEvidence) {
    dimensions.fatigue = { value: "high", confidence: 0.74, evidence_ids: evidence(session, "activity", "current_activity_summary") };
  } else if (c.steps >= 10000) {
    dimensions.fatigue = { value: "uncertain", confidence: 0.45, evidence_ids: evidence(session, "activity", "current_step_count") };
  } else {
    dimensions.fatigue = { value: "low", confidence: 0.69, evidence_ids: ["current_step_count"] };
  }

  if (c.outdoorAtRisk && c.closingSoon) {
    dimensions.time_pressure = { value: "high", confidence: 0.89, evidence_ids: [
      ...evidence(session, "weather", "current_weather"),
      ...evidence(session, "itinerary", "current_itinerary")
    ] };
  }

  const lowInterruptMemory = session.memories.find((m) => m.statement?.predicate === "prefers_notification_frequency"
    && m.statement.value === "low");
  dimensions.interruption_tolerance = {
    value: c.recentIgnored >= 2 ? "low" : lowInterruptMemory ? "medium" : "high",
    confidence: c.recentIgnored >= 2 ? 0.86 : 0.68,
    evidence_ids: c.recentIgnored >= 2 ? evidence(session, "feedback", "recent_interaction")
      : [lowInterruptMemory?.memory_id ?? "current_interaction_history"]
  };

  if (c.currentIntent === "continue_outdoor") {
    dimensions.exploration_intent = { value: "high", confidence: 0.93, evidence_ids: evidence(session, "dialogue", "current_user_statement") };
  }
  if (c.childRestDue) {
    dimensions.companion_need = { value: "high", confidence: 0.91, evidence_ids: evidence(session, "companion", "current_companion_schedule") };
  }
  const budgetMemory = session.memories.find((m) => m.statement?.predicate === "comfortable_activity_budget_cny"
    && Number.isFinite(Number(m.statement.value)));
  if (budgetMemory && c.alternativePrice > Number(budgetMemory.statement.value)) {
    dimensions.budget_pressure = { value: "high", confidence: 0.96, evidence_ids: [budgetMemory.memory_id, ...evidence(session, "price", "current_service_price")] };
  }
  const paceValues = session.memories
    .filter((m) => m.statement.predicate === "prefers_travel_pace")
    .map((m) => m.statement.value);
  if (new Set(paceValues).size > 1) {
    dimensions.preference_conflict = { value: "high", confidence: 0.88, evidence_ids: session.memories.filter((m) => m.statement.predicate === "prefers_travel_pace").map((m) => m.memory_id) };
  }
  if (c.weatherFreshnessMinutes > 60 || c.receivedStaleWeather) {
    dimensions.data_freshness = { value: "stale", confidence: 0.99, evidence_ids: evidence(session, "weather", "received_weather_event") };
  }

  const observed = `2026-08-25T${c.time}:00+08:00`;
  return {
    state_id: `state_${session.scenario.id}_${session.cursor}`,
    user_id: "usr_001",
    trip_id: session.appliedEvents.at(-1)?.trip_id ?? "trip_simulation",
    observed_at: observed,
    expires_at: `2026-08-25T23:59:00+08:00`,
    dimensions,
    model_version: "deterministic-state-0.1"
  };
}

function makeAction(id, type, value, interruption, risk, urgency, reasons, message, confirmation = false) {
  return {
    action_id: id,
    action_type: type,
    target: "user",
    channel: type === "remain_silent" ? "none" : "in_app",
    expected_user_value: value,
    interruption_cost: interruption,
    risk,
    urgency,
    requires_confirmation: confirmation,
    reason_codes: reasons,
    message
  };
}

function currentFactsMessage(c) {
  if (c.weather.includes("雨") || c.outdoorAtRisk) return "当前天气可能影响户外安排，建议携带雨具并关注营业时间。";
  return `当前位于${c.location}，下一项安排是${c.nextPlan}。`;
}

function baselineResult(session) {
  const c = session.context;
  const action = makeAction(
    `act_${session.scenario.id}_baseline`,
    c.outdoorAtRisk ? "generic_weather_alert" : "generic_context_reply",
    0.56, 0.42, 0.08, c.urgency,
    c.outdoorAtRisk ? ["CURRENT_WEATHER"] : ["CURRENT_CONTEXT"],
    currentFactsMessage(c)
  );
  return buildResult("baseline", session, null, [], action, "仅依据当前可观察事实生成响应。", []);
}

function memoryResult(session) {
  const c = session.context;
  const recalled = session.memories;
  const likesPhoto = recalled.some((m) => m.statement?.predicate === "likes_experience"
    && /photograph|摄影/i.test(String(m.statement.value)));
  const withFamily = recalled.some((m) => m.statement?.predicate === "prefers_activity_load"
    && /child|亲子|儿童/i.test(String(m.statement.value)));
  let action;
  if (c.outdoorAtRisk && likesPhoto) {
    action = makeAction(`act_${session.scenario.id}_memory`, "recommend_indoor_photography", 0.73, 0.45, 0.12, c.urgency, ["CURRENT_WEATHER", "RECALLED_PHOTOGRAPHY_PREFERENCE"], `天气可能影响户外安排。你喜欢摄影，可以考虑附近的${c.alternative}。`);
  } else if (withFamily) {
    action = makeAction(`act_${session.scenario.id}_memory`, "recommend_family_stop", 0.67, 0.4, 0.1, c.urgency, ["RECALLED_FAMILY_PREFERENCE"], `你在亲子旅行中偏好低负担体验，可以考虑${c.alternative}。`);
  } else {
    action = makeAction(`act_${session.scenario.id}_memory`, "personalized_context_reply", 0.61, 0.39, 0.08, c.urgency, ["CURRENT_CONTEXT", "RECALLED_MEMORY"], `${currentFactsMessage(c)}我也参考了你过去的旅行偏好。`);
  }
  return buildResult("memory", session, null, recalled, action, "使用当前事实和召回记忆，但不推断动态状态。", []);
}

function sageFlowResult(session) {
  const c = session.context;
  const state = inferState(session);
  const d = state.dimensions;
  const filters = ["permission_check", "privacy_check", "frequency_cap", "freshness_check", "confirmation_required", "service_policy_check"];
  const candidates = [
    makeAction(`act_${session.scenario.id}_silent`, "remain_silent", 0.52, 0, 0, 0, ["INTERRUPTION_COST_CONSIDERED"], "保持静默：当前行动价值没有超过打扰成本。"),
    makeAction(`act_${session.scenario.id}_ask`, "ask_user_preference", 0.66, 0.24, 0.04, c.urgency, ["UNCERTAINTY_REQUIRES_CONFIRMATION"], "我还不能确定你此刻是否需要调整。要继续原计划，还是看一个低负担备选？")
  ];

  let selected;
  let reason;
  if (!c.permissions) {
    selected = makeAction(`act_${session.scenario.id}_permission`, "ask_permission", 0.58, 0.2, 0.02, c.urgency, ["LOCATION_PERMISSION_REQUIRED"], "需要获得位置授权后，我才能判断路线变化。", true);
    reason = "授权不足，禁止使用缺失的实时位置进行主动调整。";
  } else if (d.data_freshness?.value === "stale") {
    selected = candidates[0];
    selected.message = "保持静默：收到的强降雨信息已经过期，当前情境不支持再次打扰。";
    selected.reason_codes = ["STALE_EVENT", "CURRENT_CONDITION_RECOVERED"];
    reason = "过期天气被新鲜度规则过滤。";
  } else if (c.currentIntent === "continue_outdoor" && c.selfReportedEnergy === "high") {
    selected = candidates[0];
    selected.message = "保持静默：用户已明确表示今天体力良好并希望继续户外行程。";
    selected.reason_codes = ["EXPLICIT_CURRENT_INTENT", "TEMPORARY_INTENT_OVERRIDES_DEFAULT"];
    reason = "当前明确意图优先于长期慢节奏偏好。";
  } else if (session.servicePolicy?.action === "remain_silent" && c.urgency < 0.8) {
    selected = candidates[0];
    selected.message = "保持静默：当前情境匹配用户的低打扰服务规则。";
    selected.reason_codes = ["MATCHED_SERVICE_POLICY", "LOW_URGENCY"];
    reason = "当前低紧迫事项受到已匹配的个性化静默规则约束。";
  } else if (c.recentIgnored >= 2 && c.urgency < 0.8) {
    selected = candidates[0];
    selected.message = "保持静默：用户连续忽略了低紧迫建议，当前变化不足以再次介入。";
    selected.reason_codes = ["RECENTLY_IGNORED", "LOW_URGENCY"];
    reason = "频率约束使静默的净价值最高。";
  } else if (d.companion_need?.value === "high") {
    selected = makeAction(`act_${session.scenario.id}_rest`, "suggest_nearby_rest", 0.88, 0.2, 0.05, c.urgency, ["CHILD_REST_WINDOW", "LOW_TRANSFER_OPTION"], `距离孩子通常的休息时间不远。${c.alternative}移动负担更低，要先在那里停留吗？`, true);
    reason = "同行儿童的即时休息需求高于原路线完整度。";
  } else if (d.preference_conflict?.value === "high") {
    selected = candidates[1];
    selected.message = "你在不同旅行里表现出过两种节奏偏好。今天更想松弛体验，还是多去几个地方？";
    selected.reason_codes = ["CONFLICTING_PACE_MEMORIES", "CURRENT_SCOPE_UNCLEAR"];
    reason = "冲突记忆的适用范围无法仅凭当前事实消解。";
  } else if (d.budget_pressure?.value === "high") {
    selected = candidates[1];
    selected.message = `${c.alternative}与你的兴趣匹配，但票价 ${c.alternativePrice} 元高于你通常的单项预算。要我找免费室内选项吗？`;
    selected.reason_codes = ["OVER_COMFORT_BUDGET", "ASK_BEFORE_RECOMMENDING"];
    reason = "高匹配度不能覆盖预算约束。";
  } else if (d.fatigue?.value === "uncertain") {
    selected = candidates[1];
    selected.message = "你今天走得不少，但我不能只凭步数判断你累了。需要我找一个附近的休息选项吗？";
    selected.reason_codes = ["FATIGUE_EVIDENCE_INSUFFICIENT", "ASK_INSTEAD_OF_ASSUME"];
    reason = "状态证据不足，询问优于武断调整。";
  } else if (c.outdoorAtRisk && c.closingSoon) {
    selected = makeAction(`act_${session.scenario.id}_adjust`, "propose_itinerary_adjustment", 0.91, 0.28, 0.06, c.urgency, ["HEAVY_RAIN_EXPECTED", "OUTDOOR_PLAN_AT_RISK", "USER_PREFERS_SLOW_PACE", "MATCHED_INDOOR_OPTION"], `15:00 后的雨可能让原计划变得很赶，你上午的步行量也接近平时舒适上限。可以改去${c.alternative}，户外园林移到明天；是否调整由你确认。`, true);
    reason = "行动收益在天气、时间、体力与偏好证据共同支持下超过打扰成本。";
  } else {
    selected = candidates[0];
    reason = "没有足够高价值且及时的主动行动。";
  }

  candidates.push(selected);
  return buildResult("sageflow", session, state, session.memories, selected, reason, filters, candidates);
}

function buildResult(mode, session, state, recalled, selected, reason, filters, candidates = [selected]) {
  const uniqueCandidates = [...new Map(candidates.map((item) => [item.action_id, item])).values()];
  return {
    mode,
    recalled_memories: recalled,
    state,
    candidates: uniqueCandidates,
    selected_action: selected,
    decision: {
      decision_id: `dec_${session.scenario.id}_${mode}_${session.cursor}`,
      trigger_event_id: session.appliedEvents.at(-1)?.event_id ?? `initial_${session.scenario.id}`,
      state_id: state?.state_id ?? null,
      candidate_action_ids: uniqueCandidates.map((item) => item.action_id),
      selected_action_id: selected.action_id,
      selected_score: Number((selected.expected_user_value - selected.interruption_cost - selected.risk).toFixed(2)),
      policy_filters_applied: filters,
      decision_reason: reason,
      policy_version: mode === "sageflow" ? "proactive-policy-0.1" : `${mode}-comparison-0.1`,
      trace_id: session.appliedEvents.at(-1)?.trace_id ?? `trace_${session.scenario.id}`,
      recall_trace_id: session.recallBundle?.trace_id ?? null,
      matched_rule_ids: session.recallBundle?.matched_rules?.map((rule) => rule.memory_id) ?? []
    }
  };
}

export function evaluateModes(session) {
  return {
    baseline: baselineResult(session),
    memory: memoryResult(session),
    sageflow: sageFlowResult(session)
  };
}

export function applyFeedback(session, feedbackType, decisionId = "dec_current") {
  const now = `2026-08-25T${session.context.time}:30+08:00`;
  const event = {
    schema_version: "1.0",
    event_id: `feedback_${session.scenario.id}_${session.feedback.length + 1}`,
    event_type: `feedback.${feedbackType}`,
    user_id: "usr_001",
    trip_id: session.appliedEvents.at(-1)?.trip_id ?? "trip_simulation",
    occurred_at: now,
    recorded_at: now,
    source: { type: "user_interaction" },
    payload: { decision_id: decisionId },
    trace_id: `trace_${session.scenario.id}`
  };

  if (feedbackType === "action_accepted") {
    session.mutations.push({ operation: "REINFORCE", target_memory_id: "mem_photography", reason: "本次建议被接受，但只小幅强化相关证据。" });
  } else if (feedbackType === "action_rejected") {
    session.mutations.push({ operation: "NO_LONG_TERM_CHANGE", target_memory_id: null, reason: "只知道用户拒绝本次行动，原因未知。" });
  } else if (feedbackType === "action_ignored") {
    session.context.recentIgnored += 1;
    session.frequencyPolicy = "lower";
    session.mutations.push({ operation: "ADJUST_FREQUENCY", target_memory_id: "mem_low_interrupt", reason: "降低本次旅程的主动服务频率。" });
  } else if (feedbackType === "user_corrected") {
    const shortTerm = {
      memory_id: `mem_short_intent_${session.scenario.id}`,
      memory_type: "short_term",
      memory_tier: "short_term",
      memory_domain: "user",
      memory_kind: "semantic",
      user_id: "usr_001",
      statement: { subject: "user", predicate: "current_trip_pace", value: "high_energy" },
      scope: { domain: "travel", applies_when: [session.scenario.id] },
      confidence: 0.95,
      salience: 0.9,
      evidence_event_ids: [event.event_id],
      valid_from: now,
      last_confirmed_at: now,
      status: "active",
      sensitivity: "normal",
      version: 1,
      lineage_id: `mem_short_intent_${session.scenario.id}`,
      label: "本次旅行想多走走、保持较高探索强度"
    };
    session.memories.push(shortTerm);
    session.context.selfReportedEnergy = "high";
    session.context.currentIntent = "continue_outdoor";
    session.mutations.push({ operation: "CREATE", target_memory_id: shortTerm.memory_id, reason: "建立本次旅行短期意图，不覆盖长期节奏偏好。" });
  }

  session.feedback.push(event);
  return event;
}

export function evaluateScenario(scenario, catalog) {
  const session = runToEnd(createSession(scenario, catalog));
  const results = evaluateModes(session);
  const expected = scenario.expected;
  const recalledIds = results.sageflow.recalled_memories.map((m) => m.memory_id);
  const memoryPass = expected.recalled_memory_ids.every((id) => recalledIds.includes(id));
  const stateChecks = Object.entries(expected.state).map(([dimension, value]) => ({
    dimension,
    expected: value,
    actual: results.sageflow.state?.dimensions?.[dimension]?.value,
    pass: results.sageflow.state?.dimensions?.[dimension]?.value === value,
    hasEvidence: (results.sageflow.state?.dimensions?.[dimension]?.evidence_ids?.length ?? 0) > 0
  }));
  const decisionPass = expected.sageflow_action === results.sageflow.selected_action.action_type;
  const forbiddenPass = !expected.forbidden_actions.includes(results.sageflow.selected_action.action_type);
  const eventPass = session.appliedEvents.every(validateObservationEvent);

  const feedbackSession = runToEnd(createSession(scenario, catalog));
  applyFeedback(feedbackSession, "action_rejected");
  const feedbackPass = feedbackSession.mutations.every((m) => m.operation !== "WEAKEN" && m.operation !== "SUPERSEDE");

  return {
    scenario_id: scenario.id,
    title: scenario.title,
    mode_action: results.sageflow.selected_action.action_type,
    checks: {
      protocol: eventPass,
      memory: memoryPass,
      state: stateChecks.every((item) => item.pass && item.hasEvidence),
      decision: decisionPass && forbiddenPass,
      feedback: feedbackPass
    },
    state_checks: stateChecks,
    passed: eventPass && memoryPass && stateChecks.every((item) => item.pass && item.hasEvidence) && decisionPass && forbiddenPass && feedbackPass
  };
}

export function validateObservationEvent(event) {
  const required = ["schema_version", "event_id", "event_type", "user_id", "trip_id", "occurred_at", "recorded_at", "source", "payload", "trace_id"];
  return required.every((key) => event[key] !== undefined)
    && event.schema_version === "1.0"
    && Boolean(event.source?.type)
    && !Number.isNaN(Date.parse(event.occurred_at))
    && !Number.isNaN(Date.parse(event.recorded_at));
}

export function buildEvaluationReport(catalog) {
  const cases = catalog.scenarios.map((scenario) => evaluateScenario(scenario, catalog));
  const moduleKeys = ["protocol", "memory", "state", "decision", "feedback"];
  const modules = Object.fromEntries(moduleKeys.map((key) => {
    const passed = cases.filter((item) => item.checks[key]).length;
    return [key, { passed, total: cases.length, rate: passed / cases.length }];
  }));
  return { cases, modules, passed: cases.filter((item) => item.passed).length, total: cases.length };
}
