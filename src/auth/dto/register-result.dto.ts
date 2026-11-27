import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Normal sign-up: verify email with OTP before receiving a JWT. */
export class RegisterPendingDto {
  @ApiProperty({ example: true })
  needsEmailVerification!: true;

  @ApiProperty({ example: 'member@ekimina.rw' })
  email!: string;

  @ApiPropertyOptional({
    example: 'We sent a verification code to your email.',
  })
  message?: string;
}
