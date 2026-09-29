import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const libraryRoot = fileURLToPath(new URL("../docs/reference-library/", import.meta.url))
const stopWords = new Set((
  "a an and are as at be been being but by can could did do does for from had has have how i in into " +
  "is it its may more most of on or our should than that the their them then there these this those to was " +
  "were what when where which who why will with would you your el la los las de del y en un una unos unas " +
  "por para como que cual cuales quien quienes cuando donde es son ser estar hacer crear diseñar usar sobre " +
  "necesito quiero debería debe deben puede pueden proyecto plugin harness agente agentes skill skills"
).split(/\s+/))

let indexPromise

function tokenize(value) {
  return String(value ?? "").toLocaleLowerCase("en")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .match(/[\p{L}\p{N}_-]{2,}/gu)
    ?.filter((term) => !stopWords.has(term)) ?? []
}

function splitSections(text) {
  const lines = text.split(/\r?\n/)
  const sections = []
  const headingStack = []
  let heading = "Document beginning"
  let sectionLines = []
  let lineStart = 1
  let inFence = false
  const flush = (lineEnd) => {
    const bodyLines = sectionLines.filter((line, index) => !(index === 0 && /^#{1,4}\s+/.test(line)))
    const body = bodyLines.join("\n").trim()
    if (body) sections.push({ heading, text: body, line_start: lineStart, line_end: lineEnd })
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const match = !inFence && line.match(/^(#{1,4})\s+(.+?)\s*#*$/)
    if (match) {
      flush(index)
      const level = match[1].length
      headingStack.length = level - 1
      headingStack[level - 1] = match[2]
      heading = headingStack.filter(Boolean).join(" > ")
      sectionLines = [line]
      lineStart = index + 1
    } else {
      sectionLines.push(line)
    }
  }
  flush(lines.length)

  const chunks = []
  for (const section of sections) {
    const lines = section.text.split("\n")
    let bodyLines = []
    let bodyLength = 0
    let startLine = section.line_start
    const emit = (endLine) => {
      const body = bodyLines.join("\n").trim()
      if (!body) return
      chunks.push({ heading: section.heading, text: body, line_start: startLine, line_end: endLine })
      bodyLines = []
      bodyLength = 0
      startLine = endLine + 1
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const lineNumber = section.line_start + index
      if (line.length > 1800) {
        emit(lineNumber - 1)
        for (let offset = 0; offset < line.length; offset += 1800) {
          const part = line.slice(offset, offset + 1800)
          chunks.push({ heading: section.heading, text: part, line_start: lineNumber, line_end: lineNumber })
        }
        startLine = lineNumber + 1
        continue
      }
      if (bodyLength && bodyLength + line.length + 1 > 1800) emit(lineNumber - 1)
      bodyLines.push(line)
      bodyLength += line.length + 1
    }
    emit(section.line_end)
  }

  return chunks.length ? chunks : [{ heading: "Document", text: text.slice(0, 1800), line_start: 1, line_end: lines.length }]
}

async function loadIndex() {
  const manifest = JSON.parse(await readFile(join(libraryRoot, "manifest.json"), "utf8"))
  const documents = await Promise.all(manifest.documents.map(async (document) => {
    const text = await readFile(join(libraryRoot, document.path), "utf8")
    return {
      ...document,
      chunks: splitSections(text).map((chunk) => ({
        ...chunk,
        terms: tokenize(`${document.title} ${document.topics.join(" ")} ${chunk.heading} ${chunk.text}`),
      })),
    }
  }))
  const chunks = documents.flatMap((document) => document.chunks.map((chunk) => ({ document, chunk })))
  const averageLength = chunks.reduce((sum, entry) => sum + entry.chunk.terms.length, 0) / Math.max(chunks.length, 1)
  const documentFrequency = new Map()
  for (const { chunk } of chunks) {
    for (const term of new Set(chunk.terms)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
  }
  return { documents, chunks, averageLength, documentFrequency }
}

function getIndex() {
  indexPromise ??= loadIndex().catch((error) => {
    indexPromise = undefined
    throw error
  })
  return indexPromise
}

function bm25Score(queryTerms, entry, index) {
  const { chunk, document } = entry
  const termCounts = new Map()
  for (const term of chunk.terms) termCounts.set(term, (termCounts.get(term) ?? 0) + 1)
  const length = chunk.terms.length
  const k1 = 1.2
  const b = 0.75
  let score = 0
  for (const term of queryTerms) {
    const frequency = termCounts.get(term) ?? 0
    if (!frequency) continue
    const df = index.documentFrequency.get(term) ?? 0
    const idf = Math.log(1 + (index.chunks.length - df + 0.5) / (df + 0.5))
    score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * length / Math.max(index.averageLength, 1)))
    if (tokenize(`${document.title} ${chunk.heading}`).includes(term)) score += idf * 0.6
  }
  return score
}

export async function searchKnowledge(query, { sourceId, maxResults = 3 } = {}) {
  const cleanQuery = String(query ?? "").trim()
  if (cleanQuery.length < 3) throw new Error("Provide a specific search question of at least 3 characters.")
  const index = await getIndex()
  const queryTerms = [...new Set(tokenize(cleanQuery))]
  if (!queryTerms.length) return { status: "NO_MATCH", message: "No searchable terms were found. Try the main concept or the source topic in English.", results: [] }

  const results = index.chunks
    .filter(({ document }) => !sourceId || document.id === sourceId)
    .map((entry) => ({ ...entry, score: bm25Score(queryTerms, entry, index) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(1, Math.min(5, Number(maxResults) || 3)))
    .map(({ document, chunk, score }) => ({
      source_id: document.id,
      title: document.title,
      path: `docs/reference-library/${document.path}`,
      section: chunk.heading,
      lines: `${chunk.line_start}-${chunk.line_end}`,
      excerpt: chunk.text.slice(0, 1400),
      relevance: Number(score.toFixed(3)),
    }))

  return results.length
    ? { status: "OK", query: cleanQuery, results }
    : { status: "NO_MATCH", query: cleanQuery, message: "No relevant passages found. Try a narrower query, alternate terminology, or source_id filter.", results: [] }
}

export async function listKnowledgeSources() {
  const manifest = JSON.parse(await readFile(join(libraryRoot, "manifest.json"), "utf8"))
  return manifest.documents.map(({ id, title, path, topics }) => ({ id, title, path: `docs/reference-library/${path}`, topics }))
}
