const FIELDS = {
  should_remember: new Set(["yes", "no", "needs_confirmation"]),
  memory_tier: new Set(["short_term", "long_term", "none"]),
  memory_domain: new Set(["user", "relational", "shared", "none"]),
  memory_kind: new Set(["episodic", "semantic", "procedural", "none"]),
  faithful_to_evidence: new Set(["yes", "partly", "no"]),
  scope_correct: new Set(["yes", "no"]),
  sensitivity_correct: new Set(["yes", "no"])
};

function kappa(pairs, field) {
  if (!pairs.length) return null;
  const categories = [...FIELDS[field]];
  const observed = pairs.filter(([left, right]) => left.labels[field] === right.labels[field]).length / pairs.length;
  const expected = categories.reduce((sum, category) => {
    const leftRate = pairs.filter(([left]) => left.labels[field] === category).length / pairs.length;
    const rightRate = pairs.filter(([, right]) => right.labels[field] === category).length / pairs.length;
    return sum + leftRate * rightRate;
  }, 0);
  return expected === 1 ? (observed === 1 ? 1 : 0) : Number(((observed - expected) / (1 - expected)).toFixed(4));
}

export function evaluateHumanReviews(queue, reviewSets = []) {
  const queueIds = new Set();
  for (const item of queue) {
    if (!item.review_id || queueIds.has(item.review_id)) throw new Error(`Duplicate or missing review_id: ${item.review_id}`);
    queueIds.add(item.review_id);
  }
  const reviewerPerFile = [];
  const maps = reviewSets.map((reviews) => {
    const map = new Map();
    const fileReviewers = new Set();
    for (const review of reviews) {
      if (!queueIds.has(review.review_id)) throw new Error(`Unknown review_id: ${review.review_id}`);
      if (!review.reviewer) throw new Error(`Reviewer missing for ${review.review_id}`);
      if (map.has(review.review_id)) throw new Error(`Duplicate annotation: ${review.review_id}`);
      for (const [field, allowed] of Object.entries(FIELDS)) {
        if (!allowed.has(review.labels?.[field])) throw new Error(`Invalid ${field} for ${review.review_id}`);
      }
      fileReviewers.add(review.reviewer);
      map.set(review.review_id, review);
    }
    if (fileReviewers.size > 1) throw new Error("Each reviewer file must contain one reviewer identity");
    reviewerPerFile.push([...fileReviewers][0] ?? null);
    return map;
  });
  if (reviewSets.length > 2) throw new Error("Use two independent reviewer files; adjudication is a separate step");
  if (reviewSets.length === 2 && (!reviewerPerFile[0] || !reviewerPerFile[1]
    || reviewerPerFile[0] === reviewerPerFile[1])) throw new Error("Two independent reviewer identities are required");
  const paired = reviewSets.length === 2
    ? queue.flatMap((item) => maps[0].has(item.review_id) && maps[1].has(item.review_id)
      ? [[maps[0].get(item.review_id), maps[1].get(item.review_id)]] : []) : [];
  const disagreements = paired.filter(([left, right]) => Object.keys(FIELDS)
    .some((field) => left.labels[field] !== right.labels[field])).map(([left]) => left.review_id);
  return {
    status: paired.length === queue.length && queue.length > 0 && disagreements.length === 0 ? "dual_review_complete" : "needs_review",
    queued: queue.length,
    reviewer_files: reviewSets.length,
    paired: paired.length,
    coverage: queue.length ? paired.length / queue.length : 0,
    disagreements,
    agreement: Object.fromEntries(Object.keys(FIELDS).map((field) => [field, {
      exact: paired.length ? Number((paired.filter(([left, right]) => left.labels[field] === right.labels[field]).length / paired.length).toFixed(4)) : null,
      kappa: kappa(paired, field)
    }]))
  };
}
