import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class PhoneDto {
  @ApiProperty({ example: '0788123456' })
  @IsString()
  @MaxLength(20)
  phone!: string;
}

export class PhoneVerifyDto extends PhoneDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code.' })
  code!: string;
}

export class CodeDto {
  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(/^\s*\d{3}\s?\d{3}\s*$/, { message: 'Enter the 6-digit code.' })
  code!: string;
}

export class TwoFactorVerifyDto {
  @ApiProperty() @IsString() @MaxLength(2000) challengeToken!: string;

  @ApiPropertyOptional({ description: 'Authenticator or SMS code' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  code?: string;

  @ApiPropertyOptional({ description: 'One of the recovery codes' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  recoveryCode?: string;
}

export class ChallengeDto {
  @ApiProperty() @IsString() @MaxLength(2000) challengeToken!: string;
}

export class RefreshDto {
  @ApiPropertyOptional({
    description: 'Only for clients that do not use the cookie',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  refreshToken?: string;
}

export class PasswordDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(72) password!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  currentPassword!: string;

  @ApiProperty() @IsString() @MinLength(8) @MaxLength(72) newPassword!: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  fullName?: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'null removes the phone number',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  phoneNumber?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'URL from POST /upload; null removes it',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUrl({ require_tld: false })
  @MaxLength(500)
  image?: string | null;
}

export class DeletionRequestDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
