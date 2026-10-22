const isList = (value) => Array.isArray(value) && value.length > 0;

export function evaluateScope(scope = {}, request = {}, now) {
  for (const key of ["trips", "sessions", "days", "entities", "situations", "applies_when"]) {
    if (scope[key] !== undefined && !isList(scope[key])) return { allowed: false, reason_code: "SCOPE_UNRESOLVED" };
  }
  let constrained = false;
  let specificity = 0;
  const checkList = (values, actual) => {
    if (!isList(values)) return null;
    constrained = true;
    if (actual === undefined || actual === null) return "SCOPE_UNRESOLVED";
    if (!values.includes(actual)) return "OUT_OF_SCOPE";
    specificity += 1;
    return null;
  };
  for (const [values, actual] of [
    [scope.trips, request.trip_id],
    [scope.sessions, request.session_id],
    [scope.days, request.local_date],
    [scope.entities, request.entity_id]
  ]) {
    const failure = checkList(values, actual);
    if (failure) return { allowed: false, reason_code: failure };
  }
  if (isList(scope.situations)) {
    constrained = true;
    for (const condition of scope.situations) {
      const actual = request.situation?.[condition.field];
      if (actual === undefined) return { allowed: false, reason_code: "SCOPE_UNRESOLVED" };
    if (actual !== condition.value) return { allowed: false, reason_code: "OUT_OF_SCOPE" };
      specificity += 1;
    }
  }
  if (scope.time_window) {
    constrained = true;
    const start = Date.parse(scope.time_window.start);
    const end = Date.parse(scope.time_window.end);
    const current = Date.parse(now);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || !Number.isFinite(current)) {
      return { allowed: false, reason_code: "SCOPE_UNRESOLVED" };
    }
    if (current < start || current >= end) return { allowed: false, reason_code: "OUT_OF_SCOPE" };
    specificity += 1;
  }
  // Legacy OR-style tokens remain readable, but never succeed when their context is missing.
  if (isList(scope.applies_when) && !isList(scope.trips)) {
    constrained = true;
    const situation = request.situation ?? {};
    const matched = scope.applies_when.some((token) => token === request.trip_id
      || Object.values(situation).includes(token) || situation[token] === true);
    if (!matched) return { allowed: false, reason_code: Object.keys(situation).length || request.trip_id
      ? "OUT_OF_SCOPE" : "SCOPE_UNRESOLVED" };
    specificity += 1;
  }
  return { allowed: true, label: !constrained ? "global" : isList(scope.trips) || isList(scope.applies_when)
    && scope.applies_when.includes(request.trip_id) ? "current_trip" : "matched_situation",
  score: !constrained ? 0.8 : Math.min(1, 0.8 + specificity * 0.1) };
}
