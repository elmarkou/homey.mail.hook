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

## Troubleshooting

- If the app logs connection errors, verify credentials and server details. Use the `Test connection` helper to validate.
- If older messages trigger unexpectedly, the app anchors to UIDNEXT on first run; resetting settings will re-anchor for a different account.

## Contributing

PRs and issues are welcome. Follow the existing TypeScript setup and tests.

## License

See the `LICENSE` file in the repository for license details.
