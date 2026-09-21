import { createSkill } from '@mastra/core/skills'
import { resolveSkills } from '../../orchestration/skills/catalog.js'
import type { AgentMode, AgentRole, SkillId, ToolCapability } from '../../orchestration/skills/catalog.js'

export function createAgentSkills(ids: readonly SkillId[], role: AgentRole, mode: AgentMode, capabilities: readonly ToolCapability[]) {
  return resolveSkills(ids, role, mode, capabilities).map((skill) => createSkill({
    name: skill.id, description: skill.description, instructions: skill.instructions,
    'user-invocable': false,
    metadata: { version: skill.version, hash: skill.hash, role: skill.role, outputBoundary: skill.outputBoundary, outputSchema: 'references/output-schema.json' },
    references: { ...skill.references },
  }))
}
