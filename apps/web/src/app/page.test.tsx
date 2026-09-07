import { TASK_STATUSES } from '@adhd/shared';
import { render, screen } from '@testing-library/react';

import HomePage from './page';

describe('HomePage', () => {
  it('renders the app heading', () => {
    render(<HomePage />);

    expect(screen.getByRole('heading', { level: 1, name: 'ADHD Planner' })).toBeInTheDocument();
  });

  it('lists every task status from the shared contract', () => {
    render(<HomePage />);

    // Consumes the shared package at runtime, not just at type level — this is
    // what catches a broken workspace link that typechecking alone would miss.
    expect(screen.getAllByRole('listitem')).toHaveLength(TASK_STATUSES.length);
  });
});
