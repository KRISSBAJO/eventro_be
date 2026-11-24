import { Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Module, Patch, Post, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';
import bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma.service';
import { config } from '../config';
import { CurrentUser, Public, type AuthUser, type Role } from '../common/auth';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

export class SignupDto {
  @ApiProperty({ example: 'Ada Obi' }) @IsString() @MinLength(2) @MaxLength(80) name: string;
  @ApiProperty({ example: 'ada@example.com' }) @Transform(lower) @IsEmail() email: string;
  @ApiProperty({ minLength: 8 }) @IsString() @MinLength(8) @MaxLength(200) password: string;
}

export class UpdateMeDto {
  @ApiProperty({ example: 'Ada Obi' }) @IsString() @MinLength(2) @MaxLength(80) name: string;
}

export class LoginDto {
  @ApiProperty() @Transform(lower) @IsEmail() email: string;
  @ApiProperty() @IsString() @MaxLength(200) password: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private async session(u: { id: string; email: string; name: string; roles: string[] }) {
    return {
      token: await this.jwt.signAsync({ sub: u.id }),
      user: { id: u.id, email: u.email, name: u.name, roles: u.roles as Role[] },
    };
  }

  async signup(dto: SignupDto) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException('An account with this email already exists. Sign in instead.');
    const roles: Role[] = ['FAN'];
    if (config.adminEmail && dto.email === config.adminEmail) roles.push('ADMIN');
    const user = await this.prisma.user.create({
      data: { email: dto.email, name: dto.name.trim(), passwordHash: await bcrypt.hash(dto.password, 11), roles },
    });
    // Tickets bought with this email before the account existed now belong to it.
    await this.prisma.ticket.updateMany({ where: { holderEmail: dto.email, ownerId: null }, data: { ownerId: user.id } });
    await this.prisma.order.updateMany({ where: { email: dto.email, buyerId: null }, data: { buyerId: user.id } });
    return this.session(user);
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    // Same message and similar timing whether or not the email exists.
    const ok = await bcrypt.compare(dto.password, user?.passwordHash ?? '$2a$11$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
    if (!user || !ok) throw new UnauthorizedException('Email or password is incorrect.');
    if (user.suspendedAt) throw new ForbiddenException('This account is suspended. Contact Eventro support.');
    return this.session(user);
  }

  async rename(id: string, name: string) {
    const u = await this.prisma.user.update({ where: { id }, data: { name } });
    return { id: u.id, email: u.email, name: u.name, roles: u.roles };
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  /** Change the name shown on tickets bought from now on. */
  @ApiBearerAuth()
  @Patch('me')
  async updateMe(@CurrentUser() user: AuthUser, @Body() dto: UpdateMeDto) {
    return this.auth.rename(user.id, dto.name.trim());
  }
}

@Module({
  controllers: [AuthController],
  providers: [AuthService],
})
export class AuthModule {}
