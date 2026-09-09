import { isExpoPushToken, type RegisterPushTokenInput } from '@adhd/shared';
import {
  buildMessage,
  registerDecorator,
  type ValidationOptions,
  IsString,
} from 'class-validator';

/**
 * Wraps the shared predicate as a class-validator rule.
 *
 * The rule itself stays in `@adhd/shared` and is not restated here: the phone
 * checks the same thing before it bothers posting, and two spellings of "what
 * an Expo token looks like" would eventually disagree about some real device.
 */
function IsExpoPushToken(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isExpoPushToken',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (value: unknown) => typeof value === 'string' && isExpoPushToken(value),
        defaultMessage: buildMessage(
          (prefix) => `${prefix}$property must look like ExponentPushToken[...]`,
          options,
        ),
      },
    });
  };
}

/**
 * Body of `POST /me/push-tokens`.
 *
 * The token is validated at the edge because a value that can never work must
 * not become a row: an unsendable token fails on every sweep for ever, and the
 * only sign of it is a `failed` dispatch the user never sees. A 400 at
 * registration is something the client can act on while the user is still
 * looking at the screen.
 */
export class RegisterPushTokenDto implements RegisterPushTokenInput {
  @IsString()
  @IsExpoPushToken()
  token!: string;
}
