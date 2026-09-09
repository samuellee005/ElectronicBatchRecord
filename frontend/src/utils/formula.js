/**
 * Safe arithmetic evaluator for calculated number fields.
 *
 * Supports numbers (with decimals), the operators + - * /, parentheses, unary
 * +/-, and a small set of functions (min, max, round, abs, sqrt). Named
 * identifiers are references (tokens) whose values are supplied in `values`.
 * There is no use of eval/Function — a tiny tokenizer + recursive-descent
 * parser evaluates the expression, so a form's formula can never run arbitrary
 * code.
 */

const FUNCS = {
  min: Math.min,
  max: Math.max,
  round: Math.round,
  abs: Math.abs,
  sqrt: Math.sqrt,
}

function lex(src) {
  const s = String(src ?? '')
  const tokens = []
  const isDigit = (c) => c >= '0' && c <= '9'
  const isIdentStart = (c) => /[A-Za-z_]/.test(c)
  const isIdent = (c) => /[A-Za-z0-9_]/.test(c)
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(s[i + 1]))) {
      let j = i + 1
      while (j < s.length && (isDigit(s[j]) || s[j] === '.')) j++
      const num = s.slice(i, j)
      if ((num.match(/\./g) || []).length > 1) throw new Error(`Invalid number "${num}"`)
      tokens.push({ t: 'num', v: parseFloat(num) })
      i = j
      continue
    }
    if (isIdentStart(c)) {
      let j = i + 1
      while (j < s.length && isIdent(s[j])) j++
      tokens.push({ t: 'ident', v: s.slice(i, j) })
      i = j
      continue
    }
    if ('+-*/(),'.includes(c)) {
      tokens.push({ t: 'op', v: c })
      i++
      continue
    }
    throw new Error(`Unexpected character "${c}"`)
  }
  return tokens
}

/**
 * Evaluate `formula` with the given `values` map (token -> number).
 * Throws Error on any problem (syntax, unknown reference, non-number reference,
 * division by zero, non-finite result).
 */
export function evaluateFormula(formula, values) {
  const tokens = lex(formula)
  let pos = 0
  const peek = () => tokens[pos]
  const next = () => tokens[pos++]
  const expect = (v) => {
    const tk = next()
    if (!tk || tk.v !== v) throw new Error(`Expected "${v}"`)
  }

  function parseExpr() {
    let left = parseTerm()
    while (peek() && peek().t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = next().v
      const right = parseTerm()
      left = op === '+' ? left + right : left - right
    }
    return left
  }
  function parseTerm() {
    let left = parseFactor()
    while (peek() && peek().t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = next().v
      const right = parseFactor()
      if (op === '*') {
        left = left * right
      } else {
        if (right === 0) throw new Error('Division by zero')
        left = left / right
      }
    }
    return left
  }
  function parseFactor() {
    const tk = peek()
    if (tk && tk.t === 'op' && (tk.v === '+' || tk.v === '-')) {
      next()
      const val = parseFactor()
      return tk.v === '-' ? -val : val
    }
    return parsePrimary()
  }
  function parsePrimary() {
    const tk = next()
    if (!tk) throw new Error('Unexpected end of formula')
    if (tk.t === 'num') return tk.v
    if (tk.t === 'op' && tk.v === '(') {
      const val = parseExpr()
      expect(')')
      return val
    }
    if (tk.t === 'ident') {
      if (peek() && peek().t === 'op' && peek().v === '(') {
        const fn = FUNCS[tk.v.toLowerCase()]
        if (!fn) throw new Error(`Unknown function "${tk.v}"`)
        next() // consume '('
        const args = []
        if (!(peek() && peek().v === ')')) {
          args.push(parseExpr())
          while (peek() && peek().v === ',') {
            next()
            args.push(parseExpr())
          }
        }
        expect(')')
        return fn(...args)
      }
      if (!(tk.v in values)) throw new Error(`Unknown reference "${tk.v}"`)
      const v = Number(values[tk.v])
      if (!Number.isFinite(v)) throw new Error(`Reference "${tk.v}" is not a number`)
      return v
    }
    throw new Error('Unexpected token')
  }

  const result = parseExpr()
  if (pos < tokens.length) throw new Error('Unexpected trailing input')
  if (!Number.isFinite(result)) throw new Error('Formula did not produce a finite number')
  return result
}

/** Reference tokens used in a formula (identifiers that are not function calls). */
export function extractFormulaTokens(formula) {
  let toks
  try {
    toks = lex(formula)
  } catch {
    return []
  }
  const out = new Set()
  for (let k = 0; k < toks.length; k++) {
    if (toks[k].t === 'ident') {
      const isFn = toks[k + 1] && toks[k + 1].t === 'op' && toks[k + 1].v === '('
      if (!isFn) out.add(toks[k].v)
    }
  }
  return [...out]
}

/**
 * Confirm a formula is well-formed and yields a finite number, using sample
 * values for every allowed token. Returns { ok, error }.
 */
export function validateFormula(formula, allowedTokens) {
  const f = String(formula ?? '').trim()
  if (!f) return { ok: false, error: 'Enter a formula.' }
  const allowed = allowedTokens || []
  const used = extractFormulaTokens(f)
  const unknown = used.filter((t) => !allowed.includes(t))
  if (unknown.length) return { ok: false, error: `Unknown reference: ${unknown.join(', ')}` }
  const sample = {}
  for (const t of allowed) sample[t] = 2
  try {
    const v = evaluateFormula(f, sample)
    if (!Number.isFinite(v)) return { ok: false, error: 'Formula did not produce a number.' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message || 'Invalid formula.' }
  }
}
