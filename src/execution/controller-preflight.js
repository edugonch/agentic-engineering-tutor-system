// Validate unambiguous tool arguments before acquiring leases or touching the durable controller.
// Keep this check limited to public shape errors; authority/state checks remain in the controller.
export function validateControllerPreflight(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Controller input must be an object.")
  }
  const action = input.action ?? "status"
  if (action !== "correct_verification_contract") return
  const nonempty = (value) => typeof value === "string" && value.trim().length > 0
  if (!nonempty(input.wu_artifact_id)) {
    throw new Error("correct_verification_contract requires wu_artifact_id: the exact approved WU artifact ID or record key. decision_artifact_id is not accepted for this action.")
  }
  if (typeof input.expected_contract_hash !== "string" || !/^[a-f0-9]{64}$/.test(input.expected_contract_hash)) {
    throw new Error("correct_verification_contract requires expected_contract_hash: the 64-character lowercase SHA-256 hash of the active compiled WU contract.")
  }
  if (!nonempty(input.reason)) {
    throw new Error("correct_verification_contract requires reason: a non-empty explanation of the authorized verification-only correction.")
  }
  if (input.check_mapping !== undefined) {
    const mapping = input.check_mapping
    if (mapping === null || typeof mapping !== "object" || Array.isArray(mapping) ||
      !Object.values(mapping).every(ids => Array.isArray(ids) && ids.length > 0 && ids.every(nonempty))) {
      throw new Error("correct_verification_contract check_mapping must map each old check ID to a non-empty array of new check IDs.")
    }
  }
}
