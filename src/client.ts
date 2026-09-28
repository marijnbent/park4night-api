import { createHash } from 'node:crypto';
import { Park4nightError, cancelled, throwIfCancelled } from './errors.ts';
import { RequestScheduler, type RateLimitOptions } from './scheduler.ts';
import { input, searchOptionsSchema, loginSchema, folderFieldsSchema, folderUpdateSchema, publicPlacesSchema, placeKindSchema, filterKindSchema, type SearchOptions, type PublicPlacesOptions } from './schemas.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RecordData = { [key: string]: Json };
export type Language = 'en' | 'nl' | 'fr' | 'de' | 'es' | 'it';
export { Park4nightError, type ErrorCode } from './errors.ts';
export { RequestScheduler, type RateLimitOptions } from './scheduler.ts';
export type { SearchFilter, SearchOptions, PublicPlacesOptions } from './schemas.ts';
export type RequestOptions = { signal?: AbortSignal };
export type Photo = RecordData & { id: number; largeUrl: string; thumbnailUrl: string };
export type Review = RecordData & { id: number; placeId: number; rating: number | null; text: string; username: string; createdAt: string };
export type Place = RecordData & { id: number; lat: number; lng: number; rating: number | null; reviewCount: number | null; services: Record<string, boolean>; photos: Photo[] };
export type Folder = { id: number; name: string; icon: string; bookmarks: number[]; capacity: number };
export type Account = { id: number; username: string; email: string; isPremium: boolean; annualSubscriptionEnds: string; monthlySubscriptionEnds: string };
export type SearchResult = { places: Place[]; returnedByUpstream: number; mayBeTruncated: boolean };
export type LoginCredentials = { username: string; password: string };
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

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
    const services: Record<string, boolean> = {};
    for (const key of ['caravaneige', 'animaux', 'point_eau', 'eau_noire', 'eau_usee', 'wc_public', 'poubelle', 'douche', 'boulangerie', 'electricite', 'wifi', 'piscine', 'laverie', 'gaz', 'gpl', 'donnees_mobile', 'lavage']) {
      if (p[key] === '1' || p[key] === 1 || p[key] === true) services[key] = true;
      if (p[key] === '0' || p[key] === 0 || p[key] === false) services[key] = false;
    }
    if (p.photos !== undefined && !Array.isArray(p.photos)) invalidResponse();
    const photos = (p.photos ?? []).map(photo => {
      if (!record(photo) || typeof photo.link_large !== 'string' || typeof photo.link_thumb !== 'string') invalidResponse();
      return { ...photo, id: integer(photo.id), largeUrl: photo.link_large, thumbnailUrl: photo.link_thumb };
    });
    return { ...p, id: integer(p.id), lat, lng, rating: optionalNumber(p.note_moyenne), reviewCount: optionalNumber(p.nb_commentaires), services, photos };
  });
}
function optionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  if ((typeof value !== 'number' && typeof value !== 'string') || !Number.isFinite(Number(value))) invalidResponse();
  return Number(value);
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
  #scheduler: RequestScheduler;
  #authController = new AbortController();
  #authGeneration = 0;
  readonly language: Language;
  constructor(options: { language?: Language; transport?: Transport; rateLimit?: RateLimitOptions; scheduler?: RequestScheduler } = {}) {
    this.language = options.language ?? 'en';
    if (!['en', 'nl', 'fr', 'de', 'es', 'it'].includes(this.language)) throw new Park4nightError('INVALID_INPUT', 'Unsupported language.');
    this.#transport = options.transport ?? fetch;
    if (options.scheduler && options.rateLimit) throw new Park4nightError('INVALID_INPUT', 'Configure rate limits on the shared scheduler.');
    this.#scheduler = options.scheduler ?? new RequestScheduler(options.rateLimit);
  }
  logout(): void {
    this.#authController.abort();
    this.#authController = new AbortController();
    this.#authGeneration++;
    this.#auth = undefined;
  }
  #requireAuth(): Auth {
    if (!this.#auth) throw new Park4nightError('AUTH_REQUIRED', 'Call login first.');
    return this.#auth;
  }
  #request(path: string, query: Record<string, string>, body?: RecordData, options: RequestOptions = {}): Promise<Json> {
    return this.#scheduler.run(attempt => this.#send(path, query, body, attempt, options.signal), { retryable: body === undefined, signal: options.signal });
  }
  async #send(path: string, query: Record<string, string>, body: RecordData | undefined, attempt: number, signal?: AbortSignal): Promise<Json> {
    const form = body === undefined ? undefined : new FormData();
    form?.set('json', JSON.stringify(body));
    let response: Response;
    let text: string;
    try {
      response = await this.#transport(`https://park4night.com${path}?${new URLSearchParams(query)}`, { method: form ? 'POST' : 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', body: form, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000) });
      if (response.status === 429) {
        const delay = retryDelay(response.headers.get('Retry-After'), attempt);
        await response.body?.cancel().catch(() => undefined);
        throw new Park4nightError('RATE_LIMITED', 'Park4night rate-limited this request. Try after retryAfterMs.', 429, delay);
      }
      text = await response.text();
    } catch (error) {
      if (error instanceof Park4nightError && error.code === 'RATE_LIMITED') throw error;
      throwIfCancelled(signal);
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
  async #native(endpoint: string, query: Record<string, string> = {}, body?: RecordData, authRequired = false, options: RequestOptions = {}): Promise<RecordData> {
    if (authRequired) this.#requireAuth();
    const auth = this.#auth;
    const signal = auth || authRequired ? (options.signal ? AbortSignal.any([options.signal, this.#authController.signal]) : this.#authController.signal) : options.signal;
    const data = await this.#request(`/services/V4.1/${endpoint}.php`, { context_os: 'ANDROID', os: 'ANDROID', context_lang: this.language, langue_locale: this.language, context_version: '7.1.62', ...(auth ? { context_user: auth.username, context_id_user: String(auth.id), motdepasse: auth.hash } : {}), ...query }, body, { signal });
    if (!record(data) || data.status !== 'OK') invalidResponse();
    return data;
  }
  async login(credentials: LoginCredentials, options: RequestOptions = {}): Promise<Account> {
    this.logout();
    const parsed = input(loginSchema, credentials);
    const generation = this.#authGeneration;
    const signal = options.signal ? AbortSignal.any([options.signal, this.#authController.signal]) : this.#authController.signal;
    const username = parsed.username.replaceAll(' ', '');
    if (!username) throw new Park4nightError('INVALID_INPUT', 'Username is required.');
    const hash = createHash('sha256').update(parsed.password, 'utf8').digest('hex');
    const data = await this.#native('userGet', { uuid: username, motdepasse: hash }, undefined, false, { signal });
    if (generation !== this.#authGeneration) throw cancelled();
    throwIfCancelled(signal);
    const user = account(data.results);
    this.#auth = { username: user.username, id: user.id, hash };
    return user;
  }
  async me(options: RequestOptions = {}): Promise<Account> {
    const auth = this.#requireAuth();
    return account((await this.#native('userGet', { uuid: auth.username }, undefined, true, options)).results);
  }
  async search(options: SearchOptions, request: RequestOptions = {}): Promise<SearchResult> {
    options = input(searchOptionsSchema, options);
    const f = options.filter ?? {}, query: Record<string, string> = { latitude: String(options.lat), longitude: String(options.lng) };
    for (const [key, values] of [['types', [...(f.type ?? []), ...(f.custom_type ?? [])]], ['services', f.services], ['activites', f.activities]] as const) {
      if (values?.length) {
        query[key] = values.join('-');
      }
    }
    if (f.rating !== undefined) query.note = f.rating;
    if (f.maxHeight !== undefined) query.hauteur_limite = f.maxHeight;
    if (f.all_year === '1') query.all_year = '1';
    if (f.booking_filter === '1') query.online_booking = '1';
    const result = places((await this.#native('lieuxGetFilter', query, undefined, false, request)).lieux);
    return { places: options.maxDistanceKm === undefined ? result : result.filter(p => distanceKm(options, p) <= options.maxDistanceKm!), returnedByUpstream: result.length, mayBeTruncated: result.length >= 100 };
  }
  async place(placeId: number, options: RequestOptions = {}): Promise<Place> {
    const result = places((await this.#native('lieuGetOneLieux', { id: String(id(placeId)), appli: 'park4night' }, undefined, false, options)).lieux);
    const found = result.find(p => p.id === placeId);
    if (!found) throw new Park4nightError('NOT_FOUND', 'The place was not returned by Park4night.');
    return found;
  }
  async reviews(placeId: number, options: RequestOptions = {}): Promise<Review[]> {
    const data = await this.#native('commGet', { lieu_id: String(id(placeId)) }, undefined, false, options);
    if (!Array.isArray(data.commentaires) || data.commentaires.some(r => !record(r))) invalidResponse();
    return data.commentaires.map(value => {
      if (!record(value) || typeof value.commentaire !== 'string' || typeof value.uuid !== 'string' || typeof value.date_creation !== 'string') invalidResponse();
      return { ...value, id: integer(value.id), placeId: integer(value.pn_lieu_id), rating: optionalNumber(value.note), text: value.commentaire, username: value.uuid, createdAt: value.date_creation };
    });
  }
  async filters(kind: 'type' | 'custom_type' | 'activities' | 'services', options: RequestOptions = {}): Promise<Json> {
    input(filterKindSchema, kind);
    return this.#request(`/api/places/filters/${kind}`, { lang: this.language }, undefined, options);
  }
  async folders(options: RequestOptions = {}): Promise<Folder[]> { return folders((await this.#native('lieuPatchFolder', { folder_id: '0' }, undefined, true, options)).folders); }
  async bookmarks(folderId = 0, options: RequestOptions = {}): Promise<Place[]> { return places((await this.#native('lieuPatchFolder', { folder_id: String(id(folderId, 0)) }, undefined, true, options)).lieux); }
  async myPlaces(kind: 'created' | 'visited' | 'commented', options: RequestOptions = {}): Promise<Place[]> {
    input(placeKindSchema, kind);
    const auth = this.#requireAuth();
    const query: Record<string, string> = { uuid: auth.username };
    if (kind === 'commented') query.user_id = String(auth.id);
    if (kind === 'visited') query.visites = 'true';
    return places((await this.#native(kind === 'commented' ? 'lieuGetCommUser' : 'lieuGetUser', query, undefined, true, options)).lieux);
  }
  async publicPlaces(query: PublicPlacesOptions, options: RequestOptions = {}): Promise<Place[]> {
    const parsed = input(publicPlacesSchema, query);
    const parameters: Record<string, string> = parsed.kind === 'commented' ? { user_id: String(parsed.userId) } : { uuid: parsed.username };
    if (parsed.kind === 'visited') parameters.visites = 'true';
    return places((await this.#native(parsed.kind === 'commented' ? 'lieuGetCommUser' : 'lieuGetUser', parameters, undefined, false, options)).lieux);
  }
  async addBookmark(placeId: number, folderId = 0, options: RequestOptions = {}): Promise<void> {
    await this.#native('lieuPatchFolder', {}, { [String(id(folderId, 0))]: { id_lieux_add: String(id(placeId)), id_lieux_supp: '' } }, true, options);
  }
  async removeBookmark(placeId: number, folderId = 0, options: RequestOptions = {}): Promise<void> {
    await this.#native('lieuPatchFolder', {}, { [String(id(folderId, 0))]: { id_lieux_add: '', id_lieux_supp: String(id(placeId)) } }, true, options);
  }
  async createFolder(name: string, icon: string, options: RequestOptions = {}): Promise<Folder[]> {
    ({ name, icon } = input(folderFieldsSchema, { name, icon }));
    return folders((await this.#native('folderPut', {}, { name, icon }, true, options)).folders);
  }
  async updateFolder(folder: Pick<Folder, 'id' | 'name' | 'icon'>, options: RequestOptions = {}): Promise<Folder[]> {
    folder = input(folderUpdateSchema, folder);
    return folders((await this.#native('folderPatch', {}, { id: folder.id, name: folder.name, icon: folder.icon }, true, options)).folders);
  }
  async deleteFolder(folderId: number, options: RequestOptions = {}): Promise<Folder[]> {
    id(folderId);
    const folder = (await this.folders(options)).find(f => f.id === folderId);
    if (!folder) throw new Park4nightError('NOT_FOUND', 'The folder does not exist.');
    return folders((await this.#native('folderDelete', {}, { id: folder.id, name: folder.name, icon: folder.icon }, true, options)).folders);
  }
}
