# Mail Hook

Mail Hook is a Homey app that triggers Homey Flows when new emails arrive in a configured IMAP inbox. It's useful for integrating incoming email events with smart home automations, e.g. notify when a specific sender messages you, or run actions when a delivery notice arrives.

## Features

- Triggers a Flow when a new email is received via IMAP
- Provides tokens: `from_email`, `from_name`, `subject`, `body` (trimmed)
- Configurable IMAP settings: host, port, TLS, username, password
- `Test connection` API endpoint to validate credentials
- Anchors to the mailbox UID on first run to avoid triggering on historical mail

## Installation & Build

Requirements: Node.js and the Homey Apps SDK (v3). From the project root:

```bash
npm install
npm run build
```

To run locally on a Homey device use the Homey CLI:

```bash
homey app run
```

## Configuration

Open the app settings in the Homey mobile app and provide your IMAP server details:

- Host (e.g. `imap.gmail.com`)
- Port (usually `993` for IMAPS)
- Username and password
- TLS toggle
- Poll interval (seconds)

The settings page includes a **Test connection** button that calls the `POST /api/test` endpoint and attempts to connect using the entered credentials.

## Flow Trigger

The flow trigger `A new email is received` exposes the following tokens:

- `from_email` (string): the sender's email address. Example: `sender@example.com`
- `from_name` (string): the sender's display name if available. Example: `John Doe`
- `subject` (string): the email subject line. Example: `Your package has been shipped`
- `body` (string): a plain-text snippet of the email body. Mail Hook trims large bodies to avoid very long tokens; use additional content parsing in your Flow if needed.

Use these tokens in Flow conditions, messages, or as inputs to other actions to build powerful automations based on incoming emails.

## Multiple accounts (new)

Mail Hook now supports multiple IMAP accounts. Changes:

- Settings now store an `accounts` array. Each account has `id`, `name`, `host`, `port`, `username`, `password`, `tls`, and `pollInterval`.
- Existing single-account settings are auto-migrated on first run to the new `accounts` format.
- Two flow triggers are available:
	- `A new email is received` — fires for any configured account and provides `account_name` as a token.
	- `A new email is received on the selected account` — a trigger where you select a specific account when creating the Flow.
- Tokens now include `account_name` (the account label) in addition to the existing `from_email`, `from_name`, `subject`, and `body` tokens.

If you relied on the previous single-account settings, your existing credentials will be migrated automatically. If you want multiple accounts, open Settings and add them using the new UI.

## Troubleshooting

- If the app logs connection errors, verify credentials and server details. Use the `Test connection` helper to validate.
- If older messages trigger unexpectedly, the app anchors to UIDNEXT on first run; resetting settings will re-anchor for a different account.

## Contributing

PRs and issues are welcome. Follow the existing TypeScript setup and tests.

## License

See the `LICENSE` file in the repository for license details.
