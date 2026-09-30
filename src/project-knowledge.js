import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

const INDEX_PATH = ".harness/knowledge/index.json"
const INDEX_LOCK_PATH = ".harness/knowledge/index.lock"
const INDEX_LOCK_TIMEOUT_MS = 15000
const MAX_SCAN_DEPTH = 10
const MAX_SCANNED_FILES = 12000
const MAX_IMPORTED_FILES = 3000
const MAX_IMPORTED_BYTES = 200 * 1024 * 1024
const MAX_SINGLE_FILE_BYTES = 30 * 1024 * 1024
const MAX_EXTERNAL_SOURCE_BYTES = 1 * 1024 * 1024
const MAX_SEARCH_RESULTS = 10
const MAX_ARTIFACT_BYTES = 512 * 1024
const MAX_INDEX_BYTES = 8 * 1024 * 1024
const ARCHIVE_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".csv",
  ".html", ".htm", ".xml", ".pdf", ".doc", ".docx", ".odt", ".rtf", ".xls", ".xlsx",
  ".ppt", ".pptx", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg",
])
const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".csv",
  ".html", ".htm", ".xml", ".svg",
])
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "vendor", "dist", "build", "coverage", "target",
  ".next", ".nuxt", ".turbo", ".cache", ".venv", "venv", "Pods", "tmp", "log",
])
const KNOWLEDGE_PATH = /(^|\/)(docs?|governance|research|requirements?|specs?|epics?|work[-_ ]?units?|decisions?|adrs?|skills|\.harness|\.opencode\/skills|\.github\/ISSUE_TEMPLATE)(\/|$)/i
const ROOT_KNOWLEDGE_FILE = /^(README|AGENTS|CLAUDE|CONTRIBUTING|ARCHITECTURE|PROJECT_STORY|PROJECT_CHARTER|PROJECT_STATE|DECISIONS|CHANGELOG)(\.[^.]+)+$/i
const CLASSIFICATIONS = new Set([
  "PROJECT_STATE", "GOVERNANCE_RULE", "APPROVED_DECISION", "REQUIREMENT", "SPECIFICATION",
  "EPIC", "USER_STORY", "WORK_UNIT", "RAW_RESEARCH", "RESEARCH_COMPENDIUM", "RESEARCH_SYNTHESIS",
  "DESIGN_HANDOFF", "REFERENCE", "OTHER",
])
const DECLARED_AUTHORITIES = new Set(["CANONICAL", "APPROVED", "DERIVED", "RAW", "HISTORICAL", "UNKNOWN"])
const KNOWLEDGE_DISPOSITIONS = new Set(["UNASSESSED", "APPLIED", "NOT_APPLIED", "TANGENTIAL", "DISCARDED", "DEFERRED", "SUPERSEDED"])
const ARTIFACT_TYPES = new Set([
  "raw-research", "research-compendium", "research-synthesis", "requirement", "specification",
  "user-story", "epic", "work-unit", "decision", "rule",
])
const ARTIFACT_STATUSES = new Set(["RAW", "DRAFT", "PROPOSED", "APPROVED", "REJECTED", "SUPERSEDED"])

const sha256 = (value) => createHash("sha256").update(value).digest("hex")
const safeId = (value) => /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,180}$/.test(String(value ?? ""))
const inside = (root, path) => {
  const rel = relative(root, path)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function assertRoot(root) {
  if (!root || !isAbsolute(root)) throw new Error("OpenCode did not provide an absolute project root.")
  return resolve(root)
}

export function classifyKnowledgePath(path) {
  const normalized = String(path).replaceAll("\\", "/")
  const lower = normalized.toLowerCase()
  const name = lower.split("/").at(-1) ?? ""
  if (/(^|\/)(project_state|project-state)(\.[^/]+)?$/.test(lower)) return "PROJECT_STATE"
  if (/(^|\/)(project_story|project-story|epic_story|epic-story|project_charter|project-charter)(\.[^/]+)?$/.test(lower)) return "GOVERNANCE_RULE"
  if (/compendium|compendio|compilation|compilaci.n|synthesis|sintesis|evidence-review|benchmark/.test(name)) return "RESEARCH_COMPENDIUM"
  if (/(^|\/)(research|investigation|investigations|investigacion|investigaciones)(\/raw|\/sources?)(\/|$)/.test(lower)) return "RAW_RESEARCH"
  if (/(^|\/)(research|investigation|investigations|investigacion|investigaciones)(\/|$)/.test(lower) || /research|investigation|investigacion/.test(name)) return "RESEARCH_SYNTHESIS"
  if (/(^|\/)(decisions?|adrs?)(\/|$)/.test(lower) || /^(adr|decision)[-_ ]/.test(name)) return "APPROVED_DECISION"
  if (/^agents?\.md$/.test(name) || /(^|\/)(polic(y|ies)|rules?|governance|skills)(\/|$)/.test(lower) || /-skill\.md$/.test(name)) return "GOVERNANCE_RULE"
  if (/(^|\/)(requirements?)(\/|$)/.test(lower) || /requirement|product-requirement|^req[-_ ]/.test(name)) return "REQUIREMENT"
  if (/(^|\/)(specs?|specifications?|contracts?)(\/|$)/.test(lower) || /(^|[-_. ])(spec|specification|contract)([-_. ]|$)/.test(name)) return "SPECIFICATION"
  if (/(^|\/)(epics?)(\/|$)/.test(lower) || /^epic[-_ ]/.test(name)) return "EPIC"
  if (/(^|\/)(user[-_ ]?stories)(\/|$)/.test(lower) || /(^|[-_. ])(user[-_ ]?story|story)([-_. ]|$)/.test(name)) return "USER_STORY"
  if (/(^|\/)(work[-_ ]?units?)(\/|$)/.test(lower) || /(^|[-_. ])wu([-_. ]|$)/.test(name)) return "WORK_UNIT"
  if (/(^|\/)(design|designs|handoffs?)(\/|$)/.test(lower) || /design-handoff/.test(name)) return "DESIGN_HANDOFF"
  if (normalized.split("/").length === 1 && ROOT_KNOWLEDGE_FILE.test(normalized)) return "GOVERNANCE_RULE"
  if (KNOWLEDGE_PATH.test(normalized) || normalized.split("/").length === 1) return "REFERENCE"
  return "OTHER"
}

export function isKnowledgePath(path) {
  const normalized = String(path).replaceAll("\\", "/")
  if (normalized.startsWith(".harness/knowledge/")) return false
  const extension = extname(normalized).toLowerCase()
  return (KNOWLEDGE_PATH.test(normalized) || (!normalized.includes("/") && ROOT_KNOWLEDGE_FILE.test(normalized)))
    && ARCHIVE_EXTENSIONS.has(extension)
}

async function walkKnowledgeFiles(root) {
  const found = []
  let scanned = 0
  let truncated = false

  async function visit(directory, depth) {
    if (depth > MAX_SCAN_DEPTH || scanned >= MAX_SCANNED_FILES) {
      truncated = true
      return
    }
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (["EACCES", "EPERM"].includes(error.code)) return
      throw error
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (scanned >= MAX_SCANNED_FILES) {
        truncated = true
        break
      }
      if (entry.isSymbolicLink()) continue
      const path = join(directory, entry.name)
      const rel = relative(root, path).replaceAll("\\", "/")
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(path, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      scanned += 1
      if (!isKnowledgePath(rel)) continue
      const info = await lstat(path)
      found.push({ path: rel, size_bytes: info.size, modified_at: info.mtime.toISOString(), classification: classifyKnowledgePath(rel) })
    }
  }

  await visit(root, 0)
  return { files: found, scanned, truncated }
}

export async function discoverProjectKnowledge(projectRoot) {
  const root = assertRoot(projectRoot)
  const result = await walkKnowledgeFiles(root)
  return {
    mode: "read-only-project-knowledge-discovery",
    project: root.split(sep).at(-1),
    scanned_files: result.scanned,
    scan_truncated: result.truncated,
    documents: result.files.slice(0, MAX_IMPORTED_FILES),
    documents_truncated: result.files.length > MAX_IMPORTED_FILES,
    counts_by_classification: Object.fromEntries(
      [...new Set(result.files.map((item) => item.classification))].sort().map((kind) => [kind, result.files.filter((item) => item.classification === kind).length]),
    ),
    policy: "Classification is a discovery hint. It does not infer authority, approval, freshness, or completeness.",
  }
}

async function readIndex(root) {
  const file = join(root, INDEX_PATH)
  try {
    await ensureSafeParents(root, file)
    const info = await lstat(file)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refusing to read a non-regular project knowledge index.")
    if (info.size > MAX_INDEX_BYTES) throw new Error(`Project knowledge index exceeds the ${MAX_INDEX_BYTES}-byte safety limit.`)
    const parsed = JSON.parse(await readFile(file, "utf8"))
    if (parsed.schema_version !== 1 || !Array.isArray(parsed.records)) throw new Error("Unsupported project knowledge index schema.")
    return parsed
  } catch (error) {
    if (error.code === "ENOENT") return { schema_version: 1, records: [] }
    throw error
  }
}

function sourceKey(record) {
  if (record.record_key) return record.record_key
  const identity = [record.source_system, record.source_id, record.source_revision]
  return sha256(JSON.stringify(record.origin_project_id ? [record.origin_project_id, ...identity] : identity))
}

function withRecordKey(record) {
  return { ...record, record_key: sourceKey(record) }
}

function referencesInIndex(index, ref) {
  return index.records.filter((record) => record.record_key === ref || record.source_id === ref || record.source_ref === ref || record.source_id + "@" + record.source_revision === ref)
}

function archiveRelativePath(record) {
  if (record.source_system === "filesystem") {
    const cleanPath = record.source_ref.split("/").map((part) => part.replace(/[^A-Za-z0-9._-]/g, "_")).join("/")
    const extension = extname(cleanPath)
    const base = extension ? cleanPath.slice(0, -extension.length) : cleanPath
    const pathKey = sha256(`${record.origin_project_id ?? ""}\0${record.source_ref}`).slice(0, 8)
    const revisionKey = record.sha256.slice(0, 16)
    return `.harness/knowledge/snapshots/local/${base}.${pathKey}.rev-${revisionKey}${extension}`
  }
  const key = sha256(`${record.origin_project_id ?? ""}\0${record.source_system}\0${record.source_ref}\0${record.source_revision}`).slice(0, 20)
  return `.harness/knowledge/snapshots/external/${key}.md`
}

function metadataFromText(text) {
  const title = text.match(/^\s*#\s+(.+?)\s*$/m)?.[1]?.trim()
  const status = text.match(/^\s*(?:status|approval status|state):\s*(.+?)\s*$/im)?.[1]?.trim()
  const disposition = text.match(/^\s*(?:disposition|application status):\s*(.+?)\s*$/im)?.[1]?.trim()?.toUpperCase().replace(/[ -]+/g, "_")
  const urlAndIdReferences = [...text.matchAll(/(?:https?:\/\/[^\s)\]>"']+|\b[A-Z][A-Z0-9]{1,20}[-_:][A-Za-z0-9][A-Za-z0-9._-]*)/g)]
    .map((match) => match[0].replace(/[.,;]+$/, ""))
  const markdownPathReferences = [...text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)]
    .map((match) => match[1].trim().replace(/^<|>$/g, "").split(/\s+['"]?/)[0])
    .filter((reference) => reference && !/^(?:https?:|mailto:|#)/i.test(reference))
  const references = [...new Set([...urlAndIdReferences, ...markdownPathReferences])]
  return { declared_title: title, declared_status: status, declared_disposition: disposition, embedded_references: references.slice(0, 100) }
}

function validateExternalSource(source, index) {
  if (!safeId(source.source_id)) throw new Error(`external_sources[${index}].source_id must be a stable ID using letters, numbers, dot, underscore, colon, or hyphen.`)
  if (source.source_record_key !== undefined && !safeId(source.source_record_key)) throw new Error(`external_sources[${index}].source_record_key must be an exact source-project record key.`)
  if (!String(source.title ?? "").trim() || String(source.title).length > 1000) throw new Error(`external_sources[${index}].title is required and must be at most 1000 characters.`)
  if (!new Set(["google-drive", "github", "other"]).has(source.source_system)) throw new Error(`external_sources[${index}].source_system is invalid.`)
  if (!String(source.source_ref ?? "").trim() || String(source.source_ref).length > 4000 || !String(source.source_revision ?? "").trim() || String(source.source_revision).length > 300) {
    throw new Error(`external_sources[${index}] needs an exact source_ref and source_revision.`)
  }
  if (!CLASSIFICATIONS.has(source.classification)) throw new Error(`external_sources[${index}].classification is invalid.`)
  if (!DECLARED_AUTHORITIES.has(source.declared_authority)) throw new Error(`external_sources[${index}].declared_authority is invalid.`)
  if (source.disposition !== undefined && !KNOWLEDGE_DISPOSITIONS.has(source.disposition)) throw new Error(`external_sources[${index}].disposition is invalid.`)
  if (!String(source.content ?? "").trim()) throw new Error(`external_sources[${index}].content is empty.`)
  if (Buffer.byteLength(source.content, "utf8") > MAX_EXTERNAL_SOURCE_BYTES) throw new Error(`external_sources[${index}] exceeds the 1 MiB per-source limit; split it into clearly linked source sections.`)
  if (!Array.isArray(source.related_sources ?? [])) throw new Error(`external_sources[${index}].related_sources must be an array.`)
  if ((source.related_sources ?? []).length > 100 || (source.related_sources ?? []).some((ref) => typeof ref !== "string" || ref.length > 1000)) throw new Error(`external_sources[${index}].related_sources must contain at most 100 references of at most 1000 characters.`)
}

export async function importProjectKnowledge(projectRoot, input) {
  if (!input?.owner_confirmed) throw new Error("Knowledge import stopped: explicit owner confirmation is required before files are written.")
  const { realpath } = await import("node:fs/promises")
  const root = await realpath(assertRoot(projectRoot))
  const sourceRoot = input.source_project_root ? await realpath(assertRoot(input.source_project_root)) : root
  const crossProject = sourceRoot !== root
  const sourceProjectId = crossProject ? String(input.source_project_id ?? "") : undefined
  if (crossProject && !safeId(sourceProjectId)) throw new Error("Cross-project import needs a stable source_project_id using letters, numbers, dot, underscore, colon, or hyphen.")
  const discovered = await walkKnowledgeFiles(sourceRoot)
  if (discovered.truncated) throw new Error("Knowledge import stopped because the source scan exceeded its safety limit. Narrow the source set or raise the limit in a reviewed change.")
  if (discovered.files.length > MAX_IMPORTED_FILES) throw new Error(`Knowledge import stopped: found ${discovered.files.length} documents, above the ${MAX_IMPORTED_FILES}-document review limit.`)
  const sourceIndex = crossProject ? await readIndex(sourceRoot) : { records: [] }
  const external = input.external_sources ?? []
  if (!Array.isArray(external) || external.length > 20) throw new Error("Provide at most 20 external sources per import batch.")
  external.forEach(validateExternalSource)

  const plans = []
  let totalBytes = 0
  for (const candidate of discovered.files) {
    const sourcePath = resolve(sourceRoot, candidate.path)
    if (!inside(sourceRoot, sourcePath)) throw new Error(`Knowledge source escaped the project root: ${candidate.path}`)
    const info = await lstat(sourcePath)
    if (!info.isFile() || info.isSymbolicLink()) continue
    if (info.size > MAX_SINGLE_FILE_BYTES) throw new Error(`Knowledge import stopped: ${candidate.path} is larger than the ${MAX_SINGLE_FILE_BYTES}-byte per-file limit.`)
    const sourceBytes = await readFile(sourcePath)
    const checksum = sha256(sourceBytes)
    if (sourceIndex.records.some((record) => record.source_system === "filesystem" && record.source_ref === candidate.path && record.sha256 === checksum)) continue
    totalBytes += info.size
    const metadata = TEXT_EXTENSIONS.has(extname(candidate.path).toLowerCase()) && info.size <= 2 * 1024 * 1024
      ? metadataFromText(sourceBytes.toString("utf8"))
      : { embedded_references: [] }
    const record = {
      source_id: `local-${sha256(`${sourceProjectId ?? ""}\0${candidate.path}`).slice(0, 20)}`,
      source_system: "filesystem",
      source_ref: candidate.path,
      ...(crossProject ? { origin_project_id: sourceProjectId } : {}),
      source_revision: checksum,
      retrieved_at: new Date().toISOString(),
      classification: candidate.classification,
      disposition: KNOWLEDGE_DISPOSITIONS.has(metadata.declared_disposition) ? metadata.declared_disposition : "UNASSESSED",
      declared_authority: "UNKNOWN",
      import_status: "SNAPSHOT_UNVERIFIED",
      sha256: checksum,
      byte_size: info.size,
      media_type: TEXT_EXTENSIONS.has(extname(candidate.path).toLowerCase()) ? "text" : "binary-preserved",
      relationships: metadata.embedded_references,
      source_relationships: metadata.embedded_references,
      original_modified_at: info.mtime.toISOString(),
    }
    if (record.media_type === "text" && info.size <= 2 * 1024 * 1024) Object.assign(record, metadata)
    record.archive_path = archiveRelativePath(record)
    plans.push({ record: withRecordKey(record), bytes: sourceBytes, kind: "write" })
  }

  for (const sourceRecord of sourceIndex.records) {
    const sourceArchive = resolve(sourceRoot, sourceRecord.archive_path)
    if (!inside(sourceRoot, sourceArchive)) throw new Error(`Indexed knowledge source escaped its project: ${sourceRecord.archive_path}`)
    await ensureSafeParents(sourceRoot, sourceArchive)
    const info = await lstat(sourceArchive)
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Indexed knowledge snapshot is not a regular file: ${sourceRecord.archive_path}`)
    if (info.size > MAX_SINGLE_FILE_BYTES) throw new Error(`Indexed knowledge snapshot exceeds the ${MAX_SINGLE_FILE_BYTES}-byte per-file limit.`)
    const bytes = await readFile(sourceArchive)
    if (sha256(bytes) !== sourceRecord.sha256) throw new Error(`Indexed knowledge snapshot failed hash verification: ${sourceRecord.source_ref}`)
    totalBytes += bytes.byteLength
    const { record_key: sourceRecordKey, archive_path: _sourceArchivePath, ...sourceMetadata } = sourceRecord
    const record = {
      ...sourceMetadata,
      ...(sourceRecord.origin_project_id ? { upstream_origin_project_id: sourceRecord.origin_project_id } : {}),
      ...(sourceRecord.source_record_key ? { upstream_source_record_key: sourceRecord.source_record_key } : {}),
      origin_project_id: sourceProjectId,
      source_record_key: sourceRecordKey,
      source_relationships: sourceRecord.source_relationships ?? sourceRecord.relationships ?? [],
      retrieved_at: new Date().toISOString(),
      import_status: "SNAPSHOT_UNVERIFIED",
      relationships: sourceRecord.source_relationships ?? sourceRecord.relationships ?? [],
    }
    record.archive_path = archiveRelativePath(record)
    plans.push({ record: withRecordKey(record), bytes, kind: "write" })
  }

  for (const source of external) {
    const bytes = Buffer.from(source.content, "utf8")
    totalBytes += bytes.byteLength
    const metadata = metadataFromText(source.content)
    const record = {
      source_id: source.source_id,
      source_system: source.source_system,
      source_ref: String(source.source_ref),
      ...(source.source_record_key ? { source_record_key: String(source.source_record_key) } : {}),
      source_revision: String(source.source_revision),
      retrieved_at: source.retrieved_at || new Date().toISOString(),
      classification: source.classification,
      disposition: source.disposition ?? (KNOWLEDGE_DISPOSITIONS.has(metadata.declared_disposition) ? metadata.declared_disposition : "UNASSESSED"),
      declared_authority: source.declared_authority,
      import_status: "SNAPSHOT_UNVERIFIED",
      sha256: sha256(bytes),
      byte_size: bytes.byteLength,
      media_type: "retrieved-text",
      relationships: [...new Set(source.related_sources ?? [])],
      source_relationships: [...new Set(source.related_sources ?? [])],
      ...metadata,
      declared_title: String(source.title),
    }
    record.archive_path = archiveRelativePath(record)
    plans.push({ record: withRecordKey(record), bytes, kind: "write" })
  }
  if (totalBytes > MAX_IMPORTED_BYTES) throw new Error(`Knowledge import stopped: the ${totalBytes}-byte archive exceeds the ${MAX_IMPORTED_BYTES}-byte batch limit.`)

  return withKnowledgeIndexLock(root, async () => {
  const index = await readIndex(root)
  const existing = new Map(index.records.map((record) => [sourceKey(record), record]))
  const accepted = []
  const conflicts = []
  const paths = new Map()
  for (const plan of plans) {
    const samePath = paths.get(plan.record.archive_path)
    if (samePath && samePath.sha256 !== plan.record.sha256) conflicts.push(`archive:${plan.record.archive_path}`)
    else paths.set(plan.record.archive_path, plan.record)
    const key = sourceKey(plan.record)
    const prior = existing.get(key)
    if (prior) {
      if (prior.sha256 !== plan.record.sha256) conflicts.push(key)
      else plan.duplicate = true
      continue
    }
    const batchPrior = accepted.find((candidate) => sourceKey(candidate.record) === key)
    if (batchPrior) {
      if (batchPrior.record.sha256 !== plan.record.sha256) conflicts.push(key)
      else plan.duplicate = true
      continue
    }
    accepted.push(plan)
  }
  if (conflicts.length) throw new Error(`Knowledge import stopped before writing: source IDs/revisions or archive paths conflict: ${[...new Set(conflicts)].join(", ")}. Preserve each version with an exact distinct source_revision.`)

  const newRecords = accepted.map((plan) => plan.record)
  const allRecords = [...index.records, ...newRecords]
  const aliases = new Map()
  const addAlias = (value, record) => {
    const alias = String(value ?? "").trim()
    if (!alias) return
    if (!aliases.has(alias)) aliases.set(alias, new Set())
    aliases.get(alias).add(record)
  }
  for (const record of allRecords) {
    const sourceName = basename(String(record.source_ref ?? ""))
    for (const alias of [
      record.record_key,
      record.source_record_key,
      record.source_id,
      `${record.source_id}@${record.source_revision}`,
      record.source_ref,
      sourceName,
      sourceName.replace(/\.[^.]+$/, ""),
      record.declared_title,
    ]) addAlias(alias, record)
  }
  const resolveRelationship = (reference) => {
    const ref = String(reference ?? "").trim()
    const withoutAnchor = ref.split("#", 1)[0]
    const fileName = basename(withoutAnchor)
    const candidates = new Set()
    for (const alias of [ref, withoutAnchor, fileName, fileName.replace(/\.[^.]+$/, "")]) {
      for (const match of aliases.get(alias) ?? []) candidates.add(match)
    }
    return candidates.size === 1 ? [...candidates][0] : undefined
  }
  const indexedRecords = [...index.records, ...newRecords]
  for (const record of indexedRecords) {
    const sourceRelationships = [...new Set(record.source_relationships ?? record.relationships ?? [])]
    const relationships = []
    const unresolved = []
    for (const ref of sourceRelationships) {
      const target = resolveRelationship(ref)
      if (target) relationships.push(target.record_key)
      else {
        relationships.push(ref)
        unresolved.push(ref)
      }
    }
    record.source_relationships = sourceRelationships
    record.relationships = [...new Set(relationships)]
    record.unresolved_relationships = [...new Set(unresolved)]
  }

  for (const plan of accepted) {
    const destination = resolve(root, plan.record.archive_path)
    if (!inside(root, destination)) throw new Error(`Knowledge archive path escaped the project root: ${plan.record.archive_path}`)
    await ensureSafeParents(root, destination)
    await mkdir(dirname(destination), { recursive: true })
    try { await writeFile(destination, plan.bytes, { flag: "wx" }) } catch (error) {
      if (error.code !== "EEXIST") throw error
      const destInfo = await lstat(destination)
      if (!destInfo.isFile() || destInfo.isSymbolicLink()) throw new Error(`Refusing to read a non-regular archive destination: ${plan.record.archive_path}`)
      const priorHash = sha256(await readFile(destination))
      if (priorHash !== plan.record.sha256) throw new Error(`Archive path already contains different content: ${plan.record.archive_path}`)
    }
    if (sha256(await readFile(destination)) !== plan.record.sha256) throw new Error(`Snapshot verification failed during import: ${plan.record.source_ref}`)
  }

  const nextIndex = {
    schema_version: 1,
    project: root.split(sep).at(-1),
    updated_at: new Date().toISOString(),
    authority_rule: "Imported material is an immutable snapshot. The archive preserves declared authority and source revision but does not promote a source or replace live project authority.",
    records: indexedRecords.sort((a, b) => sourceKey(a).localeCompare(sourceKey(b))),
  }
  const indexFile = join(root, INDEX_PATH)
  await ensureSafeParents(root, indexFile)
  await mkdir(dirname(indexFile), { recursive: true })
  const tempIndex = `${indexFile}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempIndex, `${JSON.stringify(nextIndex, null, 2)}\n`, { flag: "wx" })
  await rename(tempIndex, indexFile)

  return {
    status: "IMPORTED",
    local_candidates: discovered.files.length,
    external_candidates: external.length,
    imported: newRecords.length,
    unchanged: plans.length - newRecords.length,
    index_path: INDEX_PATH,
    total_bytes: totalBytes,
    ...(crossProject ? { source_project_id: sourceProjectId } : {}),
    records: newRecords.map(({ record_key, source_record_key, origin_project_id, source_id, source_system, source_revision, classification, declared_authority, archive_path, sha256: digest, byte_size }) => ({
      record_key, source_record_key, origin_project_id, source_id, source_system, source_revision, classification, declared_authority, import_status: "SNAPSHOT_UNVERIFIED", archive_path, sha256: digest, byte_size,
    })),
    next: "Review the complete index, confirm canonical IDs/revisions against each source registry or authority, and keep the snapshots as reference until a separate owner-approved mapping assigns their role.",
  }
  })
}

async function ensureSafeParents(root, destination) {
  if (!inside(root, destination)) throw new Error("Destination path escapes the project root.")
  const rel = relative(root, dirname(destination))
  let cursor = root
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part)
    try {
      const info = await lstat(cursor)
      if (info.isSymbolicLink()) throw new Error(`Refusing to write through a symlinked directory: ${relative(root, cursor)}`)
      if (!info.isDirectory()) throw new Error(`Expected a directory at ${relative(root, cursor)}`)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
}

async function isExistingSafeLocalReference(root, ref) {
  if (isAbsolute(ref) || /^[A-Za-z]:[\\/]/.test(ref)) return false
  const normalized = ref.replaceAll("\\", "/")
  const parts = normalized.split("/")
  if (!normalized || normalized.startsWith("/") || parts.some((part) => !part || part === "." || part === "..")) return false
  const target = resolve(root, normalized)
  if (!inside(root, target) || target === root) return false
  await ensureSafeParents(root, target)
  try {
    const info = await lstat(target)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

function artifactPath(type, artifactId) {
  if (type === "epic") return `.harness/epics/${artifactId}.md`
  if (type === "work-unit") return `.harness/work-units/${artifactId}.md`
  return `.harness/knowledge/artifacts/${type}/${artifactId}.md`
}

async function withKnowledgeIndexLock(root, operation) {
  const lockPath = join(root, INDEX_LOCK_PATH)
  await ensureSafeParents(root, lockPath)
  await mkdir(dirname(lockPath), { recursive: true })
  const token = randomUUID()
  const deadline = Date.now() + INDEX_LOCK_TIMEOUT_MS

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600)
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token, created_at: new Date().toISOString() })) }
      finally { await handle.close() }
      break
    } catch (error) {
      if (error.code !== "EEXIST") throw error
      let stale = false
      try {
        const info = await lstat(lockPath)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refusing to use an unsafe project knowledge lock.")
        let owner
        try { owner = JSON.parse(await readFile(lockPath, "utf8")) } catch {}
        const age = Date.now() - info.mtimeMs
        if (!Number.isInteger(owner?.pid)) stale = age > 5000
        else {
          try { process.kill(owner.pid, 0) }
          catch (probeError) { if (probeError.code === "ESRCH") stale = true }
        }
        if (stale) await unlink(lockPath)
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError
      }
      if (Date.now() >= deadline) throw new Error("Project knowledge index is busy in another session; retry after that write completes.")
      await new Promise((resolveDelay) => setTimeout(resolveDelay, stale ? 0 : 30 + Math.floor(Math.random() * 40)))
    }
  }

  try { return await operation() }
  finally {
    try {
      const owner = JSON.parse(await readFile(lockPath, "utf8"))
      if (owner.token === token) await unlink(lockPath)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
}

function tokenize(query) {
  return [...new Set(String(query).toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
}

export async function searchProjectKnowledge(projectRoot, query, maxResults = 5) {
  if (String(query ?? "").trim().length < 3) throw new Error("Provide a specific project-knowledge search of at least 3 characters.")
  const root = assertRoot(projectRoot)
  const index = await readIndex(root)
  const terms = tokenize(query)
  const results = []
  for (const record of index.records) {
    if (!TEXT_EXTENSIONS.has(extname(record.archive_path).toLowerCase()) && record.media_type !== "retrieved-text") continue
    if (record.byte_size > 2 * 1024 * 1024) continue
    const path = resolve(root, record.archive_path)
    if (!inside(root, path)) continue
    let text
    try {
      await ensureSafeParents(root, path)
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) continue
      text = await readFile(path, "utf8")
    } catch { continue }
    const normalized = text.toLowerCase()
    const score = terms.reduce((total, term) => total + (normalized.split(term).length - 1), 0)
    if (!score) continue
    const first = terms.map((term) => normalized.indexOf(term)).filter((position) => position >= 0).sort((a, b) => a - b)[0] ?? 0
    const start = Math.max(0, first - 350)
    const excerpt = text.slice(start, start + 1400)
    results.push({ record, score, excerpt })
  }
  return {
    status: results.length ? "OK" : "NO_MATCH",
    query: String(query).trim(),
    results: results.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(MAX_SEARCH_RESULTS, Number(maxResults) || 5)))
      .map(({ record, score, excerpt }) => ({
        record_key: sourceKey(record),
        source_id: record.source_id,
        source_system: record.source_system,
        source_revision: record.source_revision,
        classification: record.classification,
        disposition: record.disposition ?? "UNASSESSED",
        declared_authority: record.declared_authority,
        import_status: record.import_status,
        source_ref: record.source_ref,
        archive_path: record.archive_path,
        sha256: record.sha256,
        related_sources: record.relationships,
        unresolved_relationships: record.unresolved_relationships ?? [],
        relevance: score,
        excerpt,
      })),
    note: "Search results are navigation aids. Read the source record and verify its current authority and revision before relying on it.",
  }
}

export async function readProjectKnowledge(projectRoot, sourceId, startLine = 1, maxLines = 200) {
  if (!safeId(sourceId)) throw new Error("Provide an exact stable source_id from the knowledge index.")
  const root = assertRoot(projectRoot)
  const index = await readIndex(root)
  const matches = index.records.filter((record) => record.source_id === sourceId || record.record_key === sourceId)
  if (!matches.length) throw new Error(`No imported knowledge record matches ${sourceId}.`)
  if (matches.length > 1) throw new Error(`Multiple revisions exist for ${sourceId}; pass the exact record_key from the index.`)
  const record = matches[0]
  if (!TEXT_EXTENSIONS.has(extname(record.archive_path).toLowerCase()) && record.media_type !== "retrieved-text") {
    return { status: "BINARY_SOURCE", record, message: "The original binary is preserved. Use the project's PDF, document, or image reader to inspect it." }
  }
  const path = resolve(root, record.archive_path)
  if (!inside(root, path)) throw new Error("Indexed knowledge path escaped the project root.")
  await ensureSafeParents(root, path)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Refusing to read a non-regular project knowledge snapshot.")
  const content = await readFile(path, "utf8")
  const lines = content.split(/\r?\n/)
  const from = Math.max(1, Number(startLine) || 1)
  const count = Math.max(1, Math.min(500, Number(maxLines) || 200))
  return {
    status: "OK",
    record,
    start_line: from,
    end_line: Math.min(lines.length, from + count - 1),
    total_lines: lines.length,
    has_more: from + count - 1 < lines.length,
    content: lines.slice(from - 1, from - 1 + count).join("\n"),
  }
}

export async function recordKnowledgeArtifact(projectRoot, input) {
  const root = assertRoot(projectRoot)
  if (!input?.owner_confirmed) throw new Error("Knowledge artifact write stopped: explicit owner authorization for this artifact is required.")
  if (!ARTIFACT_TYPES.has(input.artifact_type)) throw new Error("Unsupported artifact_type.")
  if (!safeId(input.artifact_id)) throw new Error("artifact_id must be a stable ID using letters, numbers, dot, underscore, colon, or hyphen.")
  if (!String(input.title ?? "").trim() || !String(input.content ?? "").trim()) throw new Error("An artifact title and content are required.")
  if (!ARTIFACT_STATUSES.has(input.status)) throw new Error("Unsupported artifact status.")
  if (Buffer.byteLength(input.content, "utf8") > MAX_ARTIFACT_BYTES) throw new Error(`Artifact content exceeds ${MAX_ARTIFACT_BYTES} bytes.`)
  const sourceRefs = [...new Set(input.source_refs ?? [])]
  const parentRefs = [...new Set(input.parent_refs ?? [])]
  if ([...sourceRefs, ...parentRefs].some((ref) => typeof ref !== "string" || !ref.trim() || ref.length > 4000)) throw new Error("source_refs and parent_refs must contain non-empty exact reference strings of at most 4000 characters.")
  if (["raw-research", "research-compendium", "research-synthesis"].includes(input.artifact_type) && sourceRefs.length === 0) {
    throw new Error("Research records and syntheses require at least one exact source_ref or source_id.")
  }
  if (["requirement", "specification", "user-story", "epic", "work-unit", "decision", "rule"].includes(input.artifact_type)
    && sourceRefs.length === 0 && parentRefs.length === 0) {
    throw new Error("Promoted project artifacts require source_refs or parent_refs so their provenance is recoverable.")
  }
  if (input.artifact_type === "user-story" && parentRefs.length === 0) {
    throw new Error("A user story needs a parent_refs entry linking it to an approved requirement or specification.")
  }
  if (input.status === "APPROVED" && !input.owner_confirmed) {
    throw new Error("An artifact cannot be recorded as APPROVED without explicit owner confirmation.")
  }
  if (["raw-research", "research-compendium", "research-synthesis"].includes(input.artifact_type) && input.status === "APPROVED") {
    throw new Error("Research evidence remains RAW or PROPOSED; record the owner-approved consequence as a separate decision, requirement, or rule.")
  }
  const preflightIndex = await readIndex(root)
  for (const ref of sourceRefs) {
    const matches = referencesInIndex(preflightIndex, ref)
    if (matches.length > 1) throw new Error("source_ref " + ref + " is ambiguous across revisions; use the exact record_key.")
    const externalReference = /^(https?:\/\/|drive:[A-Za-z0-9_-]+(?:@[^\s]+)?$|github:[^\s]+$)/i.test(ref)
    const pathLikeReference = ref.startsWith(".") || ref.includes("/") || /\\/.test(ref) || /\.[A-Za-z0-9]{1,8}$/.test(ref)
    if (!matches.length && !externalReference && !(pathLikeReference && await isExistingSafeLocalReference(root, ref))) {
      throw new Error("source_ref " + ref + " is not present in the project knowledge index and is not an exact URL/Drive/GitHub reference.")
    }
  }
  return withKnowledgeIndexLock(root, async () => {
  const index = await readIndex(root)
  const resolveReferences = (ref) => index.records.filter((record) => record.record_key === ref || record.source_id === ref || record.source_ref === ref || `${record.source_id}@${record.source_revision}` === ref)
  if (input.artifact_type === "user-story") {
    const validParent = parentRefs.some((ref) => {
      const matches = resolveReferences(ref)
      return matches.length === 1 && matches[0].declared_authority === "APPROVED" && ["REQUIREMENT", "SPECIFICATION"].includes(matches[0].classification)
    })
    if (!validParent) throw new Error("A user story must link to an indexed APPROVED requirement or specification by exact record_key, source_id, or source_ref.")
  }
  for (const ref of sourceRefs) {
    const matches = resolveReferences(ref)
    if (matches.length > 1) throw new Error(`source_ref ${ref} is ambiguous across revisions; use the exact record_key.`)
    const externalReference = /^(https?:\/\/|drive:[A-Za-z0-9_-]+(?:@[^\s]+)?$|github:[^\s]+$)/i.test(ref)
    const pathLikeReference = ref.startsWith(".") || ref.includes("/") || /\\/.test(ref) || /\.[A-Za-z0-9]{1,8}$/.test(ref)
    const localReference = !matches.length && pathLikeReference && await isExistingSafeLocalReference(root, ref)
    if (!matches.length && !externalReference && !localReference) {
      throw new Error(`source_ref ${ref} is not present in the project knowledge index and is not an exact URL/Drive/GitHub reference.`)
    }
  }
  const path = artifactPath(input.artifact_type, input.artifact_id)
  const destination = resolve(root, path)
  if (!inside(root, destination)) throw new Error("Artifact path escapes the project root.")
  await ensureSafeParents(root, destination)
  await mkdir(dirname(destination), { recursive: true })
  const createdAt = new Date().toISOString()
  const artifactContent = input.artifact_type === "raw-research" ? String(input.content) : String(input.content).trimEnd()
  const envelope = [
    "---",
    `artifact_id: ${JSON.stringify(input.artifact_id)}`,
    `artifact_type: ${JSON.stringify(input.artifact_type)}`,
    `status: ${JSON.stringify(input.status)}`,
    `created_at: ${JSON.stringify(createdAt)}`,
    `source_refs: ${JSON.stringify(sourceRefs)}`,
    `parent_refs: ${JSON.stringify(parentRefs)}`,
    "---",
    "",
    `# ${String(input.title).trim()}`,
    "",
    artifactContent,
  ].join("\n")
  try { await writeFile(destination, envelope, { flag: "wx" }) } catch (error) {
    if (error.code === "EEXIST") throw new Error(`Artifact already exists at ${path}; use a new versioned artifact_id instead of replacing history.`)
    throw error
  }
  const record = withRecordKey({
    source_id: input.artifact_id,
    source_system: "harness-artifact",
    source_ref: path,
    source_revision: sha256(envelope),
    retrieved_at: createdAt,
    classification: input.artifact_type.toUpperCase().replaceAll("-", "_"),
    declared_authority: input.status === "APPROVED" ? "APPROVED" : input.status === "RAW" ? "RAW" : "UNKNOWN",
    import_status: input.status === "APPROVED" ? "OWNER_APPROVED_ARTIFACT" : "RECORDED_ARTIFACT",
    sha256: sha256(envelope),
    byte_size: Buffer.byteLength(envelope, "utf8"),
    media_type: "text",
    relationships: [...new Set([...sourceRefs, ...parentRefs])],
    source_relationships: [...new Set([...sourceRefs, ...parentRefs])],
    unresolved_relationships: [],
    archive_path: path,
    declared_title: String(input.title).trim(),
  })
  index.records = index.records.filter((item) => sourceKey(item) !== sourceKey(record))
  index.records.push(record)
  index.updated_at = createdAt
  const indexPath = join(root, INDEX_PATH)
  await ensureSafeParents(root, indexPath)
  await mkdir(dirname(indexPath), { recursive: true })
  const tempIndex = `${indexPath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tempIndex, `${JSON.stringify(index, null, 2)}\n`, { flag: "wx" })
  await rename(tempIndex, indexPath)
  return { status: "RECORDED", record_key: record.record_key, artifact_id: input.artifact_id, artifact_type: input.artifact_type, approval_status: input.status, path, source_refs: sourceRefs, parent_refs: parentRefs, sha256: record.sha256 }
  })
}

// Locate exactly one APPROVED Epic artifact in the knowledge index. This is the
// source of human authority a governed mandate (approve_mandate) binds to.
export async function findApprovedEpic(projectRoot, epicArtifactId) {
  const root = assertRoot(projectRoot)
  const index = await readIndex(root)
  const matches = index.records.filter((record) =>
    record.classification === "EPIC" &&
    record.declared_authority === "APPROVED" &&
    record.import_status === "OWNER_APPROVED_ARTIFACT" &&
    (record.source_id === epicArtifactId || record.record_key === epicArtifactId)
  )
  if (matches.length === 0) {
    throw new Error(`No APPROVED Epic artifact matches "${epicArtifactId}" in the project knowledge index.`)
  }
  if (matches.length > 1) {
    throw new Error(`"${epicArtifactId}" matches multiple APPROVED Epic records; pass the exact record_key.`)
  }
  return matches[0]
}
