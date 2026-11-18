'use strict';

import Homey from 'homey';
import {
  ImapFlow, ImapFlowOptions, FetchMessageObject, MessageStructureObject,
} from 'imapflow';

interface MailMeta {
  uid: number;
  envelope: FetchMessageObject['envelope'];
  bodyStructure: FetchMessageObject['bodyStructure'];
}

interface Watermark {
  uidValidity: string;
  uid: number;
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
const BODY_TOKEN_LENGTH = 4096;
// Raw bytes fetched per body part. Caps memory use on huge mails; enough for the 4096-char token.
const BODY_MAX_BYTES = 64 * 1024;
const FOLDER_CACHE_MS = 60 * 1000;

module.exports = class EmailTriggerApp extends Homey.App {

  private _pollTimers: Map<string, NodeJS.Timeout> = new Map();
  private _triggerCard: Homey.FlowCardTrigger | null = null;
  private _triggerCardAccount: Homey.FlowCardTrigger | null = null;

  // Bumped on every restart of polling; loops from an older generation stop rescheduling.
  private _pollGeneration = 0;

  // INBOX watermark per account id. Missing = not anchored yet.
  private _lastSeen: Map<string, Watermark> = new Map();

  private _folderCache: Map<string, { at: number; folders: Awaited<ReturnType<ImapFlow['list']>> }> = new Map();

  async onInit() {
    this.log('Mail Hook app initialized');

    this._triggerCard = this.homey.flow.getTriggerCard('email_received');
    this._triggerCardAccount = this.homey.flow.getTriggerCard('email_received_on_account');

    this._triggerCardAccount.registerRunListener(async (args: any, state: any) => {
      return args.account && args.account.id === state.accountId;
    });

    this._triggerCardAccount.registerArgumentAutocompleteListener('account', this._accountAutocomplete);

    this._registerActions();

    this._migrateOldSettings();
    this._startAllPolling();

    (this.homey.settings as any).on('set', (key: string) => {
      if (key === 'accounts') {
        this.log('Accounts setting changed - restarting all polling');
        this._stopAllPolling();
        this._lastSeen.clear();
        this._folderCache.clear();
        this._startAllPolling();
      }
    });
  }

  async onUninit() {
    this._stopAllPolling();
  }

  private _accountAutocomplete = async (query: string) => {
    const q = query.toLowerCase();
    return this._getAccounts()
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.username.toLowerCase().includes(q))
      .map((a) => ({ id: a.id, name: a.name, description: a.username }));
  };

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
    this._pollGeneration++;
    for (const timer of this._pollTimers.values()) {
      this.homey.clearTimeout(timer);
    }
    this._pollTimers.clear();
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
    if (!this._isConfigured(account)) {
      this.log(`Account "${account.name}" is incomplete - skipping (fill in host, username and password)`);
      return;
    }

    const generation = this._pollGeneration;
    const pollInterval = Math.max(MIN_POLL_INTERVAL, account.pollInterval || DEFAULT_POLL_INTERVAL);
    this.log(`Polling started for "${account.name}": ${account.username}@${account.host}:${account.port} every ${pollInterval}s`);

    const poll = () => {
      this._checkMail(account, generation)
        .catch((err: unknown) => {
          this.error(`[${account.name}] IMAP poll error: ${this._errMsg(err)}`);
        })
        .finally(() => {
          // Settings changed while this poll ran: a new loop has taken over.
          if (generation !== this._pollGeneration) return;
          this.log(`[${account.name}] Next poll in ${pollInterval}s`);
          this._pollTimers.set(account.id, this.homey.setTimeout(poll, pollInterval * 1000));
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

  private _errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** Connects, runs fn, always logs out. */
  private async _withClient<T>(account: EmailAccount, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const client = new ImapFlow(this._buildClientOptions(account));

    // Attach BEFORE connect(). imapflow emits asynchronous 'error' events
    // (e.g. ETIMEOUT after connect). Without a listener Node.js crashes the process.
    client.on('error', (err: Error) => {
      this.error(`[${account.name}] IMAP client error: ${err.message}`);
    });

    try {
      await client.connect();
    } catch (err) {
      client.close();
      throw err;
    }

    try {
      return await fn(client);
    } finally {
      try {
        await client.logout();
      } catch { /* already disconnected */ }
    }
  }

  /** Connects, locks the mailbox, runs fn, releases and logs out. */
  private async _withMailbox<T>(account: EmailAccount, path: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this._withClient(account, async (client) => {
      const lock = await client.getMailboxLock(path);
      try {
        return await fn(client);
      } finally {
        lock.release();
      }
    });
  }

  private async _checkMail(account: EmailAccount, generation: number) {
    this.log(`[${account.name}] Checking ${account.host}:${account.port} (TLS: ${account.tls})...`);

    await this._withMailbox(account, 'INBOX', async (client) => {
      const mailbox = client.mailbox || undefined;
      const uidNext = mailbox?.uidNext;
      const uidValidity = mailbox?.uidValidity !== undefined ? String(mailbox.uidValidity) : '';

      if (!uidNext || !uidValidity) {
        // Anchoring without UIDNEXT would fire on the whole inbox.
        this.log(`[${account.name}] Server did not report UIDNEXT/UIDVALIDITY - skipping this poll`);
        return;
      }

      this.log(`[${account.name}] INBOX status: ${mailbox?.exists ?? 0} message(s), next UID will be ${uidNext}`);

      const last = this._lastSeen.get(account.id);

      // First poll (or inbox was recreated): anchor to current UIDNEXT so we never fire on old emails.
      if (!last || last.uidValidity !== uidValidity) {
        if (generation !== this._pollGeneration) return; // settings changed: new loop owns the watermark
        this._lastSeen.set(account.id, { uidValidity, uid: uidNext - 1 });
        this.log(`[${account.name}] Anchored at UID ${uidNext - 1}. Waiting for new emails from UID ${uidNext} onwards.`);
        return;
      }

      const fetchFrom = last.uid + 1;
      if (fetchFrom >= uidNext) {
        this.log(`[${account.name}] No new emails (last seen UID: ${last.uid})`);
        return;
      }

      // Phase 1: collect metadata only. Calling client.download() inside a
      // client.fetch() loop deadlocks: imapflow can't interleave two FETCH
      // commands on the same connection. Finish the loop first, then download.
      const newMsgs: MailMeta[] = [];
      for await (const msg of client.fetch(`${fetchFrom}:*`, { envelope: true, bodyStructure: true }, { uid: true })) {
        // `N:*` always returns the highest message, even when its UID is below N.
        if (msg.uid <= last.uid) continue;
        newMsgs.push({ uid: msg.uid, envelope: msg.envelope, bodyStructure: msg.bodyStructure });
      }
      newMsgs.sort((a, b) => a.uid - b.uid);

      if (newMsgs.length === 0) {
        this.log(`[${account.name}] No new emails (last seen UID: ${last.uid})`);
        return;
      }

      this.log(`[${account.name}] Found ${newMsgs.length} new email(s)`);

      // Phase 2: fetch loop is done; individual downloads are safe now.
      for (const meta of newMsgs) {
        if (generation !== this._pollGeneration) return; // settings changed mid-batch
        const from = meta.envelope?.from?.[0]?.address ?? '(unknown)';
        this.log(`[${account.name}] Processing email UID ${meta.uid} from ${from}: ${meta.envelope?.subject ?? '(no subject)'}`);

        const body = await this._fetchBodyText(client, meta);
        await this._triggerEmail(account, meta, body, `${account.id}:${uidValidity}:${meta.uid}`);
        // Advance per message so a failure later in the batch doesn't re-trigger earlier mails.
        if (generation !== this._pollGeneration) return;
        this._lastSeen.set(account.id, { uidValidity, uid: meta.uid });
      }
    });
  }

  /** Depth-first search for the first non-attachment part of the given MIME type. */
  private _findPart(node: MessageStructureObject | undefined, type: string): string | undefined {
    // Don't descend into attachments or forwarded mails: their text is not this mail's body.
    if (!node || node.disposition === 'attachment' || node.type === 'message/rfc822') return undefined;
    if (node.childNodes?.length) {
      for (const child of node.childNodes) {
        const part = this._findPart(child, type);
        if (part) return part;
      }
      return undefined;
    }
    if (node.type === type) return node.part ?? '1';
    return undefined;
  }

  private async _fetchBodyText(client: ImapFlow, meta: MailMeta): Promise<string> {
    const plainPart = this._findPart(meta.bodyStructure, 'text/plain');
    const htmlPart = plainPart ? undefined : this._findPart(meta.bodyStructure, 'text/html');
    const part = plainPart ?? htmlPart;
    if (!part) return '';

    try {
      // Part download decodes transfer encoding and converts to UTF-8.
      const download = await client.download(String(meta.uid), part, { uid: true, maxBytes: BODY_MAX_BYTES });
      if (!download?.content) return '';
      const chunks: Buffer[] = [];
      for await (const chunk of download.content) {
        chunks.push(chunk as Buffer);
      }
      const text = Buffer.concat(chunks).toString('utf-8');
      return (htmlPart ? this._htmlToText(text) : text).trim();
    } catch (err) {
      // Body is best effort: still trigger the flow with an empty body token.
      this.error(`Could not download body of UID ${meta.uid}: ${this._errMsg(err)}`);
      return '';
    }
  }

  // ponytail: regex strip, good enough for a flow token; use a real parser if people match on HTML bodies.
  private _htmlToText(html: string): string {
    return html
      // `|$` also strips a block left unclosed by the maxBytes cut.
      .replace(/<(style|script|head)\b[\s\S]*?(<\/\1>|$)/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/&amp;/gi, '&') // last, so "&amp;lt;" stays "&lt;"
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n');
  }

  private async _triggerEmail(account: EmailAccount, meta: MailMeta, body: string, mailRef: string) {
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
      body: body.substring(0, BODY_TOKEN_LENGTH),
      account_name: account.name,
      mail_ref: mailRef,
    };

    const state = { accountId: account.id };

    // Fire "any account" trigger
    await this._triggerCard!.trigger(tokens);
    // Fire "specific account" trigger (run listener filters by accountId)
    await this._triggerCardAccount!.trigger(tokens, state);

    this.log(`[${account.name}] Flow triggered successfully`);
  }

  // ─── Action cards ─────────────────────────────────────────────────────────

  private _registerActions() {
    this.homey.flow.getActionCard('mark_read').registerRunListener(async (args: any) => {
      await this._withMessage(args.mail_ref, async (client, uid) => {
        const ok = args.state === 'unread'
          ? await client.messageFlagsRemove(uid, ['\\Seen'], { uid: true })
          : await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
        if (!ok) throw new Error('The mail server refused to change the read flag');
      });
    });

    this.homey.flow.getActionCard('delete_email').registerRunListener(async (args: any) => {
      await this._withMessage(args.mail_ref, async (client, uid, account) => {
        const trash = (await client.list()).find((f) => f.specialUse === '\\Trash');
        this._assertSafeExpunge(client, !!trash);
        if (trash) {
          const moved = await client.messageMove(uid, trash.path, { uid: true });
          if (!moved) throw new Error(`Could not move the email to "${trash.path}"`);
          this.log(`[${account.name}] Moved UID ${uid} to ${trash.path}`);
          return;
        }
        const deleted = await client.messageDelete(uid, { uid: true });
        if (!deleted) throw new Error('The mail server refused to delete the email');
        this.log(`[${account.name}] No Trash folder: permanently deleted UID ${uid}`);
      });
    });

    const moveCard = this.homey.flow.getActionCard('move_email');
    moveCard.registerArgumentAutocompleteListener('account', this._accountAutocomplete);
    moveCard.registerArgumentAutocompleteListener('folder', async (query: string, args: any) => {
      const account = this._getAccounts().find((a) => a.id === args.account?.id);
      if (!account) throw new Error('Select an account first');
      const q = query.toLowerCase();
      // Autocomplete fires per keystroke: reuse the folder list for a minute instead of reconnecting.
      let cached = this._folderCache.get(account.id);
      if (!cached || Date.now() - cached.at > FOLDER_CACHE_MS) {
        cached = { at: Date.now(), folders: await this._withClient(account, (client) => client.list()) };
        this._folderCache.set(account.id, cached);
      }
      return cached.folders
        .filter((f) => !f.flags.has('\\Noselect') && f.path.toUpperCase() !== 'INBOX')
        .filter((f) => !q || f.path.toLowerCase().includes(q))
        .map((f) => ({ id: f.path, name: f.path, description: f.specialUse ?? '' }));
    });
    moveCard.registerRunListener(async (args: any) => {
      const path: string | undefined = args.folder?.id;
      if (!path) throw new Error('No folder selected');
      await this._withMessage(args.mail_ref, async (client, uid, account) => {
        if (args.account?.id && args.account.id !== account.id) {
          throw new Error(`This email belongs to account "${account.name}", not "${args.account.name}"`);
        }
        this._assertSafeExpunge(client, true);
        const moved = await client.messageMove(uid, path, { uid: true });
        if (!moved) throw new Error(`Could not move the email to "${path}"`);
        this.log(`[${account.name}] Moved UID ${uid} to ${path}`);
      });
    });
  }

  /**
   * Without UIDPLUS, imapflow's delete (also used to emulate MOVE) runs a plain EXPUNGE,
   * which removes every \Deleted email in the mailbox, not only this one.
   */
  private _assertSafeExpunge(client: ImapFlow, isMove: boolean) {
    if (client.capabilities.has('UIDPLUS') || (isMove && client.capabilities.has('MOVE'))) return;
    throw new Error('This mail server does not support UIDPLUS; refusing because it could also remove other emails marked as deleted');
  }

  /** Resolves a mail_ref token (accountId:uidValidity:uid) and runs fn with the INBOX locked. */
  private async _withMessage(
    ref: unknown,
    fn: (client: ImapFlow, uid: string, account: EmailAccount) => Promise<void>,
  ): Promise<void> {
    const match = /^([^:\s]+):(\d+):(\d+)$/.exec(String(ref ?? '').trim());
    if (!match) throw new Error('Invalid email reference. Use the "Email reference" token from a Mail Hook trigger.');
    const [, accountId, uidValidity, uid] = match;

    const account = this._getAccounts().find((a) => a.id === accountId);
    if (!account) throw new Error('The mail account of this email no longer exists');

    await this._withMailbox(account, 'INBOX', async (client) => {
      if (String(client.mailbox ? client.mailbox.uidValidity : '') !== uidValidity) {
        throw new Error('The inbox was reset on the server; this email reference is no longer valid');
      }
      const found = await client.search({ uid }, { uid: true });
      if (!found || found.length === 0) {
        throw new Error(`Email not found in INBOX (already moved or deleted?) [${account.name}, UID ${uid}]`);
      }
      await fn(client, uid, account);
    });
  }

  // ─── Called from settings page via API ────────────────────────────────────

  async testConnection(settings: EmailAccount): Promise<{ success: boolean; message: string }> {
    if (!this._isConfigured(settings)) {
      return { success: false, message: 'Please fill in all required fields.' };
    }

    try {
      await this._withClient(settings, async () => undefined);
      return { success: true, message: 'Connection successful!' };
    } catch (err: unknown) {
      return { success: false, message: `Connection failed: ${this._errMsg(err)}` };
    }
  }

};
