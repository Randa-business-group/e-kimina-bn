import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DepositPaymentMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateDepositDto {
  @ApiProperty({ example: 17000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  amount!: number;

  @ApiProperty({ enum: DepositPaymentMethod })
  @IsEnum(DepositPaymentMethod)
  paymentMethod!: DepositPaymentMethod;

  @ApiPropertyOptional({
    description: 'Required when paymentMethod is MTN_MOMO',
  })
  @IsOptional()
  @IsString()
  @MinLength(5)
  phone?: string;

  @ApiPropertyOptional({
    description:
      'Required when paymentMethod is MANUAL_TRANSFER — public URL of the uploaded receipt (e.g. from POST /upload).',
  })
  @ValidateIf(
    (o: CreateDepositDto) =>
      o.paymentMethod === DepositPaymentMethod.MANUAL_TRANSFER,
  )
  @IsString()
  @MinLength(8)
  @MaxLength(2048)
  proofImageUrl?: string;

  @ApiPropertyOptional({
    description:
      'When set, this payment repays that member loan (same MoMo/manual rules as a normal deposit).',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  memberLoanId?: string;

  @ApiPropertyOptional({
    description:
      'Pay contributions/fines and the open loan in one deposit (amount = deposit-preview?includeLoan=true total).',
  })
  @IsOptional()
  @IsBoolean()
  includeLoanRepayment?: boolean;

  @ApiPropertyOptional({
    description:
      'With memberLoanId: pay the early-payoff amount (loan-repayment-preview.earlyPayoff.amount); the rebate is granted when it clears the loan.',
  })
  @IsOptional()
  @IsBoolean()
  earlyPayoff?: boolean;

  @ApiPropertyOptional({
    description:
      'Client-generated key (e.g. UUID). Retrying with the same key returns the same deposit.',
  })
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey?: string;
}
