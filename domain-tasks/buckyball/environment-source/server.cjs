const { execFile } = require('node:child_process')
const { mkdir } = require('node:fs/promises')
const { createRequire } = require('node:module')
const { join } = require('node:path')
const { promisify } = require('node:util')

const dependencyRoot = process.env.BUCKYBALL_MCP_ROOT
const baseline = process.env.BUCKYBALL_BASELINE
if (dependencyRoot === undefined || baseline === undefined) {
  throw new Error('The env builder must provide BUCKYBALL_MCP_ROOT and BUCKYBALL_BASELINE')
}
const preparedRequire = createRequire(join(dependencyRoot, 'package.json'))
const { fromJsonSchema, McpServer } = preparedRequire('@modelcontextprotocol/server')
const { serveStdio } = preparedRequire('@modelcontextprotocol/server/stdio')
const manifest = require('./manifest.json')
const definitions = require('./tools.json')[0].server.exposedTools

function runBbdev(project, args, signal) {
  return new Promise(resolveResult => {
    execFile('nix', ['develop', '--command', 'bash', '-c', 'exec bbdev "$@"', '--', ...args],
      { cwd: project, signal, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, BUCKYBALL_LLVM_BUILD: join(baseline, 'stack/compiler/thirdparty/buddy-mlir/llvm/build') } }, (error, stdout, stderr) => {
        const result = { exit: error?.code ?? 0, stdout, stderr, ...(error === null ? {} : { error: error.message }) }
        resolveResult({ isError: error !== null, content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
      })
  })
}

const server = new McpServer({ name: manifest.serverName, version: '1.0.0' },
  { capabilities: { tools: {} }, instructions: manifest.instructions })
for (const definition of definitions) {
  server.registerTool(definition.name, {
    description: definition.description,
    inputSchema: fromJsonSchema(definition.parameters),
  }, async (input, extra) => {
    if (definition.name === 'checkout') {
      await mkdir(input.project)
      await promisify(execFile)('cp', ['--archive', '--reflink=auto', `${baseline}/.`, input.project], { signal: extra.mcpReq.signal })
      return runBbdev(input.project, ['config', '--install'], extra.mcpReq.signal)
    }
    return runBbdev(input.project, input.args, extra.mcpReq.signal)
  })
}
serveStdio(() => server)
