// Controller transport adapter for Phase 4.
//
// OpenCode Code Mode wraps a single tool call in `execute({ code: ... })`.
// The runtime guard sees ONLY the outer execute event, so this module
// recognizes ONLY the observed dot/bracket wrappers for `harness_execution_controller`
// and normalizes it to the logical tool/input.
//
// Fail closed on every deviation:
// - no generic execute privilege
// - no substring/comment spoofing
// - no dynamic or aliased tool names
// - no multiple statements
// - no eval or JavaScript execution

export function extractControllerInvocation(event) {
  if (!event || typeof event !== 'object') return null

  if (event.tool === 'harness_execution_controller') {
    return { tool: 'harness_execution_controller', input: event.input ?? {} }
  }

  if (event.tool !== 'execute') return null

  const raw = event.input?.code
  if (typeof raw !== 'string' || raw.length > 65536) return null

  const code = raw.trim()

  // Exact observed Code Mode wrapper:
  //   return await tools["harness_execution_controller"](<single literal object>)
  //   return await tools.harness_execution_controller(<single literal object>)
  // Harmless whitespace/newlines are allowed; everything else is rejected.
  const prefixMatch = code.match(/^return[^\S\r\n\u2028\u2029]+await\s+tools\s*(?:\[\s*"harness_execution_controller"\s*\]|\.\s*harness_execution_controller)\s*\(/)
  if (!prefixMatch) return null

  const openIdx = prefixMatch[0].length - 1
  const closeIdx = findMatchingParen(code, openIdx)
  if (closeIdx < 0 || closeIdx !== code.length - 1) return null

  const inner = code.slice(openIdx + 1, closeIdx).trim()
  if (!inner) return null

  try {
    const parsed = parseStaticObjectLiteral(inner)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return { tool: 'harness_execution_controller', input: parsed }
  } catch {
    return null
  }
}

function findMatchingParen(text, openIdx) {
  let depth = 1
  let inString = null
  let escaped = false
  for (let i = openIdx + 1; i < text.length; i++) {
    const c = text[i]
    if (escaped) { escaped = false; continue }
    if (c === '\\' && inString) { escaped = true; continue }
    if (inString) {
      if (c === inString) inString = null
      continue
    }
    if (c === '"' || c === "'") { inString = c; continue }
    if (c === '(') { depth++; continue }
    if (c === ')') { depth--; if (depth === 0) return i }
  }
  return -1
}

function parseStaticObjectLiteral(text) {
  const parser = new StrictValueParser(text)
  parser.skipWhitespace()
  if (parser.peek() !== '{') throw new Error('expected object literal')
  const value = parser.parseObject()
  parser.skipWhitespace()
  if (parser.pos !== text.length) throw new Error('trailing content')
  return value
}

class StrictValueParser {
  constructor(text) {
    this.text = text
    this.pos = 0
  }

  peek() { return this.text[this.pos] ?? '' }
  consume() { return this.text[this.pos++] }

  skipWhitespace() {
    while (/\s/.test(this.peek())) this.pos++
  }

  parseValue() {
    this.skipWhitespace()
    const c = this.peek()
    if (c === '{') return this.parseObject()
    if (c === '[') return this.parseArray()
    if (c === '"' || c === "'") return this.parseString()
    if (c === '-' || /\d/.test(c)) return this.parseNumber()
    return this.parseLiteral()
  }

  parseObject() {
    this.consume() // {
    const obj = {}
    this.skipWhitespace()
    if (this.peek() === '}') { this.consume(); return obj }
    while (true) {
      this.skipWhitespace()
      const key = this.parseKey()
      if (key === '__proto__' || Object.hasOwn(obj, key)) throw new Error('ambiguous object key')
      this.skipWhitespace()
      if (this.consume() !== ':') throw new Error('expected colon')
      obj[key] = this.parseValue()
      this.skipWhitespace()
      const c = this.consume()
      if (c === '}') return obj
      if (c !== ',') throw new Error('expected comma or brace')
    }
  }

  parseKey() {
    const c = this.peek()
    if (c === '"' || c === "'") return this.parseString()
    return this.parseIdentifier()
  }

  parseArray() {
    this.consume() // [
    const arr = []
    this.skipWhitespace()
    if (this.peek() === ']') { this.consume(); return arr }
    while (true) {
      arr.push(this.parseValue())
      this.skipWhitespace()
      const c = this.consume()
      if (c === ']') return arr
      if (c !== ',') throw new Error('expected comma or bracket')
    }
  }

  parseString() {
    const quote = this.consume()
    let s = ''
    while (this.pos < this.text.length) {
      const c = this.consume()
      if (c === quote) return s
      if (c === '\\') {
        const esc = this.consume()
        if (esc === 'n') s += '\n'
        else if (esc === 't') s += '\t'
        else if (esc === 'r') s += '\r'
        else if (esc === 'b') s += '\b'
        else if (esc === 'f') s += '\f'
        else if (esc === 'v') s += '\v'
        else if (esc === '0' && !/\d/.test(this.peek())) s += '\0'
        else if (esc === '\\') s += '\\'
        else if (esc === quote) s += quote
        else if (esc === 'u') {
          const hex = this.text.slice(this.pos, this.pos + 4)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad unicode escape')
          s += String.fromCharCode(parseInt(hex, 16))
          this.pos += 4
        } else {
          throw new Error('bad escape')
        }
      } else {
        if (/[\r\n\u2028\u2029]/.test(c)) throw new Error('raw line terminator')
        s += c
      }
    }
    throw new Error('unterminated string')
  }

  parseNumber() {
    const start = this.pos
    if (this.peek() === '-') this.consume()
    while (/\d/.test(this.peek())) this.consume()
    if (this.peek() === '.') {
      this.consume()
      while (/\d/.test(this.peek())) this.consume()
    }
    const num = this.text.slice(start, this.pos)
    if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(num)) throw new Error('bad number')
    const value = Number(num)
    if (!Number.isFinite(value)) throw new Error('non-finite number')
    return value
  }

  parseLiteral() {
    const start = this.pos
    const c = this.peek()
    if (!/[a-zA-Z_$]/.test(c)) throw new Error('expected literal')
    this.consume()
    while (/[a-zA-Z0-9_$]/.test(this.peek())) this.consume()
    const lit = this.text.slice(start, this.pos)
    if (lit === 'true') return true
    if (lit === 'false') return false
    if (lit === 'null') return null
    throw new Error(`unsupported literal: ${lit}`)
  }

  parseIdentifier() {
    const start = this.pos
    const c = this.peek()
    if (!/[a-zA-Z_$]/.test(c)) throw new Error('expected identifier')
    this.consume()
    while (/[a-zA-Z0-9_$]/.test(this.peek())) this.consume()
    return this.text.slice(start, this.pos)
  }
}
