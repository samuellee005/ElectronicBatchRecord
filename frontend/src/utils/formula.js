/**
 * Safe arithmetic evaluator for calculated number fields.
 *
 * Supports numbers (with decimals), the operators + - * /, parentheses, unary
 * +/-, and the functions listed in FORMULA_FUNCTIONS below. Named
 * identifiers are references (tokens) whose values are supplied in `values`.
 * There is no use of eval/Function — a tiny tokenizer + recursive-descent
 * parser evaluates the expression, so a form's formula can never run arbitrary
 * code.
 */

/**
 * The functions a formula may call, with the copy the builder's formula help
 * shows. This list is the single source of truth: the evaluator's lookup table
 * is derived from it, so a function added here is documented automatically.
 * Names are matched case-insensitively.
 */
export const FORMULA_FUNCTIONS = [
  {
    name: 'min',
    signature: 'min(a, b, ...)',
    summary: 'The smallest of the values given.',
    example: 'min(A, B)',
    fn: Math.min,
  },
  {
    name: 'max',
    signature: 'max(a, b, ...)',
    summary: 'The largest of the values given.',
    example: 'max(A, B, 0)',
    fn: Math.max,
  },
  {
    name: 'round',
    signature: 'round(a)',
    summary: 'Rounds to the nearest whole number (.5 rounds up).',
    example: 'round(A / B)',
    fn: Math.round,
  },
  {
    name: 'abs',
    signature: 'abs(a)',
    summary: 'Drops the sign, so the result is never negative.',
    example: 'abs(A - B)',
    fn: Math.abs,
  },
  {
    name: 'sqrt',
    signature: 'sqrt(a)',
    summary: 'Square root of the value.',
    example: 'sqrt(A)',
    fn: Math.sqrt,
  },
]

/** The operators a formula may use, in precedence order, for the help panel. */
export const FORMULA_OPERATORS = [
  { symbol: '+', summary: 'Add', example: 'A + B' },
  { symbol: '-', summary: 'Subtract, or negate a single value', example: 'A - B' },
  { symbol: '*', summary: 'Multiply', example: 'A * 1.05' },
  { symbol: '/', summary: 'Divide (dividing by zero is an error)', example: 'A / B' },
  { symbol: '( )', summary: 'Group, to run a step first', example: '(A + B) / 2' },
]

const FUNCS = Object.fromEntries(FORMULA_FUNCTIONS.map((f) => [f.name, f.fn]))

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

/* ---------------- date / time references ---------------- */

/**
 * Field types a calculation may read. A date or time field has no number of its
 * own, so its reference also carries a `unit` (see CALC_UNITS) saying what the
 * formula sees.
 */
export const CALC_REF_TYPES = ['number', 'date', 'time']

/** The kind of value a field contributes to a formula, or null if it cannot. */
export function calcRefKind(field) {
  const t = field?.type
  return CALC_REF_TYPES.includes(t) ? t : null
}

/**
 * Units a date/time reference can resolve into. `ms` is what the instant is
 * divided by, so a difference between two references of the same unit reads
 * directly in that unit.
 */
export const CALC_UNITS = [
  { key: 'days', label: 'days', ms: 86400000 },
  { key: 'hours', label: 'hours', ms: 3600000 },
  { key: 'minutes', label: 'minutes', ms: 60000 },
]

/** Unit a new date/time reference starts on: whole days for a date, hours for a clock time. */
export function defaultCalcUnit(kind) {
  return kind === 'date' ? 'days' : 'hours'
}

function unitMs(unit) {
  return (CALC_UNITS.find((u) => u.key === unit) || CALC_UNITS[1]).ms
}

/**
 * `YYYY-MM-DD` (what a date field stores) -> milliseconds at UTC midnight, or
 * null if it is missing or not a real calendar date.
 *
 * UTC deliberately: the value carries no zone, and anchoring it to UTC keeps the
 * difference between two dates an exact whole number of days. Local midnight
 * would lose or gain an hour across a DST boundary, so "days between" could
 * come out as 6.958 instead of 7.
 */
export function parseDateValue(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw ?? '').trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const ms = Date.UTC(y, mo - 1, d)
  const back = new Date(ms)
  // Rejects 2026-02-31 and friends, which Date.UTC would silently roll over.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null
  }
  return ms
}

/** `HH:MM` or `HH:MM:SS` -> milliseconds since midnight, or null if unusable. */
export function parseTimeValue(raw) {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(raw ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  const sec = m[3] === undefined ? 0 : Number(m[3])
  if (h > 23 || min > 59 || sec > 59) return null
  return ((h * 60 + min) * 60 + sec) * 1000
}

/**
 * The number a date/time reference puts into a formula: the instant it names,
 * measured in `unit`.
 *
 * A date alone is that date's midnight, so two of them differ by whole days. A
 * time alone is measured from midnight, so two of them differ by the time of
 * day elapsed — which goes negative across midnight, and is why a date can be
 * paired with a time (`paired`) to name a real instant instead.
 *
 * Returns `{ value }`, or `{ bad: 'date' | 'time' }` naming which half could not
 * be read — a paired reference reads two fields, so the caller needs to know
 * which one to blame. The caller also decides whether an unreadable value means
 * "awaiting entry" or an error.
 */
export function calcDateTimeValue({ kind, unit, dateRaw, timeRaw, paired }) {
  const per = unitMs(unit)
  if (kind === 'time') {
    const t = parseTimeValue(timeRaw ?? dateRaw)
    return t == null ? { bad: 'time' } : { value: t / per }
  }
  if (kind !== 'date') return { bad: 'date' }
  const d = parseDateValue(dateRaw)
  if (d == null) return { bad: 'date' }
  if (!paired) return { value: d / per }
  const t = parseTimeValue(timeRaw)
  if (t == null) return { bad: 'time' }
  return { value: (d + t) / per }
}

/**
 * Whether a reference is configured enough to evaluate: a field is chosen, a
 * date/time reference has a known unit, and a date paired with a time points at
 * a time field that still exists.
 */
export function calcRefComplete(ref, fields) {
  if (!ref?.fieldId) return false
  const field = (fields || []).find((f) => f.id === ref.fieldId)
  const kind = calcRefKind(field)
  if (!kind) return false
  if (kind === 'number') return true
  if (!CALC_UNITS.some((u) => u.key === ref.unit)) return false
  if (kind === 'date' && ref.timeFieldId) {
    const paired = (fields || []).find((f) => f.id === ref.timeFieldId)
    return paired?.type === 'time'
  }
  return true
}

/* ---------------- calculated-field dependency graph ---------------- */

/** Resolved references of a configured calculated field: [{ fieldId, token }]. */
function calcRefsOf(field) {
  if (!field || field.type !== 'number' || field.calc?.enabled !== true) return []
  const refs = field.calc.refs
  return Array.isArray(refs) ? refs.filter((r) => r && r.fieldId) : []
}

/**
 * Ids a calculated field must not reference: itself, plus every field that
 * already depends on it (directly or through other calculated fields) —
 * picking one of those would close a cycle.
 *
 * Walks the reverse graph from `fieldId`, so it is cycle-safe and visits each
 * field at most once.
 */
export function calcIneligibleRefs(fieldId, fields) {
  const dependents = new Map() // field id -> ids of calc fields reading it
  for (const f of fields || []) {
    for (const r of calcRefsOf(f)) {
      const list = dependents.get(r.fieldId)
      if (list) list.push(f.id)
      else dependents.set(r.fieldId, [f.id])
    }
  }
  const out = new Set([fieldId])
  const stack = [fieldId]
  while (stack.length) {
    for (const dep of dependents.get(stack.pop()) || []) {
      if (out.has(dep)) continue
      out.add(dep)
      stack.push(dep)
    }
  }
  return out
}
