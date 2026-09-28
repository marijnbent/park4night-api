import { Park4nightClient, Park4nightError, type SearchFilter } from './client.ts';
import { readLogin } from './vault.ts';

const args = process.argv.slice(2);
const vaultIndex = args.indexOf('--vault');
const useVault = vaultIndex >= 0;
if (useVault) args.splice(vaultIndex, 1);
const command = args.shift() ?? 'help';
const number = (index: number): number => Number(args[index]);
const client = new Park4nightClient();
const credentials = () => useVault ? readLogin() : { username: process.env.PARK4NIGHT_USERNAME ?? '', password: process.env.PARK4NIGHT_PASSWORD ?? '' };

try {
  if (command !== 'login' && command !== 'help' && (useVault || process.env.PARK4NIGHT_USERNAME || process.env.PARK4NIGHT_PASSWORD)) await client.login(credentials());
  let output: unknown;
  switch (command) {
    case 'search':
      output = await client.search({ lat: number(0), lng: number(1), ...(args[2] ? { maxDistanceKm: number(2) } : {}), ...(args[3] ? { filter: JSON.parse(args[3]) as SearchFilter } : {}) });
      break;
    case 'place': output = await client.place(number(0)); break;
    case 'reviews': output = await client.reviews(number(0)); break;
    case 'filters': output = await client.filters(args[0] as 'type' | 'custom_type' | 'activities' | 'services'); break;
    case 'me': output = await client.me(); break;
    case 'folders': output = await client.folders(); break;
    case 'bookmarks': output = await client.bookmarks(args[0] === undefined ? undefined : number(0)); break;
    case 'my-places': output = await client.myPlaces(args[0] as 'created' | 'visited' | 'commented'); break;
    case 'bookmark-add': output = await client.addBookmark(number(0), args[1] === undefined ? undefined : number(1)); break;
    case 'bookmark-remove': output = await client.removeBookmark(number(0), args[1] === undefined ? undefined : number(1)); break;
    case 'folder-create': output = await client.createFolder(args[0] ?? '', args[1] ?? ''); break;
    case 'folder-rename': {
      const folder = (await client.folders()).find(f => f.id === number(0));
      if (!folder || !args[1]) throw new Park4nightError('INVALID_INPUT', 'Supply an existing folder ID and a new name.');
      output = await client.updateFolder({ ...folder, name: args[1] });
      break;
    }
    case 'folder-delete': output = await client.deleteFolder(number(0)); break;
    case 'login': {
      const account = await client.login(credentials());
      output = { authenticated: true, account };
      break;
    }
    case 'help':
      process.stdout.write(`Park4night JSON CLI\n\nnode src/cli.ts search LAT LNG [MAX_DISTANCE_KM] [FILTER_JSON]\nnode src/cli.ts place ID\nnode src/cli.ts reviews ID\nnode src/cli.ts filters type|custom_type|activities|services\nnode src/cli.ts --vault me|folders\nnode src/cli.ts --vault bookmarks [FOLDER_ID]\nnode src/cli.ts --vault my-places created|visited|commented\nnode src/cli.ts --vault bookmark-add PLACE_ID [FOLDER_ID]\nnode src/cli.ts --vault bookmark-remove PLACE_ID [FOLDER_ID]\nnode src/cli.ts --vault folder-create NAME ICON\nnode src/cli.ts --vault folder-rename FOLDER_ID NAME\nnode src/cli.ts --vault folder-delete FOLDER_ID\nnode src/cli.ts --vault login\n\n--vault reads the Park4night login from the Agent vault.\nAll authentication uses direct HTTP. No browser or CAPTCHA token is needed.\nYou can instead inject PARK4NIGHT_USERNAME and PARK4NIGHT_PASSWORD.\nRequests are queued at one per second. Reads retry HTTP 429 at most twice.\n`);
      process.exit(0);
    default: throw new Park4nightError('INVALID_INPUT', 'Unknown command. Run with help for usage.');
  }
  process.stdout.write(JSON.stringify(output ?? { success: true }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ error: error instanceof Park4nightError ? error.code : 'CLIENT_ERROR', message: error instanceof Park4nightError ? error.message : 'The command failed. Check input and 1Password access.', ...(error instanceof Park4nightError && error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}) }) + '\n');
  process.exitCode = 1;
}
