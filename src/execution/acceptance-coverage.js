// Optional, versioned acceptance-to-check mapping. This is an advisory
// projection, not semantic proof or a new source of authority.
const identifier = value => typeof value === "string" && /^[A-Za-z0-9._:-]+$/.test(value);
const unique = values => new Set(values).size === values.length;
const scopedPath = path => typeof path === "string" && /^[A-Za-z0-9._/-]+$/.test(path) &&
  !path.startsWith("/") && path.split("/").every(part => part && part !== "." && part !== "..");

export function inspectAcceptanceCoverage(contract) {
  const coverage = contract?.acceptance_coverage;
  const checkIds = (contract?.commands ?? []).map(check => check.id);
  const setupIds = new Set((contract?.setup ?? []).map(check => check.id));
  const base = { declared_check_ids: checkIds, command_availability: "NOT_PROBED",
    required_programs: [...new Set([...(contract?.setup ?? []), ...(contract?.commands ?? [])].map(c => c.program))],
    declared_capabilities: contract?.capabilities ?? [],
    functional_acceptance_proven: false, capability_status: "NOT_OBSERVED",
    write_scope_status: "NOT_STRUCTURED", pending_product_decisions: "UNKNOWN" };
  if (coverage === undefined) {
    return { ...base, status: "COVERAGE_NOT_DEMONSTRATED", classification: "COVERAGE_NOT_DEMONSTRATED", mode: "LEGACY",
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
  // Scope is only assessed when a frozen source supplies BOTH sides of the
  // comparison explicitly; never infer permission boundaries from prose.
  let writeScopeStatus = "NOT_STRUCTURED";
  let pathsOutsideScope = [];
  if (Object.hasOwn(coverage, "write_scope")) {
    const scope = coverage.write_scope;
    if (!scope || !Array.isArray(scope.allowed_roots) || !scope.allowed_roots.length ||
        !Array.isArray(scope.required_paths) || !scope.required_paths.length ||
        ![...scope.allowed_roots, ...scope.required_paths].every(scopedPath)) {
      return { ...base, status: "INVALID_ACCEPTANCE_COVERAGE", mode: coverage.mode,
        reason: "write_scope requires explicit safe allowed_roots and required_paths",
        blocking: true, missing_criteria: missing, invalid_mappings: invalid };
    }
    pathsOutsideScope = scope.required_paths.filter(path =>
      !scope.allowed_roots.some(root => path === root || path.startsWith(root + "/")));
    writeScopeStatus = pathsOutsideScope.length ? "WRITE_SCOPE_CONFLICT" : "WITHIN_DECLARED_SCOPE";
  }
  const incomplete = missing.length > 0 || invalid.length > 0;
  const required = coverage.mode === "REQUIRED";
  const status = writeScopeStatus === "WRITE_SCOPE_CONFLICT"
    ? "WRITE_SCOPE_CONFLICT"
    : incomplete
      ? required ? "REQUIRED_CHECK_UNMAPPED" : "COVERAGE_NOT_DEMONSTRATED"
      : "DECLARED_MAPPING_COMPLETE_NOT_SEMANTICALLY_VERIFIED";
  return { ...base, mode: coverage.mode, schema_version: 1, declared_criteria: criteria,
    missing_criteria: missing, invalid_mappings: invalid,
    write_scope_status: writeScopeStatus, paths_outside_scope: pathsOutsideScope,
    classification: status === "WRITE_SCOPE_CONFLICT" || status === "REQUIRED_CHECK_UNMAPPED"
      ? "CONTRACT_VIOLATION" : status === "COVERAGE_NOT_DEMONSTRATED"
        ? "COVERAGE_NOT_DEMONSTRATED" : "MAPPING_ONLY",
    blocking: writeScopeStatus === "WRITE_SCOPE_CONFLICT" || required && incomplete,
    status };
}
