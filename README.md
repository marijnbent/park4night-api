# Park4night API

A TypeScript client, JSON CLI, and local read-only MCP server for planning trips with Park4night. Search nearby places, read reviews, and manage saved places and folders through direct HTTP requests.

Authentication uses the native app's password protocol. No browser, browser session, or reCAPTCHA token is needed. The client includes runtime input validation, request pacing, cancellation, and bounded retries. The MCP server uses the official TypeScript SDK.

**Unofficial integration.** Park4night can change its native API without notice. This project is a local client library and CLI, not a hosted HTTP service or a complete implementation of every Park4night feature.

## Quick start

Requires **Node.js 24 or newer** and npm.

```sh
git clone https://github.com/marijnbent/park4night-api.git
cd park4night-api
npm ci

node dist/cli.js place 275051
node dist/cli.js reviews 275051
node dist/cli.js search 52.37 4.9 20
```

`npm ci` builds the JavaScript and declaration files. These commands use public reads and do not require credentials. Output is JSON. Use `node src/cli.ts help` for all commands.

To install the client into another Node.js project directly from GitHub:

```sh
npm install github:marijnbent/park4night-api
npx park4night --help
```

The installed package exports compiled JavaScript and TypeScript declarations. It is not published to the npm registry. Source development still works with `node src/cli.ts`.

For authenticated commands, inject `PARK4NIGHT_USERNAME` and `PARK4NIGHT_PASSWORD` into the process environment through your secret manager:

```sh
node src/cli.ts login
node src/cli.ts folders
node src/cli.ts bookmarks
```

The client does not load `.env` files. Do not put passwords in source files, shell command arguments, or Git. Each CLI process logs in when credentials are present.

### 1Password

With the 1Password CLI installed and authenticated, `--vault` reads a login item named `park4night.com` from a vault named `Agent`:

```sh
node src/cli.ts --vault login
node src/cli.ts --vault folders
node src/cli.ts --vault bookmarks
```

The defaults are vault `Agent`, item `park4night.com`, and fields `username` and `password`. Configure other names without adding environment variables:

```sh
node dist/cli.js --vault --vault-name Travel --item 'My travel login' --username-field email --password-field password folders
```

Field selectors accept an exact field ID or a unique field label. `--op-command /path/to/helper` selects a trusted wrapper instead of `op`. The library exposes the same settings through `readLogin({ vault, item, usernameField, passwordField, command })` from `park4night-api/vault`.

The item must contain both selected credential fields. The adapter calls the standard `op` command and captures its output in memory. Configure CLI access before use, or use environment-based login instead. No personal item IDs, credentials, or session values are stored in this repository.

## Use the client

Save this as `example.mjs` in a cloned project and run `node example.mjs` after injecting the credentials. In another project, import from `park4night-api` instead:

```ts
import { Park4nightClient } from './dist/client.js';

const client = new Park4nightClient({ language: 'en' });

await client.login({
  username: process.env.PARK4NIGHT_USERNAME ?? '',
  password: process.env.PARK4NIGHT_PASSWORD ?? ''
});

const nearby = await client.search({
  lat: 52.37,
  lng: 4.9,
  maxDistanceKm: 20,
  filter: { type: ['PN', 'P'], services: ['wifi'], rating: '4' }
});

const folders = await client.folders();
const savedPlaces = await client.bookmarks();
console.log({ nearby, folders, savedPlaces });

client.logout();
```

Supported languages are `en`, `nl`, `fr`, `de`, `es`, and `it`. Login returns the account ID, username, email, subscription dates, and a derived `isPremium` flag. The password and hash are excluded from that result. `logout()` clears authentication, invalidates pending logins, and cancels queued and active authenticated requests. Starting a new login also cancels the previous authentication generation. A write already sent to the server may still take effect.

Reuse one client for a batch of requests so its queue and cooldown apply to the whole batch.

### Save a place in a trip folder

After login:

```ts
const updatedFolders = await client.createFolder('Autumn trip', '🚐');
const folder = updatedFolders.find(item => item.name === 'Autumn trip');
if (!folder) throw new Error('The new folder was not returned.');

await client.addBookmark(275051, folder.id);
console.log(await client.bookmarks(folder.id));
```

This example creates a folder and saves a place. Folder names need not be unique; use folder IDs to identify existing folders.

## API reference

| Method | Result | Login |
| --- | --- | --- |
| `login({ username, password })` | `Account` | Uses credentials |
| `me()` | `Account` | Required |
| `search({ lat, lng, maxDistanceKm?, filter? })` | `SearchResult` | Optional |
| `place(id)` | `Place` | Optional |
| `reviews(id)` | `Review[]` | Optional |
| `filters(kind)` | Filter metadata | No |
| `folders()` | `Folder[]` | Required |
| `bookmarks(folderId = 0)` | `Place[]` | Required |
| `myPlaces(kind)` | `Place[]` | Required |
| `publicPlaces({ kind, username })` | Created or visited `Place[]` | No |
| `publicPlaces({ kind: 'commented', userId })` | Commented `Place[]` | No |
| `createFolder(name, icon)` | Updated `Folder[]` | Required |
| `updateFolder({ id, name, icon })` | Updated `Folder[]` | Required |
| `deleteFolder(id)` | Updated `Folder[]` | Required |
| `addBookmark(placeId, folderId = 0)` | `void` | Required |
| `removeBookmark(placeId, folderId = 0)` | `void` | Required |
| `logout()` | `void` | No network request |

`myPlaces` accepts `created`, `visited`, or `commented`. `filters` accepts `type`, `custom_type`, `services`, or `activities`. Types are exported from the package root, including `Place`, `Review`, `Photo`, `Folder`, `SearchOptions`, and `RequestOptions`.

Place records retain native fields. `id`, `lat`, and `lng` are numbers. Added fields include `rating` and `reviewCount` (number or null), `services` (present service keys mapped to booleans), and typed `photos` with numeric IDs, `largeUrl`, and `thumbnailUrl`. Reviews have numeric `id` and `placeId`, nullable `rating`, `text`, `username`, and `createdAt`. Native numeric-looking fields can still be strings.

Folder records contain `id`, `name`, `icon`, `capacity`, and `bookmarks` (place IDs). Folder `0` is the default selection. The client does not rename or delete it. `bookmarks()` reads folder `0`; it does not combine all folders. A folder can reference a place that the server no longer returns, so its ID count can exceed its available place count.

## CLI reference

Account commands below use the 1Password CLI. Omit `--vault` to use injected environment credentials.

```sh
node src/cli.ts --vault me
node src/cli.ts --vault bookmarks 123
node src/cli.ts --vault my-places commented
node src/cli.ts public-places created USERNAME
node src/cli.ts public-places visited USERNAME
node src/cli.ts public-places commented USER_ID
node src/cli.ts --vault folder-create 'Autumn trip' '🚐'
node src/cli.ts --vault folder-rename 123 'Winter trip'
node src/cli.ts --vault bookmark-add 275051 123
node src/cli.ts --vault bookmark-remove 275051 123
node src/cli.ts --vault folder-delete 123
```

Replace `123` with an actual folder ID. The last five commands change account data. Successful bookmark changes print `{"success":true}`. Other commands print their result. Failures write error JSON to stderr and exit with status 1.

`npm run api -- …` also works. Use `node src/cli.ts` when another program needs pure JSON stdout, because npm can print script banners.

## Search filters and completeness

```sh
node src/cli.ts filters type
node src/cli.ts filters services
node src/cli.ts search 52.37 4.9 20 '{"services":["wifi"],"rating":"4"}'
```

| Filter | Value |
| --- | --- |
| `type`, `custom_type` | Arrays of codes from filter metadata |
| `services`, `activities` | Arrays of keys from filter metadata |
| `rating` | Rating threshold as a string, such as `"4"` |
| `maxHeight` | Height filter sent as a string |
| `all_year`, `booking_filter` | `"0"` or `"1"` |

Filters are validated at runtime before sending requests. Unknown keys and incorrect value types return `INVALID_INPUT`. Rating must be a numeric string from 0 to 5; height must be a positive numeric string. Account permissions still apply to upstream filters.

Search has an **observed limit of 100 results**. `maxDistanceKm` filters that returned set locally; it does not request every place inside a radius.

- `places`: Results after the local distance filter.
- `returnedByUpstream`: Result count before the local filter.
- `mayBeTruncated`: True when the server returns 100 or more results.

There is no pagination or complete regional export. Use this client for bounded travel queries.

## Rate limits and retries

By default, each client allows **one request in progress** and **at least one second between request starts**. Login, reads, writes, and retries use the same queue. Calls made with `Promise.all` are queued.

```ts
const client = new Park4nightClient({
  rateLimit: {
    minIntervalMs: 1000,
    maxRetries: 2,
    maxWaitMs: 30000,
    maxQueueSize: 100
  }
});
```

| Setting | Default | Allowed values |
| --- | --- | --- |
| `minIntervalMs` | `1000` | Integer from 0 to 60,000 |
| `maxRetries` | `2` | Integer from 0 to 5; zero disables retries |
| `maxWaitMs` | `30000` | Integer from 0 to 60,000 |
| `maxQueueSize` | `100` | Waiting requests, 1 to 10,000; excludes the active request |

HTTP 429 responses pause later calls. The client respects `Retry-After` in seconds or HTTP-date format, as specified in [HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3). A missing or invalid header uses exponential delays starting at one second, plus 0–249 ms of random variation.

Reads, including login, retry within the configured limit. **Writes are never automatically retried.** Network errors, HTTP 5xx responses, authentication failures, and invalid responses are not retried.

When a cooldown exceeds `maxWaitMs`, the request fails with `RATE_LIMITED` and `retryAfterMs`. The client retains the full cooldown and does not send requests early. `maxWaitMs` limits each cooldown wait, not total command or queue time. Each sent request has a separate 20-second network timeout.

These defaults are client settings, not a confirmed Park4night quota. Reaching the waiting-queue limit returns `QUEUE_FULL` without sending the request. Share one scheduler when several clients in the same process must use one rate limit and cooldown:

```ts
import { Park4nightClient, RequestScheduler } from 'park4night-api';

const scheduler = new RequestScheduler({ minIntervalMs: 1000, maxQueueSize: 100 });
const first = new Park4nightClient({ scheduler });
const second = new Park4nightClient({ scheduler });
```

Do not supply both `scheduler` and `rateLimit`; configure the scheduler itself. Separate processes and machines do not share memory. The local MCP server uses one client and one queue for all its tool calls. A distributed or hosted service still needs a shared service-level limiter.

All network methods accept an optional final `{ signal }` argument:

```ts
const controller = new AbortController();
const pending = client.search({ lat: 52.37, lng: 4.9 }, { signal: controller.signal });
controller.abort();
try { await pending; } catch (error) { console.error(error.code); }
```

Cancellation removes queued requests immediately, interrupts cooldown waits, and aborts active HTTP calls. A cancelled write must be reconciled before retrying. Custom transports must respect the supplied abort signal.

## Error handling

```ts
import { Park4nightError } from './src/client.ts';

try {
  await client.place(275051);
} catch (error) {
  if (!(error instanceof Park4nightError)) throw error;
  console.error({ code: error.code, retryAfterMs: error.retryAfterMs });
}
```

| Code | Meaning |
| --- | --- |
| `INVALID_INPUT` | Invalid argument or configuration |
| `AUTH_REQUIRED` | Login is required |
| `AUTH_REJECTED` | Credentials or account permission were rejected |
| `NOT_FOUND` | The requested place or folder was not returned |
| `RATE_LIMITED` | HTTP 429 or an active server cooldown |
| `UPSTREAM_ERROR` | Other HTTP or native API error |
| `INVALID_RESPONSE` | Unexpected response format |
| `NETWORK_ERROR` | Connection, timeout, or response-read failure |
| `CANCELLED` | Caller cancellation, logout, or a newer login |
| `QUEUE_FULL` | The scheduler has reached its waiting-queue limit |

Errors can include HTTP `status`. Rate-limit errors include the remaining `retryAfterMs` when created. The CLI uses this form:

```json
{"error":"RATE_LIMITED","message":"Park4night rate-limited this request. Try after retryAfterMs.","retryAfterMs":60000}
```

If a write fails or times out, read the folder state before repeating it. The server may have applied the change before the connection failed.

## Local MCP server

The `park4night-mcp` executable speaks MCP over stdio. It exposes eight read-only tools:

| Tool | Purpose |
| --- | --- |
| `search_places` | Nearby places with filters and completeness flags |
| `get_place` | Full details for one place |
| `get_reviews` | Reviews for one place |
| `get_filters` | Supported filter keys and codes |
| `list_folders` | Folder summaries for the configured account |
| `get_bookmarks` | Saved places from one folder |
| `get_my_places` | Current account's created, visited, or commented places |
| `get_public_user_places` | Public user activity by username or user ID |

Search, bookmark, and user-place tools return compact summaries. List tools with a `limit` argument default to 20 records and allow up to 100. Responses distinguish tool-level truncation from possible upstream truncation. Place descriptions and reviews are untrusted user content, not instructions.

For MCP clients that use an `mcpServers` configuration, point to your built checkout:

```json
{
  "mcpServers": {
    "park4night": {
      "command": "node",
      "args": ["/absolute/path/to/park4night-api/dist/mcp-cli.js"]
    }
  }
}
```

For saved places, append `--vault` and any required 1Password options to `args`, or inject the existing `PARK4NIGHT_USERNAME` and `PARK4NIGHT_PASSWORD` variables into the server process through your client's secret mechanism. Do not store their values in a committed MCP configuration. Credentials are loaded once at startup and are never accepted as tool arguments. Without credentials, public tools work and account tools return `AUTH_REQUIRED`.

The server does not expose write tools or open a network port. Its stdout carries protocol messages only; startup errors go to stderr. MCP cancellation is passed to the HTTP client. The exported `createMcpServer(client)` factory from `park4night-api/mcp` accepts an existing authenticated client.

## Authentication and credential handling

The protocol was checked against native Android app version 7.1.62:

1. Remove ASCII spaces from the username and trim the password.
2. Hash the password with SHA-256, using lowercase hexadecimal output.
3. Send `GET /services/V4.1/userGet.php` with `uuid` and `motdepasse`.
4. Require `status: "OK"` and a valid account in `results`.
5. Use the returned username and user ID as `context_user` and `context_id_user`, with the password hash, on account requests.

The client connects to `https://park4night.com`, rejects redirects, and retains authentication in private memory. The native protocol sends the hash in the query string. **Treat the hash as a credential and do not log request URLs.** Errors exclude upstream bodies and URLs. A custom `transport` receives credentials and must be trusted.

This uses the native login protocol. It does not solve browser CAPTCHA challenges or reuse browser cookies.

## Development and verification

```sh
npm ci
npm run check
npm test
npm run test:package
```

The tests cover API payloads, runtime validation, login/logout races, cancellation, queue limits, shared cooldowns, credential configuration, typed responses, public user reads, and MCP handshake and tool calls. Package tests build a tarball, install it into a clean consumer, import the compiled package, type-check declarations, run the CLI, and communicate with the installed MCP server over stdio. Automated tests use simulated responses and do not require credentials or call Park4night. The package test needs registry access to install dependencies into a clean consumer project. GitHub Actions runs checks and package tests on Node.js 24 and 26.

Version 0.2.0 verification on 2026-09-28 passed 53 unit/protocol tests and four clean-install tests. Live checks confirmed native login, normalized photos and reviews, saved-place reads, all public user-place modes, and an authenticated MCP stdio handshake and saved-place tool call. No live writes were made in this verification.

Earlier manual verification on 2026-09-27 confirmed direct login, search and filters, place details, reviews, account reads, and folder/bookmark changes. A temporary folder was created, changed, and deleted; the original folder list and saved-place IDs were unchanged. A timing check confirmed request starts 1,000 ms apart. Two temporary connection failures succeeded on one manual retry. These results do not guarantee future upstream availability.

The client does not implement subscription purchases, account edits, review/photo uploads, or a hosted REST server. Cross-process rate coordination is outside this local-client design.

## License

[MIT](LICENSE). This license covers the client code, not Park4night data or services.
