import { z } from 'zod'

import type { CanonicalJsonErrorCode, CanonicalJsonErrorDetail } from './errors.ts'
import { CanonicalJsonError } from './errors.ts'

/**
 * Structural JSON schema. It is the single type source for {@link JsonValue}
 * and {@link JsonObject}; it deliberately does not implement the strict value
 * rules enforced by {@link parseJsonText} and {@link canonicalize}.
 */
export const jsonValueSchema = z.json()

export type JsonValue = z.infer<typeof jsonValueSchema>

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema)

export type JsonObject = z.infer<typeof jsonObjectSchema>

const MAX_SAFE_INTEGER_LITERAL = '9007199254740991'

const ASCII_ZERO = 0x30
const ASCII_NINE = 0x39
const ASCII_UPPER_A = 0x41
const ASCII_UPPER_Z = 0x5a
const ASCII_LOWER_A = 0x61
const ASCII_LOWER_Z = 0x7a
const UNDERSCORE = 0x5f

/** Parse RFC 8259 JSON text while rejecting duplicate keys and unsafe integers. */
export function parseJsonText(text: string): JsonValue {
  return new JsonTextParser(text).parse()
}

/** Serialize a JSON-compatible value using RFC 8785 JSON Canonicalization Scheme. */
export function canonicalize(value: unknown): string {
  return serializeJsonValue(value, '$', new Set<object>())
}

class JsonTextParser {
  private index = 0
  private readonly text: string

  constructor(text: string) {
    this.text = text
  }

  parse(): JsonValue {
    this.skipWhitespace()
    if (this.index === this.text.length) {
      this.fail('INVALID_JSON_SYNTAX', '$', this.index, 'Expected a JSON value')
    }
    const value = this.parseValue('$')
    this.skipWhitespace()
    if (this.index !== this.text.length) {
      this.fail('TRAILING_DATA', '$', this.index, 'Unexpected data after the JSON value')
    }
    return value
  }

  private parseValue(path: string): JsonValue {
    const char = this.peek()
    switch (char) {
      case '{':
        return this.parseObject(path)
      case '[':
        return this.parseArray(path)
      case '"':
        return this.parseString(path)
      case 't':
        this.expectLiteral('true', path)
        return true
      case 'f':
        this.expectLiteral('false', path)
        return false
      case 'n':
        this.expectLiteral('null', path)
        return null
      case '-':
        return this.parseNumber(path)
      default:
        if (isDigitCode(char.charCodeAt(0))) return this.parseNumber(path)
        if (char === '\uFEFF') {
          this.fail('UNEXPECTED_BOM', path, this.index, 'A byte order mark is not valid JSON')
        }
        if (char === '+' || char === '.') {
          this.fail('INVALID_NUMBER', path, this.index, 'Invalid JSON number')
        }
        this.fail('INVALID_JSON_SYNTAX', path, this.index, 'Expected a JSON value')
    }
  }

  private parseObject(path: string): JsonObject {
    this.index += 1
    const object = Object.create(null) as JsonObject
    const seen = new Set<string>()
    this.skipWhitespace()
    if (this.peek() === '}') {
      this.index += 1
      return object
    }

    for (;;) {
      this.skipWhitespace()
      if (this.peek() !== '"') {
        this.fail('INVALID_JSON_SYNTAX', path, this.index, 'Expected a quoted object key')
      }
      const keyOffset = this.index
      const key = this.parseString(path)
      this.skipWhitespace()
      if (this.peek() !== ':') {
        this.fail('INVALID_JSON_SYNTAX', path, this.index, 'Expected ":" after an object key')
      }
      this.index += 1
      this.skipWhitespace()
      if (seen.has(key)) {
        this.fail('DUPLICATE_KEY', propertyPath(path, key), keyOffset, `Duplicate object key ${quoteForMessage(key)}`, { key })
      }
      seen.add(key)

      const childPath = propertyPath(path, key)
      const value = this.parseValue(childPath)
      Object.defineProperty(object, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      })

      this.skipWhitespace()
      const next = this.peek()
      if (next === ',') {
        this.index += 1
        this.skipWhitespace()
        if (this.peek() === '}') {
          this.fail('INVALID_JSON_SYNTAX', path, this.index, 'Trailing comma in an object')
        }
        continue
      }
      if (next === '}') {
        this.index += 1
        return object
      }
      this.fail('INVALID_JSON_SYNTAX', path, this.index, 'Expected "," or "}" in an object')
    }
  }

  private parseArray(path: string): JsonValue[] {
    this.index += 1
    const array: JsonValue[] = []
    this.skipWhitespace()
    if (this.peek() === ']') {
      this.index += 1
      return array
    }

    let elementIndex = 0
    for (;;) {
      this.skipWhitespace()
      array.push(this.parseValue(`${path}[${String(elementIndex)}]`))
      this.skipWhitespace()
      const next = this.peek()
      if (next === ',') {
        elementIndex += 1
        this.index += 1
        this.skipWhitespace()
        if (this.peek() === ']') {
          this.fail('INVALID_JSON_SYNTAX', path, this.index, 'Trailing comma in an array')
        }
        continue
      }
      if (next === ']') {
        this.index += 1
        return array
      }
      this.fail('INVALID_JSON_SYNTAX', path, this.index, 'Expected "," or "]" in an array')
    }
  }

  private parseString(path: string): string {
    this.index += 1
    let value = ''
    while (this.index < this.text.length) {
      const char = this.peek()
      const code = char.charCodeAt(0)
      if (char === '"') {
        this.index += 1
        if (!value.isWellFormed()) {
          this.fail('LONE_SURROGATE', path, this.index - 1, 'JSON strings must be well-formed Unicode')
        }
        return value
      }
      if (char === '\\') {
        const escapeOffset = this.index
        this.index += 1
        if (this.index >= this.text.length) {
          this.fail('UNTERMINATED_STRING', path, this.index, 'Unterminated JSON string')
        }
        const escape = this.peek()
        switch (escape) {
          case '"':
            value += '"'
            this.index += 1
            break
          case '\\':
            value += '\\'
            this.index += 1
            break
          case '/':
            value += '/'
            this.index += 1
            break
          case 'b':
            value += '\b'
            this.index += 1
            break
          case 'f':
            value += '\f'
            this.index += 1
            break
          case 'n':
            value += '\n'
            this.index += 1
            break
          case 'r':
            value += '\r'
            this.index += 1
            break
          case 't':
            value += '\t'
            this.index += 1
            break
          case 'u': {
            const hex = this.text.slice(this.index + 1, this.index + 5)
            if (hex.length !== 4 || !isHexLiteral(hex)) {
              this.fail('INVALID_JSON_ESCAPE', path, escapeOffset, 'Invalid Unicode escape')
            }
            value += String.fromCharCode(Number.parseInt(hex, 16))
            this.index += 5
            break
          }
          default:
            this.fail('INVALID_JSON_ESCAPE', path, escapeOffset, 'Invalid JSON string escape')
        }
        continue
      }
      if (code <= 0x1f) {
        this.fail('CONTROL_CHARACTER', path, this.index, 'Unescaped control character in a JSON string')
      }
      value += char
      this.index += 1
    }
    this.fail('UNTERMINATED_STRING', path, this.index, 'Unterminated JSON string')
  }

  private parseNumber(path: string): number {
    const start = this.index
    if (this.peek() === '-') this.index += 1

    const first = this.peek()
    if (!isDigitCode(first.charCodeAt(0))) {
      this.fail('INVALID_NUMBER', path, start, 'Invalid JSON number')
    }
    const integerStart = this.index
    if (first === '0') {
      this.index += 1
      if (isDigitCode(this.peek().charCodeAt(0))) {
        this.fail('INVALID_NUMBER', path, this.index, 'Leading zeros are not valid JSON numbers')
      }
    } else {
      while (isDigitCode(this.peek().charCodeAt(0))) this.index += 1
    }
    const integerEnd = this.index
    let plainInteger = true

    if (this.peek() === '.') {
      plainInteger = false
      this.index += 1
      if (!isDigitCode(this.peek().charCodeAt(0))) {
        this.fail('INVALID_NUMBER', path, this.index, 'A fraction requires at least one digit')
      }
      while (isDigitCode(this.peek().charCodeAt(0))) this.index += 1
    }

    if (this.peek() === 'e' || this.peek() === 'E') {
      plainInteger = false
      this.index += 1
      if (this.peek() === '+' || this.peek() === '-') this.index += 1
      if (!isDigitCode(this.peek().charCodeAt(0))) {
        this.fail('INVALID_NUMBER', path, this.index, 'An exponent requires at least one digit')
      }
      while (isDigitCode(this.peek().charCodeAt(0))) this.index += 1
    }

    const literal = this.text.slice(start, this.index)
    if (plainInteger) {
      const digits = this.text.slice(integerStart, integerEnd)
      if (isUnsafeIntegerLiteral(digits)) {
        this.fail('UNSAFE_INTEGER', path, start, 'Plain integers must be within the safe integer range', { literal })
      }
    }

    if (isInvalidNumberContinuation(this.peek())) {
      this.fail('INVALID_NUMBER', path, this.index, 'Invalid JSON number continuation')
    }

    const value = Number(literal)
    if (!Number.isFinite(value)) {
      this.fail('NON_FINITE_NUMBER', path, start, 'JSON numbers must be finite', { literal })
    }
    return value
  }

  private expectLiteral(literal: 'true' | 'false' | 'null', path: string): void {
    if (!this.text.startsWith(literal, this.index)) {
      this.fail('INVALID_JSON_SYNTAX', path, this.index, `Expected ${literal}`)
    }
    this.index += literal.length
  }

  private skipWhitespace(): void {
    while (this.index < this.text.length) {
      const char = this.peek()
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') return
      this.index += 1
    }
  }

  private peek(): string {
    return this.text.charAt(this.index)
  }

  private fail(
    code: CanonicalJsonErrorCode,
    path: string,
    offset: number,
    message: string,
    detail: CanonicalJsonErrorDetail = {},
  ): never {
    const location = sourceLocation(this.text, offset)
    throw new CanonicalJsonError(
      code,
      path,
      `${message} at line ${String(location.line)}, column ${String(location.column)}`,
      { ...detail, offset, ...location },
    )
  }
}

function serializeJsonValue(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      return serializeNumber(value, path)
    case 'string':
      return serializeString(value, path)
    case 'object':
      return serializeObject(value, path, ancestors)
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new CanonicalJsonError('UNSUPPORTED_VALUE', path, `${typeof value} is not a JSON value`, {
        valueType: typeof value,
      })
    default:
      throw new CanonicalJsonError('UNSUPPORTED_VALUE', path, 'Value is not JSON', {
        valueType: typeof value,
      })
  }
}

function serializeNumber(value: number, path: string): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalJsonError('NON_FINITE_NUMBER', path, 'JSON numbers must be finite', {
      valueType: 'number',
    })
  }
  const serialized = JSON.stringify(value)
  return serialized
}

function serializeString(value: string, path: string, key?: string): string {
  if (!value.isWellFormed()) {
    throw new CanonicalJsonError('LONE_SURROGATE', path, 'JSON strings must be well-formed Unicode', {
      ...(key === undefined ? {} : { key }),
    })
  }
  return JSON.stringify(value)
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  if (ancestors.has(value)) {
    throw new CanonicalJsonError('CYCLIC_REFERENCE', path, 'Cyclic references are not JSON')
  }
  if (Array.isArray(value)) {
    return serializeArray(value as readonly unknown[], path, ancestors)
  }
  return serializePlainObject(value, path, ancestors)
}

function serializeArray(value: readonly unknown[], path: string, ancestors: Set<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw unsupportedObject(value, path)
  }
  const symbol = Object.getOwnPropertySymbols(value).at(0)
  if (symbol !== undefined) throw symbolKeyError(path, symbol)

  const length = value.length
  const presentIndices = new Set<string>()
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (descriptor === undefined) continue
    const index = arrayIndex(name)
    if (index === null || index >= length) {
      throw new CanonicalJsonError('ARRAY_EXTRA_PROPERTY', propertyPath(path, name), 'Arrays cannot have extra properties', {
        key: name,
      })
    }
    const itemPath = `${path}[${String(index)}]`
    if (descriptor.get !== undefined || descriptor.set !== undefined) {
      throw new CanonicalJsonError('ACCESSOR_PROPERTY', itemPath, 'JSON arrays cannot contain accessors', {
        key: name,
      })
    }
    if (descriptor.enumerable !== true) {
      throw new CanonicalJsonError('NON_ENUMERABLE_PROPERTY', itemPath, 'JSON array elements must be enumerable', {
        key: name,
      })
    }
    presentIndices.add(name)
  }

  ancestors.add(value)
  try {
    const items: string[] = []
    for (let index = 0; index < length; index += 1) {
      const name = String(index)
      const itemPath = `${path}[${String(index)}]`
      if (!presentIndices.has(name)) {
        throw new CanonicalJsonError('SPARSE_ARRAY', itemPath, 'Sparse arrays are not JSON', {
          key: name,
        })
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, name)
      if (descriptor === undefined) {
        throw new CanonicalJsonError('SPARSE_ARRAY', itemPath, 'Sparse arrays are not JSON', {
          key: name,
        })
      }
      const item: unknown = descriptor.value
      items.push(serializeJsonValue(item, itemPath, ancestors))
    }
    return `[${items.join(',')}]`
  } finally {
    ancestors.delete(value)
  }
}

function serializePlainObject(value: object, path: string, ancestors: Set<object>): string {
  const prototype = Object.getPrototypeOf(value) as object | null
  if (prototype !== Object.prototype && prototype !== null) {
    throw unsupportedObject(value, path)
  }
  const symbol = Object.getOwnPropertySymbols(value).at(0)
  if (symbol !== undefined) throw symbolKeyError(path, symbol)

  const descriptors = Object.getOwnPropertyDescriptors(value)
  const keys = Object.keys(descriptors).sort()
  ancestors.add(value)
  try {
    const members: string[] = []
    for (const key of keys) {
      const descriptor = descriptors[key]
      const memberPath = propertyPath(path, key)
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        throw new CanonicalJsonError('ACCESSOR_PROPERTY', memberPath, 'JSON objects cannot contain accessors', {
          key,
        })
      }
      if (descriptor.enumerable !== true) {
        throw new CanonicalJsonError('NON_ENUMERABLE_PROPERTY', memberPath, 'JSON object properties must be enumerable', {
          key,
        })
      }
      const member: unknown = descriptor.value
      members.push(`${serializeString(key, memberPath, key)}:${serializeJsonValue(member, memberPath, ancestors)}`)
    }
    return `{${members.join(',')}}`
  } finally {
    ancestors.delete(value)
  }
}

function unsupportedObject(value: object, path: string): CanonicalJsonError {
  const constructorName = constructorNameOf(value)
  return new CanonicalJsonError(
    'UNSUPPORTED_OBJECT',
    path,
    `${constructorName} objects are not plain JSON objects`,
    { constructorName },
  )
}

function constructorNameOf(value: object): string {
  let prototype = Object.getPrototypeOf(value) as object | null
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'constructor')
    const constructor: unknown = descriptor?.value
    if (typeof constructor === 'function' && constructor.name.length > 0) return constructor.name
    prototype = Object.getPrototypeOf(prototype) as object | null
  }
  return 'Unsupported'
}

function symbolKeyError(path: string, symbol: symbol): CanonicalJsonError {
  const key = String(symbol)
  return new CanonicalJsonError('SYMBOL_KEY', path, 'Symbol keys are not JSON object keys', { key })
}

function arrayIndex(name: string): number | null {
  if (name === '0') return 0
  if (name.length === 0 || name.charCodeAt(0) === ASCII_ZERO) return null
  for (let index = 0; index < name.length; index += 1) {
    if (!isDigitCode(name.charCodeAt(index))) return null
  }
  const value = Number(name)
  return Number.isSafeInteger(value) ? value : null
}

function isUnsafeIntegerLiteral(digits: string): boolean {
  if (digits.length !== MAX_SAFE_INTEGER_LITERAL.length) {
    return digits.length > MAX_SAFE_INTEGER_LITERAL.length
  }
  return digits > MAX_SAFE_INTEGER_LITERAL
}

function isInvalidNumberContinuation(char: string): boolean {
  if (char === '') return false
  const code = char.charCodeAt(0)
  return (
    isDigitCode(code) ||
    isAsciiLetterCode(code) ||
    code === UNDERSCORE ||
    char === '.' ||
    char === '+' ||
    char === '-'
  )
}

function isDigitCode(code: number): boolean {
  return code >= ASCII_ZERO && code <= ASCII_NINE
}

function isAsciiLetterCode(code: number): boolean {
  return (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z) || (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z)
}

function isHexLiteral(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const digit = isDigitCode(code)
    const upper = code >= ASCII_UPPER_A && code <= 0x46
    const lower = code >= ASCII_LOWER_A && code <= 0x66
    if (!digit && !upper && !lower) return false
  }
  return true
}

function propertyPath(parent: string, key: string): string {
  return `${parent}[${JSON.stringify(key)}]`
}

function quoteForMessage(key: string): string {
  return JSON.stringify(key)
}

function sourceLocation(text: string, offset: number): { readonly line: number; readonly column: number } {
  const end = Math.min(Math.max(offset, 0), text.length)
  let line = 1
  let column = 1
  for (let index = 0; index < end; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a && index + 1 < end) index += 1
      line += 1
      column = 1
    } else if (code === 0x0a) {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
  return { line, column }
}
