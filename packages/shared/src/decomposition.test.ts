import { describe, expect, it } from 'vitest';

import {
  DecompositionResponseSchema,
  decompositionResponseJsonSchema,
  MAX_STEPS,
  StepCandidateSchema,
  toStepCandidates,
} from './decomposition.js';
import { XP_STEP_COMPLETE, XP_TASK_COMPLETE_BASE } from './gamification.js';

describe('StepCandidateSchema', () => {
  it('keeps a step, trimming its title', () => {
    expect(StepCandidateSchema.parse({ title: '  Find the MOT certificate ' })).toEqual({
      title: 'Find the MOT certificate',
    });
  });

  it('rejects a step with no usable title, rather than inventing one', () => {
    expect(StepCandidateSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(StepCandidateSchema.safeParse({}).success).toBe(false);
  });
});

describe('toStepCandidates', () => {
  it('drops the unusable rows and keeps the order the model gave', () => {
    expect(
      toStepCandidates([{ title: 'Open the bank app' }, { title: '' }, 42, { title: 'Pay the bill' }]),
    ).toEqual([{ title: 'Open the bank app' }, { title: 'Pay the bill' }]);
  });

  it(`never returns more than ${String(MAX_STEPS)} steps — a wall of steps is the opposite of help`, () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `Step ${String(i + 1)}` }));

    expect(toStepCandidates(many)).toHaveLength(MAX_STEPS);
    expect(toStepCandidates(many)[0]).toEqual({ title: 'Step 1' });
  });

  it('drops a step that only repeats the task it was meant to break down', () => {
    expect(
      toStepCandidates([{ title: 'Book the car in' }, { title: 'Ring the garage' }], 'Book the car in'),
    ).toEqual([{ title: 'Ring the garage' }]);
  });
});

describe('decompositionResponseJsonSchema', () => {
  it('is in the form strict mode accepts: everything required, nothing extra', () => {
    const schema = decompositionResponseJsonSchema() as {
      additionalProperties: boolean;
      required: string[];
      properties: { steps: { items: { required: string[]; additionalProperties: boolean } } };
    };

    expect(schema).not.toHaveProperty('$schema');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(['steps']);
    expect(schema.properties.steps.items.required).toEqual(['title']);
    expect(schema.properties.steps.items.additionalProperties).toBe(false);
  });

  it('describes the shape the request schema accepts', () => {
    expect(DecompositionResponseSchema.safeParse({ steps: [{ title: 'Ring them' }] }).success).toBe(
      true,
    );
    expect(DecompositionResponseSchema.safeParse({ steps: [{}] }).success).toBe(false);
  });
});

describe('XP_STEP_COMPLETE', () => {
  it('pays less than finishing a whole task, so splitting one up is not an XP farm', () => {
    expect(XP_STEP_COMPLETE).toBe(2);
    expect(XP_STEP_COMPLETE).toBeLessThan(XP_TASK_COMPLETE_BASE);
  });
});
