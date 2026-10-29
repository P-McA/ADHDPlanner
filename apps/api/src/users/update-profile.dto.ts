import { isIanaTimeZone, type UpdateProfileInput } from '@adhd/shared';
import {
  buildMessage,
  registerDecorator,
  type ValidationOptions,
  IsString,
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
 * Validated at the edge because a zone Intl cannot resolve would not fail
 * here — it would fail later, in every streak and reminder computed for this
 * user (`usableTimeZone` would quietly fall back to UTC).
 */
export class UpdateProfileDto implements UpdateProfileInput {
  @IsString()
  @IsIanaTimeZone()
  timezone!: string;
}
