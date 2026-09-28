#!/usr/bin/env node
import { Park4nightClient, Park4nightError, type SearchFilter, type Account } from './client.ts';
import { errorResult } from './errors.ts';
import { configuredLogin, credentialHelp, parseOptions } from './options.ts';

try {
  const options = parseOptions(process.argv.slice(2));
  const command = options.help ? 'help' : options.args.shift() ?? 'help';
  const args = options.args;
  const number = (index: number): number => Number(args[index]);
  const client = new Park4nightClient();
  const commands = ['search', 'place', 'reviews', 'filters', 'me', 'folders', 'bookmarks', 'my-places', 'public-places', 'bookmark-add', 'bookmark-remove', 'folder-create', 'folder-rename', 'folder-delete', 'login', 'help'];
  if (!commands.includes(command)) throw new Park4nightError('INVALID_INPUT', 'Unknown command. Run with --help.');
  let account: Account | undefined;
  if (command !== 'help') {
    const credentials = configuredLogin(options.vault);
    if (credentials) account = await client.login(credentials);
    else if (command === 'login') throw new Park4nightError('AUTH_REQUIRED', 'Configure environment credentials or use --vault.');
  }
  let output: unknown;
  switch (command) {
    case 'search': {
      let filter: SearchFilter | undefined;
      try { filter = args[3] === undefined ? undefined : JSON.parse(args[3]) as SearchFilter; } catch { throw new Park4nightError('INVALID_INPUT', 'Filter must be valid JSON.'); }
      output = await client.search({ lat: number(0), lng: number(1), ...(args[2] === undefined ? {} : { maxDistanceKm: number(2) }), ...(filter === undefined ? {} : { filter }) });
      break;
    }
    case 'place': output = await client.place(number(0)); break;
    case 'reviews': output = await client.reviews(number(0)); break;
    case 'filters': output = await client.filters(args[0] as 'type' | 'custom_type' | 'activities' | 'services'); break;
    case 'me': output = await client.me(); break;
    case 'folders': output = await client.folders(); break;
    case 'bookmarks': output = await client.bookmarks(args[0] === undefined ? undefined : number(0)); break;
    case 'my-places': output = await client.myPlaces(args[0] as 'created' | 'visited' | 'commented'); break;
    case 'public-places':
      output = await client.publicPlaces(args[0] === 'commented' ? { kind: 'commented', userId: number(1) } : { kind: args[0] as 'created' | 'visited', username: args[1] ?? '' });
      break;
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
    case 'login': output = { authenticated: true, account }; break;
    case 'help':
      process.stdout.write(`Park4night JSON CLI\n\npark4night search LAT LNG [MAX_DISTANCE_KM] [FILTER_JSON]\npark4night place ID\npark4night reviews ID\npark4night filters type|custom_type|activities|services\npark4night me|folders\npark4night bookmarks [FOLDER_ID]\npark4night my-places created|visited|commented\npark4night public-places created|visited USERNAME\npark4night public-places commented USER_ID\npark4night bookmark-add PLACE_ID [FOLDER_ID]\npark4night bookmark-remove PLACE_ID [FOLDER_ID]\npark4night folder-create NAME ICON\npark4night folder-rename FOLDER_ID NAME\npark4night folder-delete FOLDER_ID\npark4night login\n\nCredentials: PARK4NIGHT_USERNAME and PARK4NIGHT_PASSWORD, or\n${credentialHelp}\n\nAuthentication uses direct HTTP. Requests are queued at one per second.\nReads retry HTTP 429 at most twice. Writes are not automatically retried.\n`);
      process.exit(0);
  }
  process.stdout.write(JSON.stringify(output ?? { success: true }, null, 2) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify(errorResult(error)) + '\n');
  process.exitCode = 1;
}
