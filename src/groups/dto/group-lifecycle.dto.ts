import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { GroupVerificationStatus } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class DeleteGroupDto {
  @ApiProperty({
    description: 'Must match the group name exactly (confirmation).',
  })
  @IsString()
  @MinLength(1)
  confirmName!: string;

  @ApiPropertyOptional({
    example: 'Group dissolved after the end-of-year share-out.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class RequestVerificationDto {
  @ApiProperty({ example: 'Gasabo' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  district!: string;

  @ApiProperty({ example: 'Kimironko' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  sector!: string;

  @ApiPropertyOptional({ example: 'Bibare' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cell?: string;

  @ApiPropertyOptional({
    description: 'Cooperative / RCA registration number, if any',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  registrationNumber?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'National IDs of the leaders',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  leaderNationalIds?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Uploaded document URLs (constitution, minutes…)',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  documentUrls?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class RejectVerificationDto {
  @ApiProperty({ example: 'The constitution document is missing signatures.' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason!: string;
}

export class VerificationQueueQueryDto {
  @ApiPropertyOptional({
    enum: GroupVerificationStatus,
    default: GroupVerificationStatus.PENDING,
  })
  @IsOptional()
  @IsEnum(GroupVerificationStatus)
  status?: GroupVerificationStatus;
}
