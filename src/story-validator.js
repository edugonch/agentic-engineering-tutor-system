import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve, sep } from "node:path"

const REQUIRED = {
  epic: [
    ["chapter purpose", /## Chapter purpose/i],
    ["start condition", /## Start condition/i],
    ["user-visible outcome", /## User-visible outcome/i],
    ["terminal demo", /## Terminal demo and acceptance/i],
    ["finite WU budget", /## Approved WU budget/i],
    ["WU sequence", /## Work Unit sequence/i],
    ["out-of-scope boundary", /## Out of scope/i],
  ],
  wu: [
    ["story connection", /## Story and Epic connection/i],
    ["one outcome", /## Single outcome/i],
    ["acceptance criteria", /## Acceptance criteria/i],
    ["scope boundary", /## Boundaries/i],
    ["dependencies", /## Dependencies/i],
    ["child WU prohibition", /CHILD_WORK_UNITS_ALLOWED:\s*NO/],
    ["stop condition", /## Stop condition/i],
  ],
}

export async function validateStoryFile(projectRoot, documentPath, documentType) {
  const root = resolve(projectRoot)
  if (isAbsolute(documentPath)) throw new Error("document_path must be relative to the project root.")
  const file = resolve(root, documentPath)
  const rel = relative(root, file)
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("document_path escapes the project root.")
  if (!(documentType in REQUIRED)) throw new Error('document_type must be "epic" or "wu".')

  const content = await readFile(file, "utf8")
  const missing = REQUIRED[documentType].filter(([, pattern]) => !pattern.test(content)).map(([label]) => label)
  const invalid = []
  const warnings = []
  if (documentType === "epic") {
    const maxCount = content.match(/^\s*-\s*Maximum WU count:\s*(\d+)\s*$/im)
    if (!maxCount || Number(maxCount[1]) < 1) invalid.push("Maximum WU count must be a positive integer approved for this Epic.")

    const approval = content.match(/^\s*-\s*Approval reference:\s*(.*?)\s*$/im)?.[1]
    if (!isConcreteValue(approval)) invalid.push("Epic WU budget needs a concrete owner-approved decision reference.")

    for (const field of ["Demo scenario", "Acceptance evidence", "End condition"]) {
      const value = content.match(new RegExp(`^\\s*-\\s*${field}:\\s*(.*?)\\s*$`, "im"))?.[1]
      if (!isConcreteValue(value)) invalid.push(`${field} must contain a concrete, non-placeholder value.`)
    }

    if (maxCount) {
      const plannedWus = content.split(/\r?\n/).filter((line) => /^\|\s*\d+\s*\|\s*(?!\[WU ID\])[^|]+\|/i.test(line)).length
      if (plannedWus > Number(maxCount[1])) invalid.push(`Work Unit sequence has ${plannedWus} entries, exceeding the approved maximum of ${maxCount[1]}.`)
    }
    if (/TBD|TODO|\[OWNER INPUT REQUIRED\]/i.test(content)) warnings.push("The Epic still contains unresolved placeholders outside the validated budget and terminal-outcome fields.")
  }
  if (documentType === "wu" && !/one coherent outcome|single outcome|indivisible outcome/i.test(content)) warnings.push("Confirm explicitly that the WU is indivisible and represents one coherent outcome.")
  if (documentType === "wu") {
    const activeTime = content.match(/^\s*-\s*Active-time limit:\s*(.*?)\s*$/im)?.[1]
    const approval = content.match(/^\s*-\s*Approval reference:\s*(.*?)\s*$/im)?.[1]
    if (!isConcreteValue(activeTime)) invalid.push("WU needs a concrete, owner-approved active-time limit.")
    if (!isConcreteValue(approval)) invalid.push("WU execution budget needs a concrete owner-approved decision reference.")
  }
  const recursiveLines = content.split(/\r?\n/).filter((line) =>
    /create (a )?(child|successor|follow-up) (work unit|wu)|spawn (a )?new wu/i.test(line)
      && !/\b(do not|don't|never|cannot|must not|prohibit|forbid)\b/i.test(line),
  )
  if (recursiveLines.length) warnings.push("Possible instruction to create recursive or automatic follow-up work; review this contract.")

  return {
    status: missing.length || invalid.length ? "FAIL" : warnings.length ? "PASS_WITH_WARNINGS" : "PASS",
    document: documentPath,
    type: documentType,
    missing_required_sections: missing,
    invalid_fields: invalid,
    warnings,
    note: "Structural validation cannot approve product scope, user value, or authority. Owner review remains required.",
  }
}

function isConcreteValue(value) {
  if (!value) return false
  const normalized = value.trim()
  return normalized.length > 0
    && !/^\[[^\]]*\]$/.test(normalized)
    && !/^(?:TBD|TODO|PENDING|text|none|n\/a|owner input required)$/i.test(normalized)
}
