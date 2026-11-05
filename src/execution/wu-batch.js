// Explicit, opt-in grouped delivery of consecutive frozen Work Units.
// A batch shares ONE candidate/verification/review/merge, but retains exact
// frozen membership and source provenance for each WU. No silent mode change.
import { sha256, stableHash } from "./serialize.js"
import { isPlanningWuSource } from "../planning-wu-status.js"
import { MANDATE_AUTHORITY } from "./constants.js"

export const MAX_WU_BATCH_SIZE = 10

const sameIds = (left, right) =>
  Array.isArray(left) && Array.isArray(right) &&
  left.length === right.length && left.every((id, i) => id === right[i])

const hasAcceptance = content =>
  /(?:salida comprobable|acceptance criteria|original acceptance|accept:)/i.test(content)
const hasScope = content =>
  /(?:expected write scope|bounded scope|scope:|fuera de alcance)/i.test(content)
const needsTdd = content => /\bTDD\s*(?:required|obligatorio)\b/i.test(content)

export function batchHash({ wu_ids, members, lead_contract_hash }) {
  return stableHash({ wu_ids, members, lead_contract_hash })
}

export function assertBatchConfiguration(state, body) {
  if (state.completed || state.blocker || state.mandate?.authority_kind !== MANDATE_AUTHORITY.OWNER_APPROVED_EPIC ||
      !state.wu || state.wu.completed || !state.wu.contract || state.wu.contract.normalization_required) {
    throw new Error("WU_BATCH_CONFIGURE requires one active executable WU and an unblocked owner-approved Epic")
  }
  if (state.wu.batch) throw new Error("WU_BATCH_CONFIGURE: an active batch is already frozen")
  if (body.owner_confirmed !== true || typeof body.authorization_ref !== "string" || !body.authorization_ref.trim()) {
    throw new Error("WU_BATCH_CONFIGURE requires explicit owner confirmation and authority reference")
  }
  if (!Array.isArray(body.wu_ids) || body.wu_ids.length < 2 || body.wu_ids.length > MAX_WU_BATCH_SIZE ||
      new Set(body.wu_ids).size !== body.wu_ids.length ||
      body.wu_ids.some(id => typeof id !== "string" || !id.trim())) {
    throw new Error("WU_BATCH_CONFIGURE requires 2 to 10 unique ordered Work Units")
  }
  const sequence = state.mandate.wu_sequence ?? []
  const leadIndex = state.activated_wu_ids.length - 1
  if (leadIndex < 0 || sequence[leadIndex] !== state.wu.wu_id ||
      !sameIds(body.wu_ids, sequence.slice(leadIndex, leadIndex + body.wu_ids.length)) ||
      body.wu_ids[0] !== state.wu.wu_id) {
    throw new Error("WU_BATCH_CONFIGURE may group only consecutive frozen WUs starting at the active WU")
  }
  // Do not transform work that was already handed to a builder/candidate/reviewer.
  if (state.budget.active_phase || state.verification_phase || state.external_wait ||
      Object.values(state.candidates).some(candidate => candidate.wu_id === state.wu.wu_id) ||
      Object.values(state.dispatches).some(dispatch => dispatch.wu_id === state.wu.wu_id)) {
    throw new Error("WU_BATCH_CONFIGURE requires the lead WU to have no started work or frozen candidate")
  }
  if (!Array.isArray(body.members) || body.members.length !== body.wu_ids.length ||
      !body.members.every((member, i) => {
        if (!member || member.wu_id !== body.wu_ids[i] ||
            typeof member.source_record_key !== "string" || !member.source_record_key ||
            typeof member.source_content !== "string" ||
            sha256(member.source_content) !== member.source_hash) return false
        if (!hasAcceptance(member.source_content) || !hasScope(member.source_content)) return false
        if (i === 0) {
          return member.source_record_key === state.wu.contract.source_record_key &&
            member.source_hash === state.wu.contract.source_hash &&
            member.source_content === state.wu.contract.source_content
        }
        return isPlanningWuSource(member.source_content) &&
          !/^execution_contract: /m.test(member.source_content)
      })) {
    throw new Error("WU_BATCH_CONFIGURE: every WU needs an exact hash-bound source, acceptance criteria and scope")
  }
  if (body.members.some(member => needsTdd(member.source_content)) &&
      !state.wu.contract.process_obligations?.some(obligation => obligation?.kind === "tdd" && obligation.required === true)) {
    throw new Error("WU_BATCH_CONFIGURE cannot discard a member's mandatory TDD process obligation")
  }
  if (body.lead_contract_hash !== state.wu.contract.contract_hash ||
      body.batch_hash !== batchHash(body)) {
    throw new Error("WU_BATCH_CONFIGURE: aggregate contract hash or lead contract changed")
  }
}

export function requireBatchCoverage(batch, ids, label = "Batch review") {
  if (!batch) return
  if (!sameIds(ids, batch.wu_ids)) {
    throw new Error(`${label} must explicitly cover every ordered member of the frozen WU batch`)
  }
}
