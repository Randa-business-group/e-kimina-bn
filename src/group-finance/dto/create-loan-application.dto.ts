import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class LoanGuarantorInputDto {
  @ApiProperty() @IsString() userId!: string;

  @ApiProperty({
    example: 20_000,
    description: 'Part of the loan this member guarantees',
  })
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  amount!: number;
}

export class CreateLoanApplicationDto {
  @ApiProperty({ example: 25_000 })
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  requestedAmount!: number;

  @ApiPropertyOptional({
    example: 'Buy a second sewing machine for my workshop',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  purpose?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Uploaded supporting documents (URLs)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  attachmentUrls?: string[];

  @ApiPropertyOptional({ type: [LoanGuarantorInputDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => LoanGuarantorInputDto)
  guarantors?: LoanGuarantorInputDto[];

  @ApiPropertyOptional({
    description: 'Top up (refinance) your current ACTIVE loan',
  })
  @IsOptional()
  @IsString()
  topUpOfLoanId?: string;

  @ApiPropertyOptional({
    description:
      'Client key: a retried submit returns the same application (or send the Idempotency-Key header)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  idempotencyKey?: string;
}
