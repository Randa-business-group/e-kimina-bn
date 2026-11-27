import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CollectionMode, type GroupPaymentAccount } from '@prisma/client';
import { maskSecret, openSecret, sealSecret } from '../common/secret-box';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformSettingsService } from './platform-settings.service';

export type PaymentAccountInput = {
  accountName?: string | null;
  msisdn?: string | null;
  isActive?: boolean;
  collectionUserId?: string | null;
  collectionApiKey?: string | null;
  collectionSubscriptionKey?: string | null;
  disbursementUserId?: string | null;
  disbursementApiKey?: string | null;
  disbursementSubscriptionKey?: string | null;
};

export type MomoCreds = {
  subscriptionKey: string;
  userId: string;
  apiKey: string;
};

/** A group's own MTN MoMo account (msfts §6). Secrets are sealed and never returned. */
@Injectable()
export class PaymentAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  view(a: GroupPaymentAccount | null) {
    if (!a) return null;
    return {
      provider: a.provider,
      accountName: a.accountName,
      msisdn: a.msisdn,
      isActive: a.isActive,
      collection: {
        userId: a.collectionUserId,
        apiKey: maskSecret(a.collectionApiKeyEnc),
        subscriptionKey: maskSecret(a.collectionSubscriptionKeyEnc),
        configured: Boolean(
          a.collectionUserId &&
          a.collectionApiKeyEnc &&
          a.collectionSubscriptionKeyEnc,
        ),
      },
      disbursement: {
        userId: a.disbursementUserId,
        apiKey: maskSecret(a.disbursementApiKeyEnc),
        subscriptionKey: maskSecret(a.disbursementSubscriptionKeyEnc),
        configured: Boolean(
          a.disbursementUserId &&
          a.disbursementApiKeyEnc &&
          a.disbursementSubscriptionKeyEnc,
        ),
      },
      updatedAt: a.updatedAt,
    };
  }

  async get(groupId: string) {
    return this.view(
      await this.prisma.groupPaymentAccount.findUnique({ where: { groupId } }),
    );
  }

  async upsert(actorId: string, groupId: string, dto: PaymentAccountInput) {
    const group = await this.prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) throw new NotFoundException('Group not found.');
    // `undefined` keeps the stored value, `null`/'' clears it, a string replaces it.
    const secret = (v: string | null | undefined) =>
      v === undefined ? undefined : v && v.trim() ? sealSecret(v.trim()) : null;
    const text = (v: string | null | undefined) =>
      v === undefined ? undefined : v?.trim() || null;
    if (dto.msisdn && !/^\+?\d{9,15}$/.test(dto.msisdn.replace(/\s/g, ''))) {
      throw new BadRequestException(
        'Enter the account phone number in digits, e.g. 250788123456.',
      );
    }
    const data = {
      accountName: text(dto.accountName),
      msisdn: text(dto.msisdn?.replace(/\s/g, '')),
      isActive: dto.isActive,
      collectionUserId: text(dto.collectionUserId),
      collectionApiKeyEnc: secret(dto.collectionApiKey),
      collectionSubscriptionKeyEnc: secret(dto.collectionSubscriptionKey),
      disbursementUserId: text(dto.disbursementUserId),
      disbursementApiKeyEnc: secret(dto.disbursementApiKey),
      disbursementSubscriptionKeyEnc: secret(dto.disbursementSubscriptionKey),
      updatedById: actorId,
    };
    const row = await this.prisma.groupPaymentAccount.upsert({
      where: { groupId },
      create: { groupId, ...data },
      update: data,
    });
    return this.view(row);
  }

  async remove(groupId: string) {
    await this.prisma.groupPaymentAccount.deleteMany({ where: { groupId } });
    return { removed: true };
  }

  /**
   * Credentials MoMo should use for this group: its own account when the platform runs in
   * PER_GROUP mode and the account is active and complete; otherwise null (platform account).
   */
  async credsFor(
    groupId: string,
    product: 'collection' | 'disbursement',
  ): Promise<MomoCreds | null> {
    const s = await this.settings.get();
    if (s.collectionMode !== CollectionMode.PER_GROUP) return null;
    const a = await this.prisma.groupPaymentAccount.findUnique({
      where: { groupId },
    });
    if (!a?.isActive) return null;
    const userId =
      product === 'collection' ? a.collectionUserId : a.disbursementUserId;
    const apiKey = openSecret(
      product === 'collection'
        ? a.collectionApiKeyEnc
        : a.disbursementApiKeyEnc,
    );
    const subscriptionKey = openSecret(
      product === 'collection'
        ? a.collectionSubscriptionKeyEnc
        : a.disbursementSubscriptionKeyEnc,
    );
    return userId && apiKey && subscriptionKey
      ? { userId, apiKey, subscriptionKey }
      : null;
  }

  /** Where members send manual transfers: the group's account, else the platform's. */
  async manualTransferAccount(groupId: string) {
    const [s, a] = await Promise.all([
      this.settings.get(),
      this.prisma.groupPaymentAccount.findUnique({ where: { groupId } }),
    ]);
    if (a?.isActive && a.msisdn) {
      return { name: a.accountName, msisdn: a.msisdn, owner: 'GROUP' as const };
    }
    if (s.platformAccountMsisdn) {
      return {
        name: s.platformAccountName,
        msisdn: s.platformAccountMsisdn,
        owner: 'PLATFORM' as const,
      };
    }
    return null;
  }
}
