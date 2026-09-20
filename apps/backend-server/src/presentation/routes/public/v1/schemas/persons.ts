import type {
  CreatePersonRequest,
  CreateRelationshipRequest,
  UpdatePersonRequest,
  UpdateRelationshipRequest,
} from '@aftercare/public-contracts'
import { z, type ZodType } from 'zod'
import { expectedVersion, idSchema, isoDate, longText, shortText } from './common.js'

const personRole = z.enum(['HEIR_CANDIDATE', 'DECEASED', 'RELATED', 'PROFESSIONAL'])
const specialCircumstance = z.enum(['MINOR', 'MISSING', 'CAPACITY_CONCERN'])
const relationshipKind = z.enum([
  'SPOUSE',
  'CHILD',
  'PARENT',
  'SIBLING',
  'GRANDCHILD',
  'GRANDPARENT',
  'ADOPTED_CHILD',
  'OTHER',
])

const personFields = {
  name: shortText.min(1),
  nameKana: shortText.optional(),
  relationship: shortText,
  role: personRole.optional(),
  isHeir: z.boolean().optional(),
  dateOfBirth: isoDate.optional(),
  specialCircumstance: specialCircumstance.nullable().optional(),
  contact: shortText.optional(),
  note: longText.optional(),
}

export const createPersonSchema = z.object(personFields).strict() satisfies ZodType<CreatePersonRequest>

export const updatePersonSchema = z
  .object({ ...personFields, name: shortText.min(1).optional(), relationship: shortText.optional(), expectedVersion })
  .strict() satisfies ZodType<UpdatePersonRequest>

export const createRelationshipSchema = z
  .object({
    fromPersonId: idSchema,
    toPersonId: idSchema,
    kind: relationshipKind,
    note: longText.optional(),
  })
  .strict() satisfies ZodType<CreateRelationshipRequest>

export const updateRelationshipSchema = z
  .object({ kind: relationshipKind.optional(), note: longText.optional(), expectedVersion })
  .strict() satisfies ZodType<UpdateRelationshipRequest>
