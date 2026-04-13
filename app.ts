'use strict';

import Homey from 'homey';
import { ImapFlow, ImapFlowOptions, FetchMessageObject } from 'imapflow';

interface MailMeta {
  uid: number;
  seq: number;
  envelope: FetchMessageObject['envelope'];
}

export interface EmailAccount {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  tls: boolean;
  pollInterval: number; // seconds
}

const DEFAULT_POLL_INTERVAL = 60; // seconds
const MIN_POLL_INTERVAL = 10;

module.exports = class EmailTriggerApp extends Homey.App {

  private _pollTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private _triggerCard: Homey.FlowCardTrigger | null = null;
  private _triggerCardAccount: Homey.FlowCardTrigger | null = null;

  // UID watermark per account id: -1 = not anchored yet.
  private _lastSeenUid: Map<string, number> = new Map();

  async onInit() {
    this.log('Mail Hook app initialized');

    this._triggerCard = this.homey.flow.getTriggerCard('email_received');
    this._triggerCardAccount = this.homey.flow.getTriggerCard('email_received_on_account');

    this._triggerCardAccount.registerRunListener(async (args: any, state: any) => {
      return args.account && args.account.id === state.accountId;
    });

    this._triggerCardAccount.registerArgumentAutocompleteListener(
      'account',
      async (query: string) => {
        const accounts = this._getAccounts();
        const q = query.toLowerCase();
        return accounts
          .filter((a) => !q || a.name.toLowerCase().includes(q) || a.username.toLowerCase().includes(q))
          .map((a) => ({ id: a.id, name: a.name, description: a.username }));
      },
    );

    this._migrateOldSettings();
    this._startAllPolling();

    (this.homey.settings as any).on('set', (key: string) => {
      if (key === 'accounts') {
        this.log('Accounts setting changed - restarting all polling');
        this._stopAllPolling();
        this._lastSeenUid.clear();
        this._startAllPolling();
      }
    });
  }

  async onUninit() {
    this._stopAllPolling();
  }

  // ─── Migration from v1 single-account settings ────────────────────────────

  private _migrateOldSettings() {
    if (this.homey.settings.get('accounts') !== null && this.homey.settings.get('accounts') !== undefined) return;

    const host = this.homey.settings.get('host') as string | undefined;
    if (!host) return;

    this.log('Migrating legacy single-account settings to multi-account format');

    const account: EmailAccount = {
      id: this._generateId(),
      name: (this.homey.settings.get('username') as string) || host,
      host,
      port: Number(this.homey.settings.get('port') ?? 993),
      username: (this.homey.settings.get('username') as string) ?? '',
      password: (this.homey.settings.get('password') as string) ?? '',
      tls: this.homey.settings.get('tls') !== false,
      pollInterval: Math.max(
        MIN_POLL_INTERVAL,
        Number(this.homey.settings.get('pollInterval') ?? DEFAULT_POLL_INTERVAL),
      ),
    };

    this.homey.settings.set('accounts', [account]);
  }

  private _generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  // ─── Settings helpers ─────────────────────────────────────────────────────

  private _getAccounts(): EmailAccount[] {
    const raw = this.homey.settings.get('accounts');
    if (!raw) return [];
    if (Array.isArray(raw)) return raw as EmailAccount[];
    try {
      const parsed = JSON.parse(String(raw));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private _isConfigured(account: EmailAccount): boolean {
    return !!(account.host && account.username && account.password);
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  private _stopAllPolling() {
    for (const timer of this._pollTimers.values()) {
      clearTimeout(timer);
    }
    this._pollTimers.clear();
  }

  private _stopAccountPolling(accountId: string) {
    const timer = this._pollTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this._pollTimers.delete(accountId);
    }
  }

  private _startAllPolling() {
    const accounts = this._getAccounts();
    if (accounts.length === 0) {
      this.log('No accounts configured - polling suspended');
      return;
    }
    for (const account of accounts) {
      this._startAccountPolling(account);
    }
  }

  private _startAccountPolling(account: EmailAccount) {
    this._stopAccountPolling(account.id);

    if (!this._isConfigured(account)) {
      this.log(`Account "${account.name}" is incomplete - skipping (fill in host, username and password)`);
      return;
    }

    const pollInterval = Math.max(MIN_POLL_INTERVAL, account.pollInterval || DEFAULT_POLL_INTERVAL);
    this.log(`Polling started for "${account.name}": ${account.username}@${account.host}:${account.port} every ${pollInterval}s`);

    const poll = () => {
      this._checkMail(account)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.error(`[${account.name}] IMAP poll error: ${msg}`);
        })
        .finally(() => {
          this.log(`[${account.name}] Next poll in ${pollInterval}s`);
          const timer = setTimeout(poll, pollInterval * 1000);
          this._pollTimers.set(account.id, timer);
        });
    };

    poll();
  }

  // ─── IMAP ─────────────────────────────────────────────────────────────────

  private _buildClientOptions(account: EmailAccount): ImapFlowOptions {
    return {
      host: account.host,
      port: account.port,
      secure: account.tls,
      auth: {
        user: account.username,
        pass: account.password,
      },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
    };
  }

  private async _checkMail(account: EmailAccount) {
    this.log(`[${account.name}] Connecting to ${account.host}:${account.port} (TLS: ${account.tls})...`);

    const client = new ImapFlow(this._buildClientOptions(account));

    // Attach BEFORE connect(). imapflow emits asynchronous 'error' events
    // (e.g. ETIMEOUT after connect). Without a listener Node.js crashes the process.
    client.on('error', (err: Error) => {
      this.error(`[${account.name}] IMAP client error: ${err.message}`);
    });

    try {
      await client.connect();
    } catch (err) {
      try {
        client.close();
      } catch { /* already closed */ }
      throw err;
    }

    this.log(`[${account.name}] Connected to IMAP server`);

    const lastSeenUid = this._lastSeenUid.get(account.id) ?? -1;

    try {
      const lock = await client.getMailboxLock('INBOX');

      try {
        const mailbox = client.mailbox as any;
        const uidNext: number = mailbox?.uidNext ?? 1;
        const messageCount: number = mailbox?.exists ?? 0;

        this.log(`[${account.name}] INBOX status: ${messageCount} message(s), next UID will be ${uidNext}`);

        // First poll: anchor to current UIDNEXT so we never fire on old emails.
        if (lastSeenUid === -1) {
          this._lastSeenUid.set(account.id, uidNext - 1);
          this.log(`[${account.name}] First poll: anchored at UID ${uidNext - 1}. Waiting for new emails from UID ${uidNext} onwards.`);
          return;
        }

        const fetchFrom = lastSeenUid + 1;
        this.log(`[${account.name}] Checking for new emails with UID >= ${fetchFrom}...`);

        // Phase 1: collect metadata only. Calling client.download() inside a
        // client.fetch() loop deadlocks — imapflow can't interleave two FETCH
        // commands on the same connection. Finish the loop first, then download.
        const newMsgs: MailMeta[] = [];

        for await (const msg of client.fetch(`${fetchFrom}:*`, {
          envelope: true,
        }, { uid: true })) {
          if (msg.uid <= lastSeenUid) continue;
          newMsgs.push({ uid: msg.uid, seq: msg.seq, envelope: msg.envelope });
        }

        if (newMsgs.length === 0) {
          this.log(`[${account.name}] No new emails found (last seen UID: ${lastSeenUid})`);
        } else {
          this.log(`[${account.name}] Found ${newMsgs.length} new email(s) — downloading bodies...`);

          let newLastSeen = lastSeenUid;
          // Phase 2: fetch loop is done; individual downloads are safe now.
          for (const meta of newMsgs) {
            const from = meta.envelope?.from?.[0]?.address ?? '(unknown)';
            const subject = meta.envelope?.subject ?? '(no subject)';
            this.log(`[${account.name}] Processing email UID ${meta.uid} from ${from}: ${subject}`);

            const body = await this._fetchPlainText(client, meta.seq);
            await this._triggerEmail(account, meta, body);
            newLastSeen = Math.max(newLastSeen, meta.uid);
          }

          this._lastSeenUid.set(account.id, newLastSeen);
          this.log(`[${account.name}] Triggered ${newMsgs.length} new email(s). New watermark UID: ${newLastSeen}`);
        }

      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.logout();
      } catch { /* already disconnected */ }
      this.log(`[${account.name}] Disconnected from IMAP server`);
    }
  }

  private async _fetchPlainText(client: ImapFlow, seq: number): Promise<string> {
    try {
      const download = await client.download(String(seq), 'TEXT');
      if (!download?.content) return '';
      const chunks: Buffer[] = [];
      for await (const chunk of download.content) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf-8').trim();
    } catch {
      return '';
    }
  }

  private async _triggerEmail(account: EmailAccount, meta: MailMeta, body: string) {
    const { envelope } = meta;
    if (!envelope) return;

    const fromAddress = envelope.from?.[0]?.address ?? '';
    const fromName = envelope.from?.[0]?.name ?? '';
    const subject = envelope.subject ?? '';

    this.log(`[${account.name}] Triggering flow: from "${fromName}" <${fromAddress}>, subject: "${subject}"`);

    const tokens = {
      from_email: fromAddress,
      from_name: fromName,
      subject,
      body: body.substring(0, 4096),
      account_name: account.name,
    };

    const state = { accountId: account.id };

    // Fire "any account" trigger
    await this._triggerCard!.trigger(tokens);
    // Fire "specific account" trigger (run listener filters by accountId)
    await this._triggerCardAccount!.trigger(tokens, state);

    this.log(`[${account.name}] Flow triggered successfully`);
  }

  // ─── Called from settings page via API ────────────────────────────────────

  async testConnection(settings: EmailAccount): Promise<{ success: boolean; message: string }> {
    if (!this._isConfigured(settings)) {
      return { success: false, message: 'Please fill in all required fields.' };
    }

    const client = new ImapFlow(this._buildClientOptions(settings));

    // Silences unhandled 'error' event - connect() rejection handles the error
    client.on('error', () => {});

    try {
      await client.connect();
      try {
        await client.logout();
      } catch { /* ignore */ }
      return { success: true, message: 'Connection successful!' };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, message: `Connection failed: ${message}` };
    }
  }

};
