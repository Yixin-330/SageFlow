const REGISTRY = Object.freeze({
  prefers_travel_pace: { cardinality: "single", value_type: "string" },
  current_trip_pace: { cardinality: "single", value_type: "string" },
  comfortable_activity_budget_cny: { cardinality: "single", value_type: "number" },
  prefers_notification_frequency: { cardinality: "single", value_type: "string" },
  prefers_activity_load: { cardinality: "single", value_type: "string" },
  health_constraint: { cardinality: "multi", value_type: "string" },
  service_policy: { cardinality: "multi", value_type: "object" },
  likes_experience: { cardinality: "multi", value_type: "string" }
});

export function predicatePolicy(predicate) {
  return REGISTRY[predicate] ?? { cardinality: "unknown", value_type: "unknown" };
}

export function validPredicateValue(predicate, value) {
  const type = predicatePolicy(predicate).value_type;
  if (type === "unknown") return true;
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === type;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, stable(value[key])]));
  return value;
}

export function sameValue(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

const setOf = (value) => Array.isArray(value) && value.length ? new Set(value) : null;
const isSubset = (left, right) => [...left].every((item) => right.has(item));

export function normalizeScope(scope = {}) {
  const normalized = structuredClone(scope);
  for (const key of ["trips", "sessions", "days", "entities", "applies_when"]) {
    if (Array.isArray(normalized[key])) normalized[key] = [...new Set(normalized[key])].sort();
  }
  if (Array.isArray(normalized.situations)) normalized.situations.sort((a, b) =>
    `${a.field}:${JSON.stringify(stable(a.value))}`.localeCompare(`${b.field}:${JSON.stringify(stable(b.value))}`));
  return normalized;
}

function listRelation(left, right) {
  const a = setOf(left);
  const b = setOf(right);
  if (!a && !b) return "equal";
  if (!a) return "a_covers_b";
  if (!b) return "b_covers_a";
  if (![...a].some((item) => b.has(item))) return "disjoint";
  if (isSubset(a, b) && isSubset(b, a)) return "equal";
  if (isSubset(b, a)) return "a_covers_b";
  if (isSubset(a, b)) return "b_covers_a";
  return "overlap";
}

function situationRelation(left, right) {
  const a = new Map((left ?? []).map((item) => [item.field, JSON.stringify(stable(item.value))]));
  const b = new Map((right ?? []).map((item) => [item.field, JSON.stringify(stable(item.value))]));
  if ([...a].some(([field, value]) => b.has(field) && b.get(field) !== value)) return "disjoint";
  const aInB = [...a].every(([field, value]) => b.get(field) === value);
  const bInA = [...b].every(([field, value]) => a.get(field) === value);
  if (aInB && bInA) return "equal";
  if (aInB) return "a_covers_b";
  if (bInA) return "b_covers_a";
  return "overlap";
}

function windowRelation(left, right) {
  if (!left && !right) return "equal";
  if (!left) return "a_covers_b";
  if (!right) return "b_covers_a";
  const aStart = Date.parse(left.start);
  const aEnd = Date.parse(left.end);
  const bStart = Date.parse(right.start);
  const bEnd = Date.parse(right.end);
  if ([aStart, aEnd, bStart, bEnd].some((item) => !Number.isFinite(item))) return "unknown";
  if (aEnd <= bStart || bEnd <= aStart) return "disjoint";
  if (aStart === bStart && aEnd === bEnd) return "equal";
  if (aStart <= bStart && aEnd >= bEnd) return "a_covers_b";
  if (bStart <= aStart && bEnd >= aEnd) return "b_covers_a";
  return "overlap";
}

export function scopeRelation(left = {}, right = {}) {
  if (left.domain !== right.domain) return "disjoint";
  if (left.topic && right.topic && left.topic !== right.topic) return "unknown";
  const leftTyped = ["trips", "sessions", "days", "entities", "situations", "time_window"].some((key) => left[key]);
  const rightTyped = ["trips", "sessions", "days", "entities", "situations", "time_window"].some((key) => right[key]);
  const leftLegacy = !leftTyped && setOf(left.applies_when);
  const rightLegacy = !rightTyped && setOf(right.applies_when);
  if (leftLegacy || rightLegacy) {
    if (leftLegacy && rightLegacy) {
      const a = [...leftLegacy].sort();
      const b = [...rightLegacy].sort();
      return JSON.stringify(a) === JSON.stringify(b) ? "equal" : "unknown";
    }
    if (leftLegacy && rightTyped) return "unknown";
    if (rightLegacy && leftTyped) return "unknown";
    return leftLegacy ? "b_covers_a" : "a_covers_b";
  }
  const relations = [
    listRelation(left.trips, right.trips),
    listRelation(left.sessions, right.sessions),
    listRelation(left.days, right.days),
    listRelation(left.entities, right.entities),
    situationRelation(left.situations, right.situations),
    windowRelation(left.time_window, right.time_window)
  ];
  if (relations.includes("disjoint")) return "disjoint";
  if (relations.includes("unknown")) return "unknown";
  if (relations.every((item) => item === "equal")) return "equal";
  if (relations.every((item) => item === "equal" || item === "a_covers_b")) return "a_covers_b";
  if (relations.every((item) => item === "equal" || item === "b_covers_a")) return "b_covers_a";
  return "overlap";
}

export function sameSubjectPredicate(left, right) {
  return left.statement?.subject === right.statement?.subject
    && left.statement?.predicate === right.statement?.predicate
    && left.memory_domain === right.memory_domain
    && left.memory_kind === right.memory_kind
    && left.scope?.domain === right.scope?.domain;
}

export function conflictRelation(left, right) {
  if (!sameSubjectPredicate(left, right) || sameValue(left.statement.value, right.statement.value)) return "none";
  if (predicatePolicy(left.statement.predicate).cardinality !== "single") return "none";
  return scopeRelation(left.scope, right.scope);
}
