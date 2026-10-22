import { createSession, advanceSession, applyFeedback, validateObservationEvent } from "./engine.mjs";
import { createDecisionCycle } from "./decision-cycle.mjs";
import { createMemoryEngine } from "./memory-engine/memory-engine.mjs";
import { createInMemoryMemoryRepository } from "./memory-engine/adapters/in-memory-repository.mjs";
import { createDeterministicExtractor } from "./memory-engine/adapters/deterministic-extractor.mjs";

export async function replayDecisionScenario(scenario, catalog, {
  removeMemoryIds = [], extraMemories = [], memoryOverrides = {}, contextPatch = {}, permissions = []
} = {}) {
  const session = createSession(scenario, catalog);
  session.memories = session.memories.filter((memory) => !removeMemoryIds.includes(memory.memory_id))
    .map((memory) => ({ ...memory, ...structuredClone(memoryOverrides[memory.memory_id] ?? {}) }));
  const repository = createInMemoryMemoryRepository([...session.memories, ...extraMemories]);
  const memoryEngine = createMemoryEngine({ repository, extractor: createDeterministicExtractor(),
    clock: { now: () => `2026-08-25T${session.context.time}:00+08:00` } });
  for (const event of scenario.timeline) {
    advanceSession(session);
    await memoryEngine.observe([event]);
  }
  session.context = { ...session.context, ...contextPatch };
  const cycle = createDecisionCycle({ memoryEngine });
  return { session, repository, memoryEngine, cycle, result: await cycle.evaluate(session, { permissions }) };
}

export async function runDecisionCycleEvaluation(catalog) {
  const cases = [];
  for (const scenario of catalog.scenarios) {
    const run = await replayDecisionScenario(scenario, catalog);
    const { recall, modes, audit } = run.result;
    const recalled = new Set(modes.sageflow.recalled_memories.map((memory) => memory.memory_id));
    const stateChecks = Object.entries(scenario.expected.state).map(([dimension, expected]) => {
      const actual = modes.sageflow.state?.dimensions?.[dimension];
      return actual?.value === expected && actual.evidence_ids?.length > 0;
    });
    const feedbackEvent = applyFeedback(run.session, "action_rejected", modes.sageflow.decision.decision_id);
    const feedback = await run.memoryEngine.observe([feedbackEvent]);
    const checks = {
      protocol: scenario.timeline.every(validateObservationEvent),
      memory: scenario.expected.recalled_memory_ids.every((id) => recalled.has(id)),
      state: stateChecks.every(Boolean),
      decision: modes.sageflow.selected_action.action_type === scenario.expected.sageflow_action
        && !scenario.expected.forbidden_actions.includes(modes.sageflow.selected_action.action_type),
      trace: modes.sageflow.decision.recall_trace_id === recall.trace_id,
      audit: audit.passed,
      feedback: feedback.mutations.every((item) => item.operation !== "WEAKEN" && item.operation !== "SUPERSEDE")
    };
    cases.push({ id: scenario.id, scenario_id: scenario.id, title: scenario.title,
      checks, passed: Object.values(checks).every(Boolean),
      selected_action: modes.sageflow.selected_action.action_type,
      recalled_memory_ids: [...recalled] });
  }

  const budgetScenario = catalog.scenarios.find((scenario) => scenario.id === "S06");
  const budgetPresent = await replayDecisionScenario(budgetScenario, catalog);
  const budgetAbsent = await replayDecisionScenario(budgetScenario, catalog, { removeMemoryIds: ["mem_budget_150"] });
  const budgetPass = budgetPresent.result.modes.sageflow.state.dimensions.budget_pressure?.value === "high"
    && !budgetAbsent.result.modes.sageflow.state.dimensions.budget_pressure
    && budgetPresent.result.modes.sageflow.selected_action.action_type !== budgetAbsent.result.modes.sageflow.selected_action.action_type;

  const source = catalog.memory_catalog.find((memory) => memory.memory_id === "mem_photography");
  const rule = { ...structuredClone(source), memory_id: "mem_eval_silence", memory_domain: "relational",
    memory_kind: "procedural", statement: { subject: "sageflow", predicate: "service_policy",
      value: { conditions: [{ field: "weather", value: "rain" }], service_policy: { action: "remain_silent" } } },
    scope: { domain: "proactive_service" } };
  const policyMatched = await replayDecisionScenario(budgetScenario, catalog, { extraMemories: [rule] });
  const policyPass = policyMatched.result.recall.matched_rules.some((item) => item.memory_id === rule.memory_id)
    && policyMatched.result.modes.sageflow.selected_action.action_type === "remain_silent";

  const silenceCases = cases.filter((item) => catalog.scenarios.find((scenario) => scenario.id === item.id)?.expected.sageflow_action === "remain_silent");
  const moduleKeys = ["protocol", "memory", "state", "decision", "trace", "audit", "feedback"];
  const modules = Object.fromEntries(moduleKeys.map((key) => {
    const passed = cases.filter((item) => item.checks[key]).length;
    return [key, { passed, total: cases.length, rate: passed / cases.length }];
  }));
  return {
    disclaimer: "确定性模拟闭环评测；不是用户实验或真实服务质量指标。",
    cases,
    modules,
    passed: cases.filter((item) => item.passed).length,
    total: cases.length,
    metrics: {
      scenario_pass: cases.filter((item) => item.passed).length,
      scenario_total: cases.length,
      silence_accuracy: silenceCases.length ? silenceCases.filter((item) => item.selected_action === "remain_silent").length / silenceCases.length : 0,
      trace_coverage: cases.filter((item) => item.checks.trace).length / cases.length,
      audit_coverage: cases.filter((item) => item.checks.audit).length / cases.length,
      feedback_safety: cases.filter((item) => item.checks.feedback).length / cases.length,
      counterfactual_pass: Number(budgetPass) + Number(policyPass),
      counterfactual_total: 2
    },
    counterfactuals: [
      { id: "budget_memory_removed", passed: budgetPass },
      { id: "service_rule_added", passed: policyPass }
    ]
  };
}
