import { BadRequestException, Injectable } from '@nestjs/common';
import {
  CollectionMode,
  PlatformFeeMode,
  Prisma,
  type PlatformSettings,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type PlatformSettingsInput = {
  supportedCurrencies?: string[];
  defaultCurrency?: string;
  collectionMode?: CollectionMode;
  platformAccountName?: string | null;
  platformAccountMsisdn?: string | null;
  feeMode?: PlatformFeeMode;
  feeValue?: number;
  feeMin?: number | null;
  feeMax?: number | null;
  signupsEnabled?: boolean;
  requireLeaderTwoFactor?: boolean;
  supportEmail?: string | null;
};

const ID = 'platform';
const num = (d: Prisma.Decimal | null) => (d == null ? null : Number(d));

@Injectable()
export class PlatformSettingsService {
  private cache: { at: number; row: PlatformSettings } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async get(): Promise<PlatformSettings> {
    if (this.cache && Date.now() - this.cache.at < 30_000)
      return this.cache.row;
    // One load at a time: concurrent first reads would race to create the row.
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private inflight: Promise<PlatformSettings> | null = null;

  private async load(): Promise<PlatformSettings> {
    let row = await this.prisma.platformSettings.findUnique({
      where: { id: ID },
    });
    if (!row) {
      try {
        row = await this.prisma.platformSettings.create({ data: { id: ID } });
      } catch (e) {
        // Another instance created it first.
        if (
          !(
            e instanceof Prisma.PrismaClientKnownRequestError &&
            e.code === 'P2002'
          )
        )
          throw e;
        row = await this.prisma.platformSettings.findUniqueOrThrow({
          where: { id: ID },
        });
      }
    }
    this.cache = { at: Date.now(), row };
    return row;
  }

  view(s: PlatformSettings) {
    return {
      supportedCurrencies: s.supportedCurrencies,
      defaultCurrency: s.defaultCurrency,
      collectionMode: s.collectionMode,
      platformAccountName: s.platformAccountName,
      platformAccountMsisdn: s.platformAccountMsisdn,
      feeMode: s.feeMode,
      feeValue: Number(s.feeValue),
      feeMin: num(s.feeMin),
      feeMax: num(s.feeMax),
      signupsEnabled: s.signupsEnabled,
      requireLeaderTwoFactor: s.requireLeaderTwoFactor,
      supportEmail: s.supportEmail,
      updatedAt: s.updatedAt,
      updatedById: s.updatedById,
    };
  }

  async update(actorId: string, dto: PlatformSettingsInput) {
    const cur = await this.get();
    const currencies = dto.supportedCurrencies
      ? [
          ...new Set(
            dto.supportedCurrencies
              .map((c) => c.trim().toUpperCase())
              .filter(Boolean),
          ),
        ]
      : cur.supportedCurrencies;
    if (!currencies.length) {
      throw new BadRequestException('Keep at least one supported currency.');
    }
    if (currencies.some((c) => !/^[A-Z]{3}$/.test(c))) {
      throw new BadRequestException(
        'Currencies are 3-letter ISO codes, e.g. RWF.',
      );
    }
    const def = (dto.defaultCurrency ?? cur.defaultCurrency)
      .trim()
      .toUpperCase();
    if (!currencies.includes(def)) {
      throw new BadRequestException(
        'The default currency must be one of the supported currencies.',
      );
    }
    const feeMode = dto.feeMode ?? cur.feeMode;
    const feeValue = dto.feeValue ?? Number(cur.feeValue);
    if (feeValue < 0)
      throw new BadRequestException('The fee cannot be negative.');
    if (feeMode === PlatformFeeMode.PERCENT && feeValue > 20) {
      throw new BadRequestException(
        'A percentage fee above 20% is not allowed.',
      );
    }
    const feeMin = dto.feeMin !== undefined ? dto.feeMin : num(cur.feeMin);
    const feeMax = dto.feeMax !== undefined ? dto.feeMax : num(cur.feeMax);
    if (feeMin != null && feeMax != null && feeMin > feeMax) {
      throw new BadRequestException(
        'The minimum fee is above the maximum fee.',
      );
    }
    const row = await this.prisma.platformSettings.update({
      where: { id: ID },
      data: {
        supportedCurrencies: currencies,
        defaultCurrency: def,
        ...(dto.collectionMode ? { collectionMode: dto.collectionMode } : {}),
        ...(dto.platformAccountName !== undefined
          ? { platformAccountName: dto.platformAccountName?.trim() || null }
          : {}),
        ...(dto.platformAccountMsisdn !== undefined
          ? { platformAccountMsisdn: dto.platformAccountMsisdn?.trim() || null }
          : {}),
        feeMode,
        feeValue,
        feeMin,
        feeMax,
        ...(dto.signupsEnabled !== undefined
          ? { signupsEnabled: dto.signupsEnabled }
          : {}),
        ...(dto.requireLeaderTwoFactor !== undefined
          ? { requireLeaderTwoFactor: dto.requireLeaderTwoFactor }
          : {}),
        ...(dto.supportEmail !== undefined
          ? { supportEmail: dto.supportEmail?.trim() || null }
          : {}),
        updatedById: actorId,
      },
    });
    this.cache = { at: Date.now(), row };
    return this.view(row);
  }

  /** Platform fee on a MoMo collection of `amount` (rounded to whole units). */
  async feeFor(amount: number): Promise<number> {
    const s = await this.get();
    if (s.feeMode === PlatformFeeMode.NONE || amount <= 0) return 0;
    let fee =
      s.feeMode === PlatformFeeMode.PERCENT
        ? (amount * Number(s.feeValue)) / 100
        : Number(s.feeValue);
    if (s.feeMin != null) fee = Math.max(fee, Number(s.feeMin));
    if (s.feeMax != null) fee = Math.min(fee, Number(s.feeMax));
    return Math.max(0, Math.round(fee));
  }

  /** Normalised currency, refused when the platform does not support it. */
  async assertCurrency(currency: string | undefined | null): Promise<string> {
    const s = await this.get();
    const c = (currency ?? '').trim().toUpperCase() || s.defaultCurrency;
    if (!s.supportedCurrencies.includes(c)) {
      throw new BadRequestException(
        `Currency ${c} is not supported. Use one of: ${s.supportedCurrencies.join(', ')}.`,
      );
    }
    return c;
  }

  /** Safe subset for anyone (sign-up page, deposit window). */
  async publicView() {
    const s = await this.get();
    return {
      supportedCurrencies: s.supportedCurrencies,
      defaultCurrency: s.defaultCurrency,
      signupsEnabled: s.signupsEnabled,
      supportEmail: s.supportEmail,
      momoFee: {
        mode: s.feeMode,
        value: Number(s.feeValue),
        min: num(s.feeMin),
        max: num(s.feeMax),
      },
    };
  }
}
