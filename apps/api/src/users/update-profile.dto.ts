import {
  isIanaTimeZone,
  TRACKING_MODES,
  type TrackingMode,
  type UpdateProfileInput,
} from '@adhd/shared';
import {
  buildMessage,
  registerDecorator,
  type ValidationOptions,
  IsBoolean,
  IsIn,
  IsString,
  ValidateIf,
} from 'class-validator';

/**
 * Wraps the shared predicate as a class-validator rule, so the phone and the
 * API agree on what a zone is — the same arrangement as `IsExpoPushToken`.
 */
function IsIanaTimeZone(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isIanaTimeZone',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isIanaTimeZone(value),
        defaultMessage: buildMessage(
          (prefix) => `${prefix}$property must be an IANA time zone such as Europe/London`,
          options,
        ),
      },
    });
  };
}

/**
 * Body of `PATCH /me`.
 *
 * Every field is optional so a client can change one setting — the zone, the
 * tracking mode, the rating visibility — without re-sending the others. A zone
 * is validated at the edge because one Intl cannot resolve would not fail here;
 * it would fail later, in every streak and reminder computed for this user
 * (`usableTimeZone` would quietly fall back to UTC).
 */
export class UpdateProfileDto implements UpdateProfileInput {
  // `ValidateIf`, not `IsOptional`: IsOptional also skips `null`, which Prisma
  // then rejects on these non-nullable columns as a 500 instead of a 400.
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsIanaTimeZone()
  timezone?: string;

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(TRACKING_MODES)
  trackingMode?: TrackingMode;

  @ValidateIf((_object, value) => value !== undefined)
  @IsBoolean()
  showElo?: boolean;
}
