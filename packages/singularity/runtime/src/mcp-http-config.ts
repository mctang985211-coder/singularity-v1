import type { JsonObject, JsonValue } from '@singularity/protocol'

import { MethodResourceError } from './errors.ts'

/** Strict HTTP transport config for the A4 native DSH streamable-http mount. */
export interface McpHttpConfig {
  readonly v: 1
  readonly serverName: string
  readonly transport: 'streamable-http'
  readonly url: string
  readonly headers: Readonly<Record<string, never>>
  readonly toolCallTimeoutMs: number
  readonly maxInstructionBytes: number
  readonly failOnStartupError: true
  readonly reconnect: { readonly enabled: false }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Validates one frozen HTTP deployment config. This module owns only transport
 * config shape/policy; Method/catalog/Composition identity stays in
 * `mcp-resources.ts`.
 */
export function validateHttpConfig(
  value: JsonObject,
  serverName: string,
  limits: { readonly maxInstructionBytes: number; readonly toolCallTimeoutMs: number },
  instructionBytes: number,
): McpHttpConfig {
  assertExactKeys(value, [
    'v', 'serverName', 'transport', 'url', 'headers',
    'toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError', 'reconnect',
    'digest',
  ], 'MCP HTTP config')
  if (value['v'] !== 1) fail('CONTRACT_INVALID', 'MCP HTTP config v must be 1')
  if (value['serverName'] !== serverName) fail('CONTRACT_INVALID', 'MCP HTTP config serverName must equal manifest.serverName')
  if (value['transport'] !== 'streamable-http') fail('CONTRACT_INVALID', 'MCP HTTP config transport must be streamable-http')
  const url = value['url']
  if (typeof url !== 'string') fail('CONTRACT_INVALID', 'MCP HTTP config url must be a string')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    fail('CONTRACT_INVALID', 'MCP HTTP config url must be a valid absolute URL', error)
  }
  if (parsed.protocol !== 'http:') {
    fail('UNSUPPORTED_RESOURCES', 'S4-A4 only allows unencrypted loopback http URLs')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    fail('UNSUPPORTED_RESOURCES', 'MCP HTTP config url must not contain userinfo credentials')
  }
  if (url.includes('?') || url.includes('#')) {
    fail('UNSUPPORTED_RESOURCES', 'MCP HTTP config url must not contain query or fragment data')
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    fail('UNSUPPORTED_RESOURCES', 'MCP HTTP config url must not contain query or fragment data')
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    fail('UNSUPPORTED_RESOURCES', `MCP HTTP config host ${JSON.stringify(parsed.hostname)} is not in the loopback allowlist`)
  }
  const headers = value['headers']
  if (!isRecord(headers)) fail('CONTRACT_INVALID', 'MCP HTTP config headers must be an object')
  if (Object.keys(headers).length !== 0) {
    fail('UNSUPPORTED_RESOURCES', 'S4-A4 rejects HTTP headers and raw secrets')
  }
  const toolCallTimeoutMs = positiveInteger(value['toolCallTimeoutMs'], 'MCP HTTP config toolCallTimeoutMs', limits.toolCallTimeoutMs)
  const maxInstructionBytes = positiveInteger(value['maxInstructionBytes'], 'MCP HTTP config maxInstructionBytes', limits.maxInstructionBytes)
  if (instructionBytes > maxInstructionBytes) {
    fail('CONTRACT_INVALID', `MCP HTTP config maxInstructionBytes ${String(maxInstructionBytes)} cannot carry the ${String(instructionBytes)} byte instructions`)
  }
  if (value['failOnStartupError'] !== true) fail('CONTRACT_INVALID', 'MCP HTTP config must set failOnStartupError true')
  const reconnect = value['reconnect']
  if (!isRecord(reconnect)) fail('CONTRACT_INVALID', 'MCP HTTP config reconnect must be an object')
  assertExactKeys(reconnect, ['enabled'], 'MCP HTTP config reconnect')
  if (reconnect['enabled'] !== false) fail('CONTRACT_INVALID', 'MCP HTTP config must disable reconnect')
  return {
    v: 1,
    serverName,
    transport: 'streamable-http',
    url: parsed.href,
    headers: {},
    toolCallTimeoutMs,
    maxInstructionBytes,
    failOnStartupError: true,
    reconnect: { enabled: false },
  }
}

function assertExactKeys(value: JsonObject, keys: readonly string[], label: string): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some(key => !keys.includes(key))) {
    fail('CONTRACT_INVALID', `${label} must contain exactly ${keys.join(', ')}`)
  }
}

function positiveInteger(value: JsonValue | undefined, label: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > max) {
    fail('CONTRACT_INVALID', `${label} must be a positive safe integer <= ${String(max)}`)
  }
  return value
}

function isRecord(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fail(code: 'CONTRACT_INVALID' | 'UNSUPPORTED_RESOURCES', message: string, cause?: unknown): never {
  throw new MethodResourceError('method', code, message, cause === undefined ? undefined : { cause })
}
