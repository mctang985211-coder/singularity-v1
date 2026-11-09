import { cp,readFile,writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { JsonObject } from '@singularity/protocol'
import { loadDomainPackage } from '../../src/domain.ts'

const mcpRoot = fileURLToPath(new URL('../../', import.meta.url))

export async function prepareBuckyballDomain(prepared: string, output = join(prepared, 'domain')) {
  const project = JSON.parse(await readFile(join(prepared, 'project.json'), 'utf8')) as JsonObject & { source: { destination: string } }
  await cp(fileURLToPath(new URL('../../../../domain-tasks/buckyball', import.meta.url)), output, { recursive: true })
  for (const path of ['cases/source.json', 'cases/long-k.json', 'cases/output-tiling.json', 'transfer/smatmul-case.json'].map(relative => join(output, relative))) {
    const definition = JSON.parse(await readFile(path, 'utf8')) as JsonObject
    await writeFile(path, JSON.stringify({ ...project, ...definition, source: project.source }, null, 2))
  }
  const configPath = join(output, 'environment/config.json')
  const config = JSON.parse(await readFile(configPath, 'utf8')) as { env: Record<string, string> }
  config.env.BUCKYBALL_BASELINE = project.source.destination
  config.env.BUCKYBALL_MCP_ROOT = mcpRoot
  await writeFile(configPath, JSON.stringify(config, null, 2))
  return loadDomainPackage(output)
}
