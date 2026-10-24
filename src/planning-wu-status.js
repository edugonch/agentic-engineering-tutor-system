// Shared, pure recognition of planning WU status. The first YAML envelope
// identifies the Harness artifact; an inner block can describe a DRAFT WU
// without promoting an UNKNOWN indexed authority to APPROVED.
export function isPlanningWuSource(content) {
  const blocks = [...String(content).matchAll(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/gm)]
  if (!blocks.length) return /^status: "(?:DRAFT|PROPOSED)"\s*$/m.test(content)
  const status = block => block.match(/^status:[ \t]*(.*?)[ \t]*$/m)?.[1]
    ?.trim().replace(/^["']|["']$/g, "")
  const outer = status(blocks[0][1])
  if (outer === "DRAFT" || outer === "PROPOSED") return true
  if (outer !== "APPROVED") return false
  return blocks.slice(1).some(block =>
    /^(?:DRAFT|PROPOSED)\s*\(planning;\s*non-executable\)$/i.test(status(block[1]) ?? ""))
}
