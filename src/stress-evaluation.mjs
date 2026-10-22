import { replayDecisionScenario } from "./decision-cycle-evaluation.mjs";

export async function runStressEvaluation(catalog, suite) {
  const scenarios = new Map(catalog.scenarios.map((item) => [item.id, item]));
  const cases = [];
  for (const item of suite.cases) {
    const scenario = scenarios.get(item.base_scenario_id);
    if (!scenario) throw new Error(`Unknown stress scenario: ${item.base_scenario_id}`);
    const { result } = await replayDecisionScenario(scenario, catalog, {
      removeMemoryIds: item.remove_memory_ids,
      memoryOverrides: item.memory_overrides,
      contextPatch: item.context_patch,
      permissions: item.permissions
    });
    const selected = result.modes.sageflow.selected_action.action_type;
    const state = result.modes.sageflow.state.dimensions;
    const recalled = new Set(result.recall.memories.map((hit) => hit.memory.memory_id));
    const checks = {
      action: selected === item.expected_action,
      forbidden: !(item.forbidden_actions ?? []).includes(selected),
      state: Object.entries(item.expected_state ?? {}).every(([key, value]) => state[key]?.value === value)
        && (item.absent_state ?? []).every((key) => !state[key]),
      memory: (item.must_include ?? []).every((id) => recalled.has(id))
        && (item.must_exclude ?? []).every((id) => !recalled.has(id)),
      omission: !item.omitted_reason || result.recall.omitted.some((omitted) => omitted.reason_code === item.omitted_reason),
      audit: result.audit.passed
    };
    cases.push({ id: item.id, title: item.title, selected_action: selected, checks,
      passed: Object.values(checks).every(Boolean) });
  }
  return { suite_version: suite.suite_version, disclaimer: suite.disclaimer,
    passed: cases.filter((item) => item.passed).length, total: cases.length, cases };
}
