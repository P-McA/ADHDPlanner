import { BadRequestException } from '@nestjs/common';

/**
 * The "Next up" keyset cursor: where the last page ended, and the instant the
 * list was ranked at, so every page is scored against the same day.
 *
 * Opaque to clients (base64url JSON) and checked on the way back in: a cursor
 * that does not decode to this exact shape is a 400, never a silent first page.
 */
export interface NextCursor {
  asOf: string;
  score: number;
  id: string;
}

export function encodeNextCursor(cursor: NextCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeNextCursor(raw: string): NextCursor {
  let value: unknown;

  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequestException('cursor is not one this API issued');
  }

  const candidate = value as Partial<NextCursor> | null;

  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.asOf !== 'string' ||
    Number.isNaN(Date.parse(candidate.asOf)) ||
    typeof candidate.score !== 'number' ||
    !Number.isFinite(candidate.score) ||
    typeof candidate.id !== 'string' ||
    candidate.id === ''
  ) {
    throw new BadRequestException('cursor is not one this API issued');
  }

  return { asOf: candidate.asOf, score: candidate.score, id: candidate.id };
}
