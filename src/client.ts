import { createHash } from 'node:crypto';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordData = { [key: string]: Json };
export type Language = 'en' | 'nl' | 'fr' | 'de' | 'es' | 'it';
export type ErrorCode = 'INVALID_INPUT' | 'AUTH_REQUIRED' | 'AUTH_REJECTED' | 'NOT_FOUND' | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'INVALID_RESPONSE' | 'NETWORK_ERROR';
export class Park4nightError extends Error {
  readonly code: ErrorCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(code: ErrorCode, message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = 'Park4nightError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}
export type Place = RecordData & { id: number; lat: number; lng: number };
export type Folder = { id: number; name: string; icon: string; bookmarks: number[]; capacity: number };
export type Account = { id: number; username: string; email: string; isPremium: boolean; annualSubscriptionEnds: string; monthlySubscriptionEnds: string };
export type SearchFilter = { type?: string[]; custom_type?: string[]; services?: string[]; activities?: string[]; rating?: string; maxHeight?: string; all_year?: '0' | '1'; booking_filter?: '0' | '1' };
export type SearchOptions = { lat: number; lng: number; filter?: SearchFilter; maxDistanceKm?: number };
export type SearchResult = { places: Place[]; returnedByUpstream: number; mayBeTruncated: boolean };
export type LoginCredentials = { username: string; password: string };
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

export type RateLimitOptions = { minIntervalMs?: number; maxRetries?: number; maxWaitMs?: number };

function rateLimitOptions(options: RateLimitOptions): Required<RateLimitOptions> {
  const result = { minIntervalMs: options.minIntervalMs ?? 1000, maxRetries: options.maxRetries ?? 2, maxWaitMs: options.maxWaitMs ?? 30000 };
  for (const [key, maximum] of [['minIntervalMs', 60000], ['maxRetries', 5], ['maxWaitMs', 60000]] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0 || result[key] > maximum) throw new Park4nightError('INVALID_INPUT', key + ' must be an integer between 0 and ' + maximum + '.');
  }
  return result;
}

function retryDelay(value: string | null, attempt: number): number {
  if (value !== null) {
    const header = value.trim();
    if (/^\d+$/.test(header)) return Math.min(Number.MAX_SAFE_INTEGER, Number(header) * 1000);
    if (/^[A-Za-z]{3,9}[, ]/.test(header)) {
      const date = Date.parse(header);
      if (Number.isFinite(date)) return Math.max(0, date - Date.now());
    }
  }
  return 1000 * 2 ** attempt + Math.floor(Math.random() * 250);
}

type Auth = { username: string; id: number; hash: string };
function record(value: unknown): value is RecordData { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function invalidResponse(): never { throw new Park4nightError('INVALID_RESPONSE', 'Park4night returned an unexpected response.'); }
function integer(value: unknown, minimum = 1): number {
  if ((typeof value !== 'string' && typeof value !== 'number') || value === '') invalidResponse();
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < minimum) invalidResponse();
  return n;
}
function id(value: number, minimum = 1): number {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Park4nightError('INVALID_INPUT', minimum === 0 ? 'Folder IDs must be non-negative integers.' : 'IDs must be positive integers.');
  return value;
}
function places(value: unknown): Place[] {
  if (!Array.isArray(value)) invalidResponse();
  return value.map(p => {
    if (!record(p) || !['number', 'string'].includes(typeof p.latitude) || !['number', 'string'].includes(typeof p.longitude) || p.latitude === '' || p.longitude === '') invalidResponse();
    const lat = Number(p.latitude), lng = Number(p.longitude);
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) invalidResponse();
    return { ...p, id: integer(p.id), lat, lng };
  });
}
function folders(value: unknown): Folder[] {
  if (!Array.isArray(value)) invalidResponse();
  return value.map(f => {
    if (!record(f) || typeof f.name !== 'string' || typeof f.id_lieux !== 'string' || (f.icon !== undefined && typeof f.icon !== 'string')) invalidResponse();
    return { id: integer(f.id, 0), name: f.name, icon: f.icon ?? '', capacity: integer(f.size_max, 0), bookmarks: f.id_lieux ? f.id_lieux.split(',').map(v => integer(v)) : [] };
  });
}
function account(value: unknown): Account {
  if (!record(value) || typeof value.uuid !== 'string' || !value.uuid || typeof value.email !== 'string' || typeof value.abo_annuel_date_fin !== 'string' || typeof value.abo_mensuel_date_fin !== 'string') invalidResponse();
  const today = new Date().toISOString().slice(0, 10);
  const annual = value.abo_annuel_date_fin, monthly = value.abo_mensuel_date_fin;
  return { id: integer(value.id), username: value.uuid, email: value.email, isPremium: annual.slice(0, 10) >= today || monthly.slice(0, 10) >= today, annualSubscriptionEnds: annual, monthlySubscriptionEnds: monthly };
}
function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = Math.PI / 180;
  const h = Math.sin((b.lat - a.lat) * r / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin((b.lng - a.lng) * r / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, h)));
}

export class Park4nightClient {
  #auth: Auth | undefined;
  #transport: Transport;
  #rateLimit: Required<RateLimitOptions>;
  #queue: Promise<void> = Promise.resolve();
  #nextRequestAt = 0;
  #blockedUntil = 0;
  readonly language: Language;
  constructor(options: { language?: Language; transport?: Transport; rateLimit?: RateLimitOptions } = {}) {
    this.language = options.language ?? 'en';
    if (!['en', 'nl', 'fr', 'de', 'es', 'it'].includes(this.language)) throw new Park4nightError('INVALID_INPUT', 'Unsupported language.');
    this.#transport = options.transport ?? fetch;
    this.#rateLimit = rateLimitOptions(options.rateLimit ?? {});
  }
  logout(): void { this.#auth = undefined; }
  #requireAuth(): Auth {
    if (!this.#auth) throw new Park4nightError('AUTH_REQUIRED', 'Call login first.');
    return this.#auth;
  }
  #request(path: string, query: Record<string, string>, body?: RecordData): Promise<Json> {
    const result = this.#queue.then(() => this.#requestWithRetries(path, query, body));
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
  async #waitForSlot(): Promise<void> {
    const cooldown = this.#blockedUntil - Date.now();
    if (cooldown > this.#rateLimit.maxWaitMs) throw new Park4nightError('RATE_LIMITED', 'Park4night requests are paused. Try after retryAfterMs.', 429, cooldown);
    let delay = Math.max(this.#nextRequestAt, this.#blockedUntil) - Date.now();
    while (delay > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, delay));
      delay = Math.max(this.#nextRequestAt, this.#blockedUntil) - Date.now();
    }
    this.#nextRequestAt = Date.now() + this.#rateLimit.minIntervalMs;
  }
  async #requestWithRetries(path: string, query: Record<string, string>, body?: RecordData): Promise<Json> {
    for (let attempt = 0; ; attempt++) {
      await this.#waitForSlot();
      try {
        return await this.#send(path, query, body, attempt);
      } catch (error) {
        if (!(error instanceof Park4nightError) || error.code !== 'RATE_LIMITED' || body !== undefined || attempt >= this.#rateLimit.maxRetries || error.retryAfterMs! > this.#rateLimit.maxWaitMs) throw error;
      }
    }
  }
  async #send(path: string, query: Record<string, string>, body: RecordData | undefined, attempt: number): Promise<Json> {
    const form = body === undefined ? undefined : new FormData();
    form?.set('json', JSON.stringify(body));
    let response: Response;
    let text: string;
    try {
      response = await this.#transport(`https://park4night.com${path}?${new URLSearchParams(query)}`, { method: form ? 'POST' : 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', body: form, signal: AbortSignal.timeout(20000) });
      if (response.status === 429) {
        const delay = retryDelay(response.headers.get('Retry-After'), attempt);
        this.#blockedUntil = Math.max(this.#blockedUntil, Math.min(Number.MAX_SAFE_INTEGER, Date.now() + delay));
        await response.body?.cancel().catch(() => undefined);
        throw new Park4nightError('RATE_LIMITED', 'Park4night rate-limited this request. Try after retryAfterMs.', 429, Math.max(0, this.#blockedUntil - Date.now()));
      }
      text = await response.text();
    } catch (error) {
      if (error instanceof Park4nightError && error.code === 'RATE_LIMITED') throw error;
      throw new Park4nightError('NETWORK_ERROR', 'The Park4night request failed or timed out.');
    }
    if (response.status === 401 || response.status === 403) throw new Park4nightError('AUTH_REJECTED', 'Park4night rejected the credentials or account permission.', response.status);
    if (!response.ok) throw new Park4nightError('UPSTREAM_ERROR', `Park4night returned HTTP ${response.status}.`, response.status);
    let data: Json;
    try { data = JSON.parse(text) as Json; } catch { invalidResponse(); }
    if (record(data) && (data.error || (data.status !== undefined && data.status !== 'OK'))) {
      const authError = typeof data.status === 'string' && /pwd|password|user|auth|login/i.test(data.status);
      throw new Park4nightError(authError ? 'AUTH_REJECTED' : 'UPSTREAM_ERROR', authError ? 'Park4night rejected the credentials.' : 'Park4night rejected the request.', response.status);
    }
    return data;
  }
  async #native(endpoint: string, query: Record<string, string> = {}, body?: RecordData, authRequired = false): Promise<RecordData> {
    if (authRequired) this.#requireAuth();
    const auth = this.#auth;
    const data = await this.#request(`/services/V4.1/${endpoint}.php`, { context_os: 'ANDROID', os: 'ANDROID', context_lang: this.language, langue_locale: this.language, context_version: '7.1.62', ...(auth ? { context_user: auth.username, context_id_user: String(auth.id), motdepasse: auth.hash } : {}), ...query }, body);
    if (!record(data) || data.status !== 'OK') invalidResponse();
    return data;
  }
  async login(credentials: LoginCredentials): Promise<Account> {
    this.logout();
    if (typeof credentials.username !== 'string' || typeof credentials.password !== 'string') throw new Park4nightError('INVALID_INPUT', 'Username and password are required.');
    const username = credentials.username.replaceAll(' ', ''), password = credentials.password.trim();
    if (!username || !password) throw new Park4nightError('INVALID_INPUT', 'Username and password are required.');
    const hash = createHash('sha256').update(password, 'utf8').digest('hex');
    const data = await this.#native('userGet', { uuid: username, motdepasse: hash });
    const user = account(data.results);
    this.#auth = { username: user.username, id: user.id, hash };
    return user;
  }
  async me(): Promise<Account> {
    const auth = this.#requireAuth();
    return account((await this.#native('userGet', { uuid: auth.username })).results);
  }
  async search(options: SearchOptions): Promise<SearchResult> {
    if (!Number.isFinite(options.lat) || Math.abs(options.lat) > 90 || !Number.isFinite(options.lng) || Math.abs(options.lng) > 180) throw new Park4nightError('INVALID_INPUT', 'Valid latitude and longitude are required.');
    if (options.maxDistanceKm !== undefined && (!Number.isFinite(options.maxDistanceKm) || options.maxDistanceKm <= 0)) throw new Park4nightError('INVALID_INPUT', 'maxDistanceKm must be greater than zero.');
    const f = options.filter ?? {}, query: Record<string, string> = { latitude: String(options.lat), longitude: String(options.lng) };
    for (const [key, values] of [['types', [...(f.type ?? []), ...(f.custom_type ?? [])]], ['services', f.services], ['activites', f.activities]] as const) {
      if (values?.length) {
        if (values.some(v => typeof v !== 'string' || !v || v.includes('-'))) throw new Park4nightError('INVALID_INPUT', 'Filter codes must be non-empty strings without hyphens.');
        query[key] = values.join('-');
      }
    }
    if (f.rating !== undefined) query.note = f.rating;
    if (f.maxHeight !== undefined) query.hauteur_limite = f.maxHeight;
    if (f.all_year === '1') query.all_year = '1';
    if (f.booking_filter === '1') query.online_booking = '1';
    const result = places((await this.#native('lieuxGetFilter', query)).lieux);
    return { places: options.maxDistanceKm === undefined ? result : result.filter(p => distanceKm(options, p) <= options.maxDistanceKm!), returnedByUpstream: result.length, mayBeTruncated: result.length >= 100 };
  }
  async place(placeId: number): Promise<Place> {
    const result = places((await this.#native('lieuGetOneLieux', { id: String(id(placeId)), appli: 'park4night' })).lieux);
    const found = result.find(p => p.id === placeId);
    if (!found) throw new Park4nightError('NOT_FOUND', 'The place was not returned by Park4night.');
    return found;
  }
  async reviews(placeId: number): Promise<RecordData[]> {
    const data = await this.#native('commGet', { lieu_id: String(id(placeId)) });
    if (!Array.isArray(data.commentaires) || data.commentaires.some(r => !record(r))) invalidResponse();
    return data.commentaires as RecordData[];
  }
  async filters(kind: 'type' | 'custom_type' | 'activities' | 'services'): Promise<Json> {
    if (!['type', 'custom_type', 'activities', 'services'].includes(kind)) throw new Park4nightError('INVALID_INPUT', 'Invalid filter category.');
    return this.#request(`/api/places/filters/${kind}`, { lang: this.language });
  }
  async folders(): Promise<Folder[]> { return folders((await this.#native('lieuPatchFolder', { folder_id: '0' }, undefined, true)).folders); }
  async bookmarks(folderId = 0): Promise<Place[]> { return places((await this.#native('lieuPatchFolder', { folder_id: String(id(folderId, 0)) }, undefined, true)).lieux); }
  async myPlaces(kind: 'created' | 'visited' | 'commented'): Promise<Place[]> {
    if (!['created', 'visited', 'commented'].includes(kind)) throw new Park4nightError('INVALID_INPUT', 'Invalid place category.');
    const auth = this.#requireAuth();
    const query: Record<string, string> = { uuid: auth.username };
    if (kind === 'commented') query.user_id = String(auth.id);
    if (kind === 'visited') query.visites = 'true';
    return places((await this.#native(kind === 'commented' ? 'lieuGetCommUser' : 'lieuGetUser', query, undefined, true)).lieux);
  }
  async addBookmark(placeId: number, folderId = 0): Promise<void> {
    await this.#native('lieuPatchFolder', {}, { [String(id(folderId, 0))]: { id_lieux_add: String(id(placeId)), id_lieux_supp: '' } }, true);
  }
  async removeBookmark(placeId: number, folderId = 0): Promise<void> {
    await this.#native('lieuPatchFolder', {}, { [String(id(folderId, 0))]: { id_lieux_add: '', id_lieux_supp: String(id(placeId)) } }, true);
  }
  async createFolder(name: string, icon: string): Promise<Folder[]> {
    if (!name.trim() || !icon.trim()) throw new Park4nightError('INVALID_INPUT', 'Folder name and icon are required.');
    return folders((await this.#native('folderPut', {}, { name, icon }, true)).folders);
  }
  async updateFolder(folder: Pick<Folder, 'id' | 'name' | 'icon'>): Promise<Folder[]> {
    id(folder.id);
    if (!folder.name.trim() || !folder.icon.trim()) throw new Park4nightError('INVALID_INPUT', 'Folder name and icon are required.');
    return folders((await this.#native('folderPatch', {}, { id: folder.id, name: folder.name, icon: folder.icon }, true)).folders);
  }
  async deleteFolder(folderId: number): Promise<Folder[]> {
    id(folderId);
    const folder = (await this.folders()).find(f => f.id === folderId);
    if (!folder) throw new Park4nightError('NOT_FOUND', 'The folder does not exist.');
    return folders((await this.#native('folderDelete', {}, { id: folder.id, name: folder.name, icon: folder.icon }, true)).folders);
  }
}
