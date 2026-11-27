import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AttendanceStatus,
  ExitRequestStatus,
  PollKind,
  PollStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  ValidateNested,
} from 'class-validator';

const ROLES = ['GROUP_ADMIN', 'TREASURER', 'MEMBER'] as const;
type Role = (typeof ROLES)[number];
const METHODS = ['CASH', 'BANK_TRANSFER', 'MTN_MOMO'] as const;

export class ChangeRoleDto {
  @ApiProperty({ enum: ROLES }) @IsIn(ROLES) role!: Role;
}

export class ReplaceTreasurerDto {
  @ApiProperty() @IsString() userId!: string;
  @ApiPropertyOptional({ enum: ['GROUP_ADMIN', 'MEMBER'], default: 'MEMBER' })
  @IsOptional()
  @IsIn(['GROUP_ADMIN', 'MEMBER'])
  previousTreasurerRole?: Role;
}

export class TransferAdminDto {
  @ApiProperty() @IsString() userId!: string;
  @ApiPropertyOptional({ enum: ['TREASURER', 'MEMBER'], default: 'MEMBER' })
  @IsOptional()
  @IsIn(['TREASURER', 'MEMBER'])
  myNewRole?: Role;
}

export class OptionalReasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RequiredReasonDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}

export class GovernanceSettingsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2)
  @Max(10000)
  maxMembers?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  minMembers?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  joinRequiresApproval?: boolean;
  @ApiPropertyOptional({
    description:
      'Distinct leader approvals per loan (capped at leaders available)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  loanApprovalsRequired?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  loanRequireAdminAndTreasurer?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  expenseApprovalsRequired?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  constitutionRequired?: boolean;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  defaultAbsenceFine?: number | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  defaultLateArrivalFine?: number | null;
}

export class MemberProfileDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) nationalId?:
    | string
    | null;
  @ApiPropertyOptional() @IsOptional() @IsDateString() dateOfBirth?:
    | string
    | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(20) gender?:
    | string
    | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(300) address?:
    | string
    | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) occupation?:
    | string
    | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nextOfKinName?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  nextOfKinPhone?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  nextOfKinRelationship?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  beneficiaryName?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(30)
  beneficiaryPhone?: string | null;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  beneficiaryRelationship?: string | null;
}

export class ExitQueryDto {
  @ApiPropertyOptional({ enum: ExitRequestStatus })
  @IsOptional()
  @IsEnum(ExitRequestStatus)
  status?: ExitRequestStatus;
}

export class SettleExitDto {
  @ApiProperty({ enum: METHODS }) @IsIn(METHODS) method!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reference?: string;
}

export class MeetingDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(150) title!: string;
  @ApiProperty() @IsDateString() scheduledAt!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  agenda?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  absenceFine?: number | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  lateFine?: number | null;
}

export class UpdateMeetingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(150)
  title?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() scheduledAt?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  agenda?: string;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  absenceFine?: number | null;
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  lateFine?: number | null;
}

export class MeetingQueryDto {
  @ApiPropertyOptional({ enum: ['upcoming', 'past', 'all'] })
  @IsOptional()
  @IsIn(['upcoming', 'past', 'all'])
  scope?: 'upcoming' | 'past' | 'all';
}

export class AttendanceEntryDto {
  @ApiProperty() @IsString() userId!: string;
  @ApiProperty({ enum: AttendanceStatus })
  @IsEnum(AttendanceStatus)
  status!: AttendanceStatus;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class AttendanceDto {
  @ApiProperty({ type: [AttendanceEntryDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AttendanceEntryDto)
  entries!: AttendanceEntryDto[];
}

export class IssueMeetingFinesDto {
  @ApiPropertyOptional({
    default: true,
    description: 'Mark members with no record as ABSENT first',
  })
  @IsOptional()
  @IsBoolean()
  markMissingAbsent?: boolean;
}

export class MinutesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20000)
  minutesText?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  minutesUrl?: string;
}

export class ConstitutionDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(150) title!: string;
  @ApiProperty() @IsString() @MinLength(10) @MaxLength(100000) content!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  documentUrl?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  summaryOfChanges?: string;
}

export class AcceptConstitutionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  version?: number;
}

export class PollDto {
  @ApiProperty() @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;
  @ApiProperty({ enum: PollKind }) @IsEnum(PollKind) kind!: PollKind;
  @ApiPropertyOptional({ type: [String], description: 'GENERAL: 2–10 options' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  options?: string[];
  @ApiPropertyOptional({ description: 'ROLE_CHANGE / REMOVE_MEMBER' })
  @IsOptional()
  @IsString()
  targetUserId?: string;
  @ApiPropertyOptional({ enum: ROLES }) @IsOptional() @IsIn(ROLES) role?: Role;
  @ApiPropertyOptional({ description: 'REMOVE_MEMBER' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
  @ApiProperty() @IsDateString() closesAt!: string;
  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  quorumPercent?: number;
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  passPercent?: number;
}

export class PollQueryDto {
  @ApiPropertyOptional({ enum: PollStatus })
  @IsOptional()
  @IsEnum(PollStatus)
  status?: PollStatus;
}

export class VoteDto {
  @ApiProperty() @Type(() => Number) @IsInt() @Min(0) optionIndex!: number;
}
