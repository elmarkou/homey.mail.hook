'use strict';

import Homey from 'homey';
import { ImapFlow, ImapFlowOptions, FetchMessageObject } from 'imapflow';

interface MailMeta {
  uid: number;
  seq: number;
  envelope: FetchMessageObject['envelope'];
}

interface EmailSettings {
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

  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _triggerCard: Homey.FlowCardTrigger | null = null;

  // UID watermark: we only trigger for emails with UID > this value.
  // -1 = not anchored yet; the first poll will set it to (UIDNEXT - 1)
  // so we never fire on emails that already existed before the app started.
  private _lastSeenUid = -1;

  async onInit() {
    this.log('Mail Hook app initialized');
    this._triggerCard = this.homey.flow.getTriggerCard('email_received');
    this._startPolling();

    (this.homey.settings as any).on('set', (key: string) => {
      const connectionKeys = ['host', 'port', 'username', 'password', 'tls'];
      if (connectionKeys.includes(key)) {
        this.log(`Connection setting "${key}" changed - resetting UID watermark and restarting polling`);
        this._lastSeenUid = -1; // force re-anchor on next connect
        this._startPolling();
      } else if (key === 'pollInterval') {
        this.log('Poll interval changed - restarting polling');
        this._startPolling();
      }
    });
  }

  async onUninit() {
    this._stopPolling();
  }

  // ─── Settings helpers ─────────────────────────────────────────────────────

  private _getSettings(): EmailSettings {
    return {
      host: (this.homey.settings.get('host') as string) ?? '',
      port: Number(this.homey.settings.get('port') ?? 993),
      username: (this.homey.settings.get('username') as string) ?? '',
      password: (this.homey.settings.get('password') as string) ?? '',
      tls: this.homey.settings.get('tls') !== false,
      pollInterval: Math.max(
        MIN_POLL_INTERVAL,
        Number(this.homey.settings.get('pollInterval') ?? DEFAULT_POLL_INTERVAL),
      ),
    };
  }

  private _isConfigured(settings: EmailSettings): boolean {
    return !!(settings.host && settings.username && settings.password);
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  private _stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private _startPolling() {
    this._stopPolling();
    const settings = this._getSettings();

    if (!this._isConfigured(settings)) {
      this.log('IMAP not configured - polling suspended (fill in host, username and password in Settings)');
      return;
    }

    this.log(`Polling started: ${settings.username}@${settings.host}:${settings.port} every ${settings.pollInterval}s`);

    const poll = () => {
      this._checkMail(settings)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.error(`IMAP poll error: ${msg}`);
        })
        .finally(() => {
          this.log(`Next poll in ${settings.pollInterval}s`);
          this._pollTimer = setTimeout(poll, settings.pollInterval * 1000);
        });
    };

    poll();
  }

  // ─── IMAP ─────────────────────────────────────────────────────────────────

  private _buildClientOptions(settings: EmailSettings): ImapFlowOptions {
    return {
      host: settings.host,
      port: settings.port,
      secure: settings.tls,
      auth: {
        user: settings.username,
        pass: settings.password,
      },
      logger: false,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
    };
  }

  private async _checkMail(settings: EmailSettings) {
    this.log(`Connecting to ${settings.host}:${settings.port} (TLS: ${settings.tls})...`);

    const client = new ImapFlow(this._buildClientOptions(settings));

    // Attach BEFORE connect(). imapflow emits asynchronous 'error' events
    // (e.g. ETIMEOUT after connect). Without a listener Node.js crashes the process.
    client.on('error', (err: Error) => {
      this.error(`IMAP client error: ${err.message}`);
    });

    try {
      await client.connect();
    } catch (err) {
      try {
        client.close();
      } catch { /* already closed */ }
      throw err;
    }

    this.log('Connected to IMAP server');

    try {
      const lock = await client.getMailboxLock('INBOX');

      try {
        const mailbox = client.mailbox as any;
        const uidNext: number = mailbox?.uidNext ?? 1;
        const messageCount: number = mailbox?.exists ?? 0;

        this.log(`INBOX status: ${messageCount} message(s), next UID will be ${uidNext}`);

        // First poll: anchor to current UIDNEXT so we never fire on old emails.
        if (this._lastSeenUid === -1) {
          this._lastSeenUid = uidNext - 1;
          this.log(`First poll: anchored at UID ${this._lastSeenUid}. Waiting for new emails from UID ${uidNext} onwards. Existing messages will NOT trigger.`);
          return;
        }

        const fetchFrom = this._lastSeenUid + 1;
        this.log(`Checking for new emails with UID >= ${fetchFrom}...`);

        // Phase 1: collect metadata only. Calling client.download() inside a
        // client.fetch() loop deadlocks — imapflow can't interleave two FETCH
        // commands on the same connection. Finish the loop first, then download.
        const newMsgs: MailMeta[] = [];

        for await (const msg of client.fetch(`${fetchFrom}:*`, {
          envelope: true,
        }, { uid: true })) {
          if (msg.uid <= this._lastSeenUid) continue;
          newMsgs.push({ uid: msg.uid, seq: msg.seq, envelope: msg.envelope });
        }

        if (newMsgs.length === 0) {
          this.log(`No new emails found (last seen UID: ${this._lastSeenUid})`);
        } else {
          this.log(`Found ${newMsgs.length} new email(s) — downloading bodies...`);

          // Phase 2: fetch loop is done; individual downloads are safe now.
          for (const meta of newMsgs) {
            const from = meta.envelope?.from?.[0]?.address ?? '(unknown)';
            const subject = meta.envelope?.subject ?? '(no subject)';
            this.log(`Processing email UID ${meta.uid} from ${from}: ${subject}`);

            const body = await this._fetchPlainText(client, meta.seq);
            await this._triggerEmail(meta, body);
            this._lastSeenUid = Math.max(this._lastSeenUid, meta.uid);
          }

          this.log(`Triggered ${newMsgs.length} new email(s). New watermark UID: ${this._lastSeenUid}`);
        }

      } finally {
        lock.release();
      }
    } finally {
      try {
        await client.logout();
      } catch { /* already disconnected */ }
      this.log('Disconnected from IMAP server');
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

  private async _triggerEmail(meta: MailMeta, body: string) {
    const { envelope } = meta;
    if (!envelope) return;

    const fromAddress = envelope.from?.[0]?.address ?? '';
    const fromName = envelope.from?.[0]?.name ?? '';
    const subject = envelope.subject ?? '';

    this.log(`Triggering flow: from "${fromName}" <${fromAddress}>, subject: "${subject}"`);

    const tokens = {
      from_email: fromAddress,
      from_name: fromName,
      subject,
      body: body.substring(0, 4096),
    };

    await this._triggerCard!.trigger(tokens);
    this.log('Flow triggered successfully');
  }

  // ─── Called from settings page via API ────────────────────────────────────

  async testConnection(settings: EmailSettings): Promise<{ success: boolean; message: string }> {
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
