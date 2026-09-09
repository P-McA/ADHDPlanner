import type { Task } from '@adhd/shared';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { TaskList } from './task-list';

/**
 * Rendering only.
 *
 * These tests touch no API and prove nothing about one. What they pin is the
 * pair of rules that live in the row itself: draft-ness is `source` *and*
 * `confirmedAt`, and the complete button does not offer an action the server
 * would refuse. The contract proof is `test/mobile-client.e2e-spec.ts` in
 * apps/api, against the real thing — see CLAUDE.md on why that division is
 * not optional.
 */

const task = (over: Partial<Task> = {}): Task => ({
  id: 'a0000000-0000-4000-8000-000000000001',
  userId: 'u1',
  title: 'buy milk',
  description: null,
  status: 'pending',
  dueAt: null,
  manualPriority: 'med',
  source: 'manual',
  parentTaskId: null,
  ingestionRecordId: null,
  confirmedAt: null,
  completedAt: null,
  createdAt: '2026-09-08T10:00:00.000Z',
  updatedAt: '2026-09-08T10:00:00.000Z',
  ...over,
});

describe('TaskList', () => {
  it('completes the task the button belongs to', async () => {
    const onComplete = jest.fn();
    const item = task();

    await render(<TaskList tasks={[item]} busyId={null} onComplete={onComplete} />);
    await fireEvent.press(screen.getByTestId(`complete-${item.id}`));

    expect(onComplete).toHaveBeenCalledWith(item.id);
  });

  it('badges an unconfirmed suggestion', async () => {
    const item = task({ source: 'ai_suggested', confirmedAt: null });

    await render(<TaskList tasks={[item]} busyId={null} onComplete={jest.fn()} />);

    expect(screen.getByTestId(`draft-badge-${item.id}`)).toBeTruthy();
  });

  it('drops the badge once the suggestion is approved, source and all', async () => {
    // The web row got this wrong for a while: `source` stays `ai_suggested`
    // for ever, so a source-only check badges an approved task permanently.
    const item = task({ source: 'ai_suggested', confirmedAt: '2026-09-08T11:00:00.000Z' });

    await render(<TaskList tasks={[item]} busyId={null} onComplete={jest.fn()} />);

    expect(screen.queryByTestId(`draft-badge-${item.id}`)).toBeNull();
  });

  it('will not offer to complete an unconfirmed draft', async () => {
    // A 409 from the API if it did. The server is what enforces this; the row
    // simply does not ask.
    const onComplete = jest.fn();
    const item = task({ source: 'ai_suggested', confirmedAt: null });

    await render(<TaskList tasks={[item]} busyId={null} onComplete={onComplete} />);
    await fireEvent.press(screen.getByTestId(`complete-${item.id}`));

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('shows a completed task as done rather than offering the button again', async () => {
    const item = task({ status: 'done', completedAt: '2026-09-08T11:00:00.000Z' });

    await render(<TaskList tasks={[item]} busyId={null} onComplete={jest.fn()} />);

    expect(screen.queryByTestId(`complete-${item.id}`)).toBeNull();
  });
});
