import express, { type ErrorRequestHandler } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JWTVerifyGetKey } from 'jose';
import { createAuthenticator } from './auth.js';
import { configSchema, type Config } from './config.js';
import { createRemoteServer } from './remoteServer.js';
import { createWriteExecutor } from './writeExecutor.js';

export function createHttpApp(input: Config, dependencies: {
  key?: JWTVerifyGetKey;
  createServer?: () => McpServer;
} = {}) {
  const config = configSchema.parse(input);
  const app = express();
  app.disable('x-powered-by');
  const authenticate = createAuthenticator(config, dependencies.key);
  const writer = config.access === 'read-write' ? createWriteExecutor({directory:config.ledgerDirectory!}) : undefined;
  const publicUrl = config.auth.mode === 'cloudflare' ? new URL(config.auth.publicUrl) : undefined;
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`, ...(publicUrl ? [publicUrl.host] : [])]);
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...(publicUrl ? [publicUrl.origin] : [])]);
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!hosts.has(req.get('host') ?? '') || (req.get('origin') && !origins.has(req.get('origin')!))) {
      res.status(403).json({ error: 'Host or origin rejected' }); return;
    }
    next();
  });

  if (config.auth.mode === 'cloudflare') {
    const metadata = { resource: config.auth.publicUrl, authorization_servers: [config.auth.issuer], bearer_methods_supported: ['header'] };
    app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => { res.json(metadata); });
  }
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok', readOnly: config.access === 'read-only' }); });
  app.use('/mcp', async (req, res, next) => {
    const identity = await authenticate(req);
    if (!identity) {
      const challenge = publicUrl ? `Bearer resource_metadata="${publicUrl.origin}/.well-known/oauth-protected-resource/mcp"` : 'Bearer';
      res.set('WWW-Authenticate', challenge).status(401).json({ error: 'Authentication required' }); return;
    }
    res.locals.identity = identity;
    next();
  });
  let inFlight = 0;
  app.post('/mcp', (req, res, next) => {
    if (inFlight >= 16) { res.set('Retry-After', '2').status(503).json({ error: 'Server busy' }); return; }
    inFlight++;
    res.once('close', () => { inFlight--; });
    next();
  }, express.json({ limit: '64kb', strict: true }), async (req, res) => {
    const server = dependencies.createServer ? dependencies.createServer() : createRemoteServer({writer});
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const started = Date.now();
    res.once('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'Request failed' });
    } finally {
      // Task arguments, results, assertions and tokens must never enter ordinary logs.
      console.error(JSON.stringify({ event: 'mcp_request', subject: res.locals.identity, status: res.statusCode, durationMs: Date.now() - started }));
    }
  });
  app.all('/mcp', (_req, res) => { res.set('Allow', 'POST').status(405).end(); });
  const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = error?.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({ error: status === 413 ? 'Request too large' : 'Invalid request' });
  };
  app.use(errorHandler);
  return app;
}
