import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PaymentAccountsService } from '../platform/payment-accounts.service';

export type MomoMode = 'mock' | 'sandbox' | 'production' | 'disabled';
export type MomoProduct = 'collection' | 'disbursement';
export type MomoTxStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

export interface MomoStatusResult {
  status: MomoTxStatus;
  financialTransactionId?: string;
  reason?: string;
  raw: unknown;
}

interface ProductCreds {
  subscriptionKey: string;
  userId: string;
  apiKey: string;
}

function env(name: string): string {
  return (process.env[name] ?? '').trim();
}

/**
 * MTN MoMo Open API client (Collections `requesttopay` + Disbursements `transfer`).
 *
 * MOMO_MODE:
 *  - `mock`       (default outside production) no network; every request succeeds on the first
 *                 status check, except MSISDNs ending in `0000` which fail (for testing)
 *  - `sandbox`    https://sandbox.momodeveloper.mtn.com, target env `sandbox`, currency EUR
 *  - `production` MOMO_BASE_URL (default https://proxy.momoapi.mtn.com), MOMO_TARGET_ENVIRONMENT
 *                 (e.g. `mtnrwanda`), currency RWF
 *  - `disabled`   (default in production without credentials) MoMo is refused
 */
@Injectable()
export class MomoService {
  constructor(private readonly accounts: PaymentAccountsService) {}

  private readonly logger = new Logger(MomoService.name);
  /** Keyed by product + API user (one token per credential set). */
  private readonly tokens = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  /** Mock mode: reference → result. */
  private readonly mockLedger = new Map<string, MomoTxStatus>();

  get mode(): MomoMode {
    const explicit = env('MOMO_MODE').toLowerCase();
    if (['mock', 'sandbox', 'production', 'disabled'].includes(explicit)) {
      return explicit as MomoMode;
    }
    if (this.creds('collection')) return 'sandbox';
    return process.env.NODE_ENV === 'production' ? 'disabled' : 'mock';
  }

  get isMock(): boolean {
    return this.mode === 'mock';
  }

  isEnabled(product: MomoProduct): boolean {
    const m = this.mode;
    if (m === 'disabled') return false;
    if (m === 'mock') return true;
    return this.creds(product) != null;
  }

  /** Currency sent to MTN (the sandbox only accepts EUR). */
  get providerCurrency(): string {
    return env('MOMO_CURRENCY') || (this.mode === 'sandbox' ? 'EUR' : 'RWF');
  }

  get pendingTimeoutMinutes(): number {
    const n = Number(env('MOMO_PENDING_TIMEOUT_MINUTES'));
    return Number.isFinite(n) && n > 0 ? n : 30;
  }

  private get baseUrl(): string {
    const fromEnv = env('MOMO_BASE_URL').replace(/\/+$/, '');
    if (fromEnv) return fromEnv;
    return this.mode === 'production'
      ? 'https://proxy.momoapi.mtn.com'
      : 'https://sandbox.momodeveloper.mtn.com';
  }

  private get targetEnvironment(): string {
    return (
      env('MOMO_TARGET_ENVIRONMENT') ||
      (this.mode === 'production' ? 'mtnrwanda' : 'sandbox')
    );
  }

  private callbackUrl(product: MomoProduct): string | null {
    const base = env('MOMO_CALLBACK_BASE_URL').replace(/\/+$/, '');
    return base ? `${base}/payments/momo/callback/${product}` : null;
  }

  private creds(product: MomoProduct): ProductCreds | null {
    const p = product === 'collection' ? 'COLLECTION' : 'DISBURSEMENT';
    const subscriptionKey = env(`MOMO_${p}_SUBSCRIPTION_KEY`);
    const userId = env(`MOMO_${p}_USER_ID`);
    const apiKey = env(`MOMO_${p}_API_KEY`);
    return subscriptionKey && userId && apiKey
      ? { subscriptionKey, userId, apiKey }
      : null;
  }

  /**
   * The group's own MoMo account when the platform runs in PER_GROUP mode and it is
   * complete (msfts §6), otherwise the platform account from the environment.
   */
  private async resolveCreds(
    product: MomoProduct,
    groupId?: string,
  ): Promise<ProductCreds | null> {
    if (groupId) {
      const own = await this.accounts.credsFor(groupId, product);
      if (own) return own;
    }
    return this.creds(product);
  }

  /** Like isEnabled, but also counts a group's own account. */
  async isEnabledFor(product: MomoProduct, groupId: string): Promise<boolean> {
    const m = this.mode;
    if (m === 'disabled') return false;
    if (m === 'mock') return true;
    return (await this.resolveCreds(product, groupId)) != null;
  }

  private async requireCreds(
    product: MomoProduct,
    groupId?: string,
  ): Promise<ProductCreds> {
    const c = await this.resolveCreds(product, groupId);
    if (!c) {
      throw new ServiceUnavailableException(
        `MTN MoMo ${product} is not configured on this server.`,
      );
    }
    return c;
  }

  /** Rwanda MSISDN in international format without '+': 2507XXXXXXXX. */
  normalizeMsisdn(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    let out = digits;
    if (/^07\d{8}$/.test(digits)) out = `250${digits.slice(1)}`;
    else if (/^7\d{8}$/.test(digits)) out = `250${digits}`;
    else if (/^00250\d{9}$/.test(digits)) out = digits.slice(2);
    if (!/^\d{10,15}$/.test(out)) {
      throw new BadRequestException(
        'Enter a valid MTN MoMo phone number (e.g. 0788123456).',
      );
    }
    return out;
  }

  private async token(product: MomoProduct, c: ProductCreds): Promise<string> {
    const cacheKey = `${product}:${c.userId}`;
    const cached = this.tokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const res = await fetch(`${this.baseUrl}/${product}/token/`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${c.userId}:${c.apiKey}`).toString('base64')}`,
        'Ocp-Apim-Subscription-Key': c.subscriptionKey,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`MoMo ${product} token failed: ${res.status} ${text}`);
      throw new BadGatewayException('Could not authenticate with MTN MoMo.');
    }
    const body = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.tokens.set(cacheKey, {
      token: body.access_token,
      expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000,
    });
    return body.access_token;
  }

  private async headers(
    product: MomoProduct,
    referenceId?: string,
    groupId?: string,
  ) {
    const c = await this.requireCreds(product, groupId);
    const h: Record<string, string> = {
      Authorization: `Bearer ${await this.token(product, c)}`,
      'X-Target-Environment': this.targetEnvironment,
      'Ocp-Apim-Subscription-Key': c.subscriptionKey,
      'Content-Type': 'application/json',
    };
    if (referenceId) h['X-Reference-Id'] = referenceId;
    const cb = this.callbackUrl(product);
    if (referenceId && cb) h['X-Callback-Url'] = cb;
    return h;
  }

  private async send(
    product: MomoProduct,
    path: 'requesttopay' | 'transfer',
    p: {
      referenceId: string;
      amount: number;
      externalId: string;
      msisdn: string;
      payerMessage: string;
      payeeNote: string;
      /** Use this group's own MoMo account when configured. */
      groupId?: string;
    },
  ): Promise<void> {
    if (
      p.groupId
        ? !(await this.isEnabledFor(product, p.groupId))
        : !this.isEnabled(product)
    ) {
      throw new ServiceUnavailableException(
        'MTN MoMo payments are not available right now.',
      );
    }
    if (this.isMock) {
      this.mockLedger.set(
        p.referenceId,
        p.msisdn.endsWith('0000') ? 'FAILED' : 'SUCCESSFUL',
      );
      return;
    }
    const party = { partyIdType: 'MSISDN', partyId: p.msisdn };
    const body = {
      amount: String(Math.round(p.amount)),
      currency: this.providerCurrency,
      externalId: p.externalId,
      ...(path === 'requesttopay' ? { payer: party } : { payee: party }),
      payerMessage: p.payerMessage.slice(0, 160),
      payeeNote: p.payeeNote.slice(0, 160),
    };
    const res = await fetch(`${this.baseUrl}/${product}/v1_0/${path}`, {
      method: 'POST',
      headers: await this.headers(product, p.referenceId, p.groupId),
      body: JSON.stringify(body),
    });
    if (res.status !== 202) {
      const text = await res.text().catch(() => '');
      this.logger.error(`MoMo ${path} failed: ${res.status} ${text}`);
      throw new BadGatewayException(
        'MTN MoMo did not accept the request. Please try again.',
      );
    }
  }

  private async status(
    product: MomoProduct,
    path: 'requesttopay' | 'transfer',
    referenceId: string,
    groupId?: string,
  ): Promise<MomoStatusResult> {
    if (this.isMock) {
      const status = this.mockLedger.get(referenceId) ?? 'SUCCESSFUL';
      return {
        status,
        financialTransactionId:
          status === 'SUCCESSFUL'
            ? `MOCK-${referenceId.slice(0, 8)}`
            : undefined,
        reason: status === 'FAILED' ? 'PAYER_DECLINED (mock)' : undefined,
        raw: { mock: true, status },
      };
    }
    const res = await fetch(
      `${this.baseUrl}/${product}/v1_0/${path}/${referenceId}`,
      {
        headers: await this.headers(product, undefined, groupId),
      },
    );
    if (res.status === 404) {
      return {
        status: 'FAILED',
        reason: 'NOT_FOUND',
        raw: { httpStatus: 404 },
      };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BadGatewayException(
        `MoMo status check failed (${res.status}): ${text}`,
      );
    }
    const raw = (await res.json()) as {
      status?: string;
      financialTransactionId?: string;
      reason?: string | { code?: string; message?: string };
    };
    const s = (raw.status ?? 'PENDING').toUpperCase();
    const reason =
      typeof raw.reason === 'string'
        ? raw.reason
        : (raw.reason?.code ?? raw.reason?.message);
    return {
      status:
        s === 'SUCCESSFUL'
          ? 'SUCCESSFUL'
          : s === 'FAILED' || s === 'REJECTED' || s === 'TIMEOUT'
            ? 'FAILED'
            : 'PENDING',
      financialTransactionId: raw.financialTransactionId,
      reason,
      raw,
    };
  }

  requestToPay(p: Parameters<MomoService['send']>[2]) {
    return this.send('collection', 'requesttopay', p);
  }

  getRequestToPayStatus(referenceId: string, groupId?: string) {
    return this.status('collection', 'requesttopay', referenceId, groupId);
  }

  transfer(p: Parameters<MomoService['send']>[2]) {
    return this.send('disbursement', 'transfer', p);
  }

  getTransferStatus(referenceId: string, groupId?: string) {
    return this.status('disbursement', 'transfer', referenceId, groupId);
  }
}
