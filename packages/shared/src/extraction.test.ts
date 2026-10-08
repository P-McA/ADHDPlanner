import { describe, expect, it } from 'vitest';

import {
  DraftCandidateSchema,
  ExtractionResponseSchema,
  extractionResponseJsonSchema,
} from './extraction.js';

describe('DraftCandidateSchema', () => {
  it('keeps a well-formed row, trimming the title', () => {
    expect(
      DraftCandidateSchema.parse({
        title: '  Book the car in ',
        dueAt: '2026-09-11T09:00:00+01:00',
        manualPriority: 'high',
      }),
    ).toEqual({ title: 'Book the car in', dueAt: '2026-09-11T09:00:00+01:00', manualPriority: 'high' });
  });

  it('rejects a row whose title is blank, rather than inventing one', () => {
    expect(DraftCandidateSchema.safeParse({ title: '   ', dueAt: null, manualPriority: null }).success).toBe(
      false,
    );
  });

  it('nulls fields it cannot trust instead of dropping the whole row', () => {
    expect(
      DraftCandidateSchema.parse({ title: 'Call the dentist', dueAt: 'tuesday-ish', manualPriority: 'ASAP' }),
    ).toEqual({ title: 'Call the dentist', dueAt: null, manualPriority: null });
    expect(DraftCandidateSchema.parse({ title: 'Call the dentist' })).toEqual({
      title: 'Call the dentist',
      dueAt: null,
      manualPriority: null,
    });
  });
});

describe('extractionResponseJsonSchema', () => {
  it('is the request contract with every field required and nothing extra allowed', () => {
    const schema = extractionResponseJsonSchema() as {
      additionalProperties: boolean;
      properties: { tasks: { items: { required: string[]; additionalProperties: boolean } } };
    };

    expect(schema).not.toHaveProperty('$schema');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.tasks.items.additionalProperties).toBe(false);
    expect(schema.properties.tasks.items.required).toEqual(['title', 'dueAt', 'manualPriority']);
  });

  it('describes the same shape the request schema accepts', () => {
    expect(
      ExtractionResponseSchema.safeParse({
        tasks: [{ title: 'Pay the bill', dueAt: null, manualPriority: null }],
      }).success,
    ).toBe(true);
    expect(ExtractionResponseSchema.safeParse({ tasks: [{ title: 'Pay the bill' }] }).success).toBe(false);
  });
});
