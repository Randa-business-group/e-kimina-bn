import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { FineStatus, FineType, LoanDisbursementMethod } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class IssueFineDto {
  @ApiProperty()
  @IsString()
  @MinLength(8)
  userId!: string;

  @ApiProperty({
    enum: FineType,
    description: 'Not LATE_CONTRIBUTION (system-issued)',
  })
  @IsEnum(FineType)
  type!: FineType;

  @ApiProperty({ example: 2000 })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount!: number;

  @ApiProperty({ example: 'Absent from the monthly meeting without notice' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ReasonDto {
  @ApiProperty({ example: 'Agreed at the 12 Nov meeting' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ListFinesQueryDto {
  @ApiPropertyOptional({ enum: FineStatus })
  @IsOptional()
  @IsEnum(FineStatus)
  status?: FineStatus;

  @ApiPropertyOptional({ description: 'Leaders only: filter by member' })
  @IsOptional()
  @IsString()
  userId?: string;
}

export class ExtendLoanDto {
  @ApiProperty({ example: '2027-02-28' })
  @IsDateString()
  newDueDate!: string;

  @ApiProperty({
    example: 'Hospitalisation; group agreed to extend by 60 days',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ManualDisbursementDto {
  @ApiProperty({
    enum: [LoanDisbursementMethod.CASH, LoanDisbursementMethod.BANK_TRANSFER],
  })
  @IsIn([LoanDisbursementMethod.CASH, LoanDisbursementMethod.BANK_TRANSFER])
  method!: LoanDisbursementMethod;

  @ApiPropertyOptional({ description: 'Bank reference or receipt number' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;

  @ApiPropertyOptional({ description: 'Uploaded receipt URL' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  proofImageUrl?: string;
}
