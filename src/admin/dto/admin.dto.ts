import { ApiPropertyOptional } from '@nestjs/swagger';
import { CollectionMode, PlatformFeeMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class PageQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

export const USER_STATUSES = [
  'active',
  'suspended',
  'unverified',
  'pending',
  'locked',
] as const;

export class AdminUsersQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: USER_STATUSES })
  @IsOptional()
  @IsIn(USER_STATUSES as unknown as string[])
  status?: (typeof USER_STATUSES)[number];

  @ApiPropertyOptional({ enum: ['USER', 'SUPER_ADMIN'] })
  @IsOptional()
  @IsIn(['USER', 'SUPER_ADMIN'])
  role?: 'USER' | 'SUPER_ADMIN';
}

export class SuspendUserDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ResetAccessDto {
  @ApiPropertyOptional({
    description: 'Email a password-reset code (default true)',
  })
  @IsOptional()
  @IsBoolean()
  sendResetEmail?: boolean;
}

export class AdminGroupsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'],
  })
  @IsOptional()
  @IsIn(['UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED'])
  verification?: 'UNVERIFIED' | 'PENDING' | 'VERIFIED' | 'REJECTED';

  @ApiPropertyOptional({ enum: ['exclude', 'include', 'only'] })
  @IsOptional()
  @IsIn(['exclude', 'include', 'only'])
  deleted?: 'exclude' | 'include' | 'only';
}

export class AuditQueryDto extends PageQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() actorId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() groupId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() entityType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() entityId?: string;
  @ApiPropertyOptional({
    description: 'Prefix match, e.g. `deposit.` or `loan.approve`',
  })
  @IsOptional()
  @IsString()
  action?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() to?: string;
  @ApiPropertyOptional({ enum: ['json', 'csv'] })
  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}

export class PlatformSettingsDto {
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  supportedCurrencies?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(3)
  defaultCurrency?: string;

  @ApiPropertyOptional({ enum: CollectionMode })
  @IsOptional()
  @IsEnum(CollectionMode)
  collectionMode?: CollectionMode;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  platformAccountName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  platformAccountMsisdn?: string | null;

  @ApiPropertyOptional({ enum: PlatformFeeMode })
  @IsOptional()
  @IsEnum(PlatformFeeMode)
  feeMode?: PlatformFeeMode;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  feeValue?: number;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  feeMin?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @Min(0)
  feeMax?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  signupsEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Admins and treasurers must use two-step verification',
  })
  @IsOptional()
  @IsBoolean()
  requireLeaderTwoFactor?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null && v !== '')
  @IsEmail()
  supportEmail?: string | null;
}

/** Omitted field = keep, null or '' = clear, value = replace (secrets are write-only). */
export class PaymentAccountDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(120)
  accountName?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  msisdn?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  collectionUserId?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  collectionApiKey?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  collectionSubscriptionKey?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  disbursementUserId?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  disbursementApiKey?: string | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  disbursementSubscriptionKey?: string | null;
}

export class DeletionQueryDto {
  @ApiPropertyOptional({
    enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'],
  })
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
}

export class DeletionDecisionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class DeletionRejectDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}
