import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { InstallmentInterval, InterestMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/** Aligned with `LoanConfig` in `schema.prisma` — rates stored as % per period (0–999.99). */
export class UpsertLoanConfigDto {
  @ApiProperty({
    example: 5.0,
    description: 'Interest % per period (0–999.99).',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(999.99)
  interestRate!: number;

  @ApiProperty({ example: 30, description: 'Full repayment term in days.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  repaymentPeriodDays!: number;

  @ApiProperty({
    example: false,
    description: 'Allow loans above the member’s contribution.',
  })
  @IsBoolean()
  allowExceedContribution!: boolean;

  @ApiPropertyOptional({
    example: 2.5,
    description:
      'Max loan as multiple of contribution; omit when not limiting (nullable in DB).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  @Max(999.99)
  maxLoanMultiplier?: number;

  @ApiProperty({ example: true })
  @IsBoolean()
  allowPartialPayments!: boolean;

  @ApiPropertyOptional({
    example: 1.5,
    description:
      'Penalty % per period when overdue; omit to disable (nullable in DB).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(999.99)
  penaltyRate?: number;

  @ApiProperty({
    example: 7,
    description: 'Days after due before penalties apply.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  gracePeriodDays!: number;

  @ApiPropertyOptional({
    example: 30,
    description:
      'Penalty is charged once per this many overdue days (default 30).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  penaltyPeriodDays?: number;

  @ApiPropertyOptional({
    example: 90,
    description:
      'Mark the loan DEFAULTED this many days after due date + grace; omit/null = never automatically.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  defaultAfterDays?: number | null;

  @ApiPropertyOptional({
    example: true,
    description:
      'Refuse loan requests while the member has late contributions or open fines (default true).',
  })
  @IsOptional()
  @IsBoolean()
  blockIfArrears?: boolean;

  @ApiPropertyOptional({
    enum: InterestMethod,
    description: 'FLAT (default) or REDUCING balance',
  })
  @IsOptional()
  @IsEnum(InterestMethod)
  interestMethod?: InterestMethod;

  @ApiPropertyOptional({
    enum: InstallmentInterval,
    description:
      'SINGLE (one repayment) or WEEKLY / BIWEEKLY / MONTHLY installments',
  })
  @IsOptional()
  @IsEnum(InstallmentInterval)
  installmentInterval?: InstallmentInterval;

  @ApiPropertyOptional({
    example: 1,
    description: 'Accepted guarantors needed before disbursement (0 = none)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(5)
  guarantorsRequired?: number;

  @ApiPropertyOptional({ description: 'Allow topping up an ACTIVE loan' })
  @IsOptional()
  @IsBoolean()
  allowTopUp?: boolean;

  @ApiPropertyOptional({
    example: 50,
    description: '% of not-yet-due interest waived on early full repayment',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  earlyRepaymentRebatePercent?: number;
}
