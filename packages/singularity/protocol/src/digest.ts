import { createHash } from 'node:crypto'

import { z } from 'zod'

import { canonicalize, parseJsonText } from './json.ts'
import type { JsonObject, JsonValue } from './json.ts'

/** Frozen digest domains from docs/framework.md §10.1; order is protocol-significant. */
export const DIGEST_DOMAINS = [
  'fact',
  'contract',
  'method',
  'object',
  'composition',
  'evidence',
  'preview',
  'round-plan',
  'command',
] as const

export type DigestDomain = (typeof DIGEST_DOMAINS)[number]

export const digestDomainSchema = z.enum(DIGEST_DOMAINS)

/** A lowercase hexadecimal SHA-256 digest prefixed with `sha256:`. */
export const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)

export type Digest = z.infer<typeof digestSchema>

const DIGEST_PREFIX = 'singularity/v1/'
const textEncoder = new TextEncoder()

/** Hashes `singularity/v1/<domain>\n` followed by the supplied raw bytes. */
export function computeDigestBytes(domain: DigestDomain, bytes: Uint8Array): Digest {
  const validDomain = digestDomainSchema.parse(domain)
  const hash = createHash('sha256')
  hash.update(`${DIGEST_PREFIX}${validDomain}\n`, 'utf8')
  hash.update(bytes)
  return `sha256:${hash.digest('hex')}`
}

/**
 * Hashes the canonical JSON payload after removing its outermost `digest` field.
 * Nested digest fields are part of the payload and remain covered.
 */
export function computeDigest(domain: DigestDomain, payload: JsonValue): Digest {
  const normalized = parseJsonText(canonicalize(payload))
  const withoutOuterDigest = stripOutermostDigest(normalized)
  return computeDigestBytes(domain, textEncoder.encode(canonicalize(withoutOuterDigest)))
}

/** Returns a sealed copy without mutating the payload. */
export function seal<Payload extends JsonObject>(
  domain: DigestDomain,
  payload: Payload,
): Payload & { readonly digest: Digest } {
  const digest = computeDigest(domain, payload)
  return { ...payload, digest }
}

/** Recomputes the digest and rejects tampering, malformed values, and wrong domains. */
export function verifyDigest(domain: DigestDomain, value: JsonValue): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const digest = value['digest']
  if (typeof digest !== 'string' || !digestSchema.safeParse(digest).success) return false
  try {
    return computeDigest(domain, value) === digest
  } catch {
    return false
  }
}

function stripOutermostDigest(payload: JsonValue): JsonValue {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const stripped: Record<string, JsonValue> = {}
  for (const [key, entry] of Object.entries(payload)) {
    if (key !== 'digest') stripped[key] = entry
  }
  return stripped
}
