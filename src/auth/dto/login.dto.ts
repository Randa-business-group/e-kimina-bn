import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

/** Sign in with email or phone number + password (msfts §8). */
export class LoginDto {
  @ApiPropertyOptional({ example: 'member@ekimina.rw' })
  @ValidateIf((o: LoginDto) => !o.phone)
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ example: '0788123456' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiProperty({ example: 'StrongPassword123!' })
  @IsString()
  @MinLength(1)
  @MaxLength(72)
  password!: string;
}
