import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotificationChannel, SmsStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CATEGORIES } from '../notification-catalog';

const CATEGORY_KEYS = CATEGORIES.map((c) => c.key) as string[];

export class PreferenceItemDto {
  @ApiProperty({ enum: CATEGORY_KEYS })
  @IsIn(CATEGORY_KEYS)
  category!: string;

  @ApiProperty({ enum: NotificationChannel })
  @IsEnum(NotificationChannel)
  channel!: NotificationChannel;

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;
}

export class UpdatePreferencesDto {
  @ApiProperty({ type: [PreferenceItemDto] })
  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => PreferenceItemDto)
  preferences!: PreferenceItemDto[];
}

class PushKeysDto {
  @ApiProperty() @IsString() @MaxLength(200) p256dh!: string;
  @ApiProperty() @IsString() @MaxLength(100) auth!: string;
}

export class PushSubscriptionDto {
  @ApiProperty() @IsString() @MaxLength(1000) endpoint!: string;

  @ApiProperty({ type: PushKeysDto })
  @ValidateNested()
  @Type(() => PushKeysDto)
  keys!: PushKeysDto;

  @ApiPropertyOptional() @IsOptional() @IsInt() expirationTime?: number | null;
}

export class PushUnsubscribeDto {
  @ApiPropertyOptional({ description: 'Omit to remove every device' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  endpoint?: string;
}

const EXTRA = [
  NotificationChannel.EMAIL,
  NotificationChannel.SMS,
  NotificationChannel.PUSH,
];

export class CreateAnnouncementDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title!: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  body!: string;

  @ApiPropertyOptional({
    enum: EXTRA,
    isArray: true,
    description: 'Also send by these channels',
  })
  @IsOptional()
  @IsArray()
  @IsIn(EXTRA, { each: true })
  channels?: NotificationChannel[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class UpdateAnnouncementDto {
  @ApiProperty()
  @IsBoolean()
  pinned!: boolean;
}

export class SmsLogQueryDto {
  @ApiPropertyOptional({ enum: SmsStatus })
  @IsOptional()
  @IsEnum(SmsStatus)
  status?: SmsStatus;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60) kind?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  search?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() groupId?: string;
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
}
