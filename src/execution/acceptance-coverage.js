// Optional, versioned acceptance-to-check mapping. This is an advisory
// projection, not semantic proof or a new source of authority.
const identifier = value => typeof value === "string" && /^[A-Za-z0-9._:-]+$/.test(value);
const unique = values => new Set(values).size === values.length;

export function inspectAcceptanceCoverage(contract) {
  const coverage = contract?.acceptance_coverage;
  const checkIds = (contract?.commands ?? []).map(check => check.id);
  const setupIds = new Set((contract?.setup ?? []).map(check => check.id));
  const base = { declared_check_ids: checkIds, command_availability: "NOT_PROBED",
    functional_acceptance_proven: false, capability_status: "NOT_OBSERVED",
    write_scope_status: "NOT_STRUCTURED", pending_product_decisions: "UNKNOWN" };
  if (coverage === undefined) {
    return { ...base, status: "COVERAGE_NOT_DEMONSTRATED", mode: "LEGACY",
      missing_criteria: [], invalid_mappings: [], blocking: false };
  }
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage) ||
      coverage.schema_version !== 1 || !["ADVISORY", "REQUIRED"].includes(coverage.mode) ||
      !Array.isArray(coverage.criteria) || !coverage.criteria.every(identifier) ||
      !unique(coverage.criteria) || !coverage.check_mapping ||
      typeof coverage.check_mapping !== "object" || Array.isArray(coverage.check_mapping)) {
    return { ...base, status: "INVALID_ACCEPTANCE_COVERAGE", mode: coverage?.mode ?? "UNKNOWN",
      reason: "acceptance_coverage must contain schema_version=1, mode, unique criteria IDs and check_mapping",
      blocking: true, missing_criteria: [], invalid_mappings: [] };
  }
  const criteria = coverage.criteria;
  const mapping = coverage.check_mapping;
  const missing = criteria.filter(id => !Array.isArray(mapping[id]) || mapping[id].length === 0);
  const invalid = Object.entries(mapping).flatMap(([criterion, ids]) => {
    if (!criteria.includes(criterion)) return [{ criterion, reason: "UNDECLARED_CRITERION" }];
    if (!Array.isArray(ids) || !ids.length || !ids.every(identifier) || !unique(ids)) {
      return [{ criterion, reason: "INVALID_CHECK_MAPPING" }];
    }
    return ids.filter(id => !checkIds.includes(id)).map(check_id => ({
      criterion, check_id, reason: setupIds.has(check_id) ? "SETUP_IS_NOT_A_CHECK" : "UNDECLARED_CHECK",
    }));
  });
  const incomplete = missing.length > 0 || invalid.length > 0;
  const required = coverage.mode === "REQUIRED";
  return { ...base, mode: coverage.mode, schema_version: 1, declared_criteria: criteria,
    missing_criteria: missing, invalid_mappings: invalid, blocking: required && incomplete,
    status: incomplete
      ? required ? "REQUIRED_CHECK_UNMAPPED" : "COVERAGE_NOT_DEMONSTRATED"
      : "DECLARED_MAPPING_COMPLETE_NOT_SEMANTICALLY_VERIFIED" };
}
