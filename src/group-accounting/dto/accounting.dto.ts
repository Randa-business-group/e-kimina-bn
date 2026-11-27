import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ContributionInterval,
  ExpenseCategory,
  ExpenseStatus,
  FundType,
  LedgerDirection,
  LedgerEntryType,
  SocialPayoutReason,
  SocialPayoutStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const PAYMENT_METHODS = ['CASH', 'BANK_TRANSFER', 'MTN_MOMO'] as const;

export class LedgerQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() cycleId?: string;
  @ApiPropertyOptional({ enum: FundType })
  @IsOptional()
  @IsEnum(FundType)
  fund?: FundType;
  @ApiPropertyOptional({ enum: LedgerEntryType })
  @IsOptional()
  @IsEnum(LedgerEntryType)
  type?: LedgerEntryType;
  @ApiPropertyOptional() @IsOptional() @IsString() userId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}

export class CycleQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() cycleId?: string;
}

export class AdjustmentDto {
  @ApiProperty({ enum: ['ADJUSTMENT', 'OPENING_BALANCE'] })
  @IsIn(['ADJUSTMENT', 'OPENING_BALANCE'])
  type!: 'ADJUSTMENT' | 'OPENING_BALANCE';

  @ApiProperty({ enum: FundType }) @IsEnum(FundType) fund!: FundType;
  @ApiProperty({ enum: LedgerDirection })
  @IsEnum(LedgerDirection)
  direction!: LedgerDirection;
  @ApiProperty() @Type(() => Number) @IsNumber() @Min(1) amount!: number;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() userId?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() occurredAt?: string;
}

export class ContributionAmountDto {
  @ApiProperty({
    nullable: true,
    description: 'null = use the group default amount',
  })
  @ValidateIf((o: ContributionAmountDto) => o.amount !== null)
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount!: number | null;
}

export class CreateCycleDto {
  @ApiProperty({ example: 'Cycle 2027' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name!: string;
  @ApiProperty({ example: '2027-01-01' }) @IsDateString() startDate!: string;
  @ApiProperty({ example: '2027-12-31' }) @IsDateString() endDate!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateCycleDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() endDate?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class PaymentRecordDto {
  @ApiProperty({ enum: PAYMENT_METHODS })
  @IsIn(PAYMENT_METHODS)
  method!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

export class CreateExpenseDto {
  @ApiProperty() @Type(() => Number) @IsNumber() @Min(1) amount!: number;
  @ApiProperty({ enum: ExpenseCategory })
  @IsEnum(ExpenseCategory)
  category!: ExpenseCategory;
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) description!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  receiptUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() occurredAt?: string;
  @ApiPropertyOptional({ enum: FundType, default: FundType.SAVINGS })
  @IsOptional()
  @IsEnum(FundType)
  fund?: FundType;
}

export class ExpenseQueryDto {
  @ApiPropertyOptional({ enum: ExpenseStatus })
  @IsOptional()
  @IsEnum(ExpenseStatus)
  status?: ExpenseStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() cycleId?: string;
}

export class ReasonBodyDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class SocialFundConfigDto {
  @ApiProperty({ example: 1000 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount!: number;
  @ApiPropertyOptional({ default: 'RWF' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;
  @ApiProperty({ enum: ContributionInterval })
  @IsEnum(ContributionInterval)
  interval!: ContributionInterval;
  @ApiProperty() @IsDateString() startDate!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(31)
  dayOfMonth?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  gracePeriodDays?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(999.99)
  latePenaltyRate?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(30)
  reminderDaysBefore?: number;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxPayoutAmount?: number | null;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SocialPayoutRequestDto {
  @ApiPropertyOptional({
    description: 'Leaders may request for another member; default = yourself',
  })
  @IsOptional()
  @IsString()
  beneficiaryUserId?: string;

  @ApiProperty() @Type(() => Number) @IsNumber() @Min(1) amount!: number;
  @ApiProperty({ enum: SocialPayoutReason })
  @IsEnum(SocialPayoutReason)
  reason!: SocialPayoutReason;
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  description!: string;
}

export class SocialPayoutQueryDto {
  @ApiPropertyOptional({ enum: SocialPayoutStatus })
  @IsOptional()
  @IsEnum(SocialPayoutStatus)
  status?: SocialPayoutStatus;
}

export class GenerateRotationDto {
  @ApiProperty({ enum: ['JOIN_ORDER', 'RANDOM', 'CUSTOM'] })
  @IsIn(['JOIN_ORDER', 'RANDOM', 'CUSTOM'])
  order!: 'JOIN_ORDER' | 'RANDOM' | 'CUSTOM';

  @ApiPropertyOptional({
    type: [String],
    description: 'CUSTOM: every active member exactly once',
  })
  @ValidateIf((o: GenerateRotationDto) => o.order === 'CUSTOM')
  @IsArray()
  @ArrayMinSize(2)
  @IsString({ each: true })
  userIds?: string[];

  @ApiPropertyOptional({ description: 'Rebuild existing upcoming slots' })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

export class RotationPayDto extends PaymentRecordDto {
  @ApiPropertyOptional({ description: 'Defaults to the expected pot' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount?: number;
}

export class SwapRequestDto {
  @ApiProperty() @IsString() fromSlotId!: string;
  @ApiProperty() @IsString() toSlotId!: string;
}

export class SwapResponseDto {
  @ApiProperty() @IsBoolean() accept!: boolean;
}
