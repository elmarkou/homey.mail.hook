'use strict';

// This module defines the Homey Web API routes for this app.
// Routes are declared in .homeycompose/app.json under the "api" key.
// Each exported function name must match the route key in app.json.

module.exports = {
  /**
   * POST /test
   * Body: { host, port, username, password, tls }
   * Tests the IMAP connection with the provided (unsaved) credentials.
   */
  async testConnection({ homey, body }: { homey: any; body: Record<string, unknown> }) {
    const app = homey.app as any;
    const settings = {
      host: String(body.host ?? ''),
      port: Number(body.port ?? 993),
      username: String(body.username ?? ''),
      password: String(body.password ?? ''),
      tls: body.tls !== false,
      pollInterval: 60,
    };
    return app.testConnection(settings);
  },
};
