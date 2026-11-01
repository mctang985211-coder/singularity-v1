import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@singularity/protocol'

/** Present native argument failures; parsing and validation stay with DSH. */
export function withToolExample(tool: ToolDefinition, example: JsonValue): ToolDefinition {
  return {
    ...tool,
    finalizeContent(exec, result) {
      if (result.isError) {
        return [...result.content, { type: 'text', text: JSON.stringify({ status: 'failed', example,
          nextAction: 'Correct the arguments using the declared schema and current IDs.' }) }]
      }
      return tool.finalizeContent?.(exec, result)
    },
  }
}
