#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Park4nightClient, Park4nightError } from './client.ts';
import { createMcpServer } from './mcp.ts';
import { configuredLogin, credentialHelp, parseOptions } from './options.ts';
import { errorResult } from './errors.ts';

try {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`Park4night read-only MCP server (stdio)\n\npark4night-mcp [${credentialHelp}]\n\nPublic reads work without credentials. For saved places, use 1Password or inject\nPARK4NIGHT_USERNAME and PARK4NIGHT_PASSWORD into this process.\n`);
    process.exit(0);
  }
  if (options.args.length) throw new Park4nightError('INVALID_INPUT', 'The MCP server accepts options only.');
  const client = new Park4nightClient();
  const credentials = configuredLogin(options.vault);
  if (credentials) await client.login(credentials);
  const server = createMcpServer(client);
  const shutdown = async () => { client.logout(); await server.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
} catch (error) {
  process.stderr.write(JSON.stringify(errorResult(error)) + '\n');
  process.exitCode = 1;
}
