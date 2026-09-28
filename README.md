# Park4night API

A TypeScript client and JSON CLI for planning trips with Park4night. Search nearby places, read reviews, and manage saved places and folders through direct HTTP requests.

Authentication uses the native app's password protocol. No browser, browser session, or reCAPTCHA token is needed. The client has no runtime dependencies and includes request pacing and bounded retries.

**Unofficial integration.** Park4night can change its native API without notice. This project is a local client library and CLI, not a hosted HTTP service or a complete implementation of every Park4night feature.

## Quick start

Requires **Node.js 24 or newer** and npm.

```sh
git clone https://github.com/marijnbent/park4night-api.git
cd park4night-api
npm ci

node src/cli.ts place 275051
node src/cli.ts reviews 275051
node src/cli.ts search 52.37 4.9 20
```

These commands use public reads and do not require credentials. Output is JSON. Use `node src/cli.ts help` for all commands.

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

The item must have `username` and `password` fields. The adapter calls the standard `op` command and captures its output in memory. Configure CLI access before use, or use environment-based login instead. No personal item IDs, credentials, or session values are stored in this repository.

## Use the client

Save this as `example.ts` in the project root and run `node example.ts` after injecting the credentials:

```ts
import { Park4nightClient } from './src/client.ts';

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

Supported languages are `en`, `nl`, `fr`, `de`, `es`, and `it`. Login returns the account ID, username, email, subscription dates, and a derived `isPremium` flag. The password and hash are excluded from that result. `logout()` clears the client's authentication state; it does not change the account password.

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
| `reviews(id)` | Native review records | Optional |
| `filters(kind)` | Filter metadata | No |
| `folders()` | `Folder[]` | Required |
| `bookmarks(folderId = 0)` | `Place[]` | Required |
| `myPlaces(kind)` | `Place[]` | Required |
| `createFolder(name, icon)` | Updated `Folder[]` | Required |
| `updateFolder({ id, name, icon })` | Updated `Folder[]` | Required |
| `deleteFolder(id)` | Updated `Folder[]` | Required |
| `addBookmark(placeId, folderId = 0)` | `void` | Required |
| `removeBookmark(placeId, folderId = 0)` | `void` | Required |
| `logout()` | `void` | No network request |

`myPlaces` accepts `created`, `visited`, or `commented`. `filters` accepts `type`, `custom_type`, `services`, or `activities`. Types are exported from `src/client.ts`.

Place records retain native fields, including descriptions, services, prices, photos, and ratings when returned. `id`, `lat`, and `lng` are normalized to numbers. Other numeric-looking native fields can remain strings.

Folder records contain `id`, `name`, `icon`, `capacity`, and `bookmarks` (place IDs). Folder `0` is the default selection. The client does not rename or delete it. `bookmarks()` reads folder `0`; it does not combine all folders. A folder can reference a place that the server no longer returns, so its ID count can exceed its available place count.

## CLI reference

Account commands below use the 1Password CLI. Omit `--vault` to use injected environment credentials.

```sh
node src/cli.ts --vault me
node src/cli.ts --vault bookmarks 123
node src/cli.ts --vault my-places commented
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

Account permissions still apply to upstream filters.

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
    maxWaitMs: 30000
  }
});
```

| Setting | Default | Allowed values |
| --- | --- | --- |
| `minIntervalMs` | `1000` | Integer from 0 to 60,000 |
| `maxRetries` | `2` | Integer from 0 to 5; zero disables retries |
| `maxWaitMs` | `30000` | Integer from 0 to 60,000 |

HTTP 429 responses pause later calls. The client respects `Retry-After` in seconds or HTTP-date format, as specified in [HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3). A missing or invalid header uses exponential delays starting at one second, plus 0–249 ms of random variation.

Reads, including login, retry within the configured limit. **Writes are never automatically retried.** Network errors, HTTP 5xx responses, authentication failures, and invalid responses are not retried.

When a cooldown exceeds `maxWaitMs`, the request fails with `RATE_LIMITED` and `retryAfterMs`. The client retains the full cooldown and does not send requests early. `maxWaitMs` limits each cooldown wait, not total command or queue time. Each sent request has a separate 20-second network timeout.

These defaults are client settings, not a confirmed Park4night quota. Limits and cooldowns apply to one client instance. Separate clients, processes, and machines do not share them.

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

Errors can include HTTP `status`. Rate-limit errors include the remaining `retryAfterMs` when created. The CLI uses this form:

```json
{"error":"RATE_LIMITED","message":"Park4night rate-limited this request. Try after retryAfterMs.","retryAfterMs":60000}
```

If a write fails or times out, read the folder state before repeating it. The server may have applied the change before the connection failed.

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
```

The test suite, covering API payloads, authentication, credential redaction, request pacing, a 25-call concurrent queue, retries, date and numeric delay values, stream failures, write protection, and CLI errors. Automated tests use simulated responses and do not require credentials or call Park4night.

Manual verification on 2026-09-27 confirmed direct login, search and filters, place details, reviews, account reads, and folder/bookmark changes. A temporary folder was created, changed, and deleted; the original folder list and saved-place IDs were unchanged. A timing check confirmed request starts 1,000 ms apart. Two temporary connection failures succeeded on one manual retry. These results do not guarantee future upstream availability.

The client does not implement subscription purchases, account edits, review/photo uploads, a hosted REST server, or shared rate limits across processes.
