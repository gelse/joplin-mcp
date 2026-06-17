import type { Logger } from './logger.js';
import {
  AuthError,
  ConflictError,
  DataApiError,
  NotFoundError,
  ValidationError,
} from './errors.js';
import type {
  Note,
  Folder,
  Tag,
  Resource,
  NoteTag,
  Event,
  PaginatedResponse,
  SearchQuery,
  SearchResult,
  PingResponse,
  NoteCreatePayload,
  NoteUpdatePayload,
  FolderCreatePayload,
  FolderUpdatePayload,
  TagCreatePayload,
} from './api-types.js';
import { clampLimit, buildPageParam, fetchAllPages } from './pagination.js';

export class JoplinDataClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly maxConcurrency: number;
  private activeRequests = 0;
  private requestQueue: Array<{
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    fn: () => Promise<unknown>;
  }> = [];

  private authToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private pendingAuthPromise: Promise<string> | null = null;

  constructor(
    port: number,
    apiToken: string,
    private readonly logger: Logger,
    maxConcurrency: number = 5,
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.apiToken = apiToken;
    this.maxConcurrency = maxConcurrency;
  }

  /**
   * Validate that a user-supplied ID contains only safe characters
   * (alphanumeric, hyphens, underscores) to prevent path traversal
   * and injection attacks.
   */
  private validateId(id: string, label: string = 'id'): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      throw new ValidationError(
        `Invalid ${label}: "${id}" — must contain only alphanumeric characters, hyphens, and underscores`,
      );
    }
  }

  /**
   * Enforce a configurable concurrency limit on API requests.
   * If the maximum number of concurrent requests is already in flight,
   * the call is queued and executed when a slot becomes available.
   */
  private enqueueRequest<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeRequests < this.maxConcurrency) {
      this.activeRequests++;
      return fn().finally(() => {
        this.activeRequests--;
        this.processQueue();
      });
    }

    return new Promise<T>((resolve, reject) => {
      this.requestQueue.push({
        resolve: resolve as (value: unknown) => void,
        reject,
        fn,
      });
    });
  }

  /**
   * Process the next queued request(s) when concurrency slots open up.
   */
  private processQueue(): void {
    while (this.activeRequests < this.maxConcurrency && this.requestQueue.length > 0) {
      const item = this.requestQueue.shift()!;
      this.activeRequests++;
      item
        .fn()
        .then(item.resolve)
        .catch(item.reject)
        .finally(() => {
          this.activeRequests--;
          this.processQueue();
        });
    }
  }

  /**
   * Append the api.token as a query parameter to the path.
   * The Joplin ClipperServer Data API uses ?token= for authentication.
   */
  private appendToken(path: string): string {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}token=${encodeURIComponent(this.apiToken)}`;
  }

  /**
   * Authenticate with the Joplin Data API to obtain a session token.
   * The token is cached internally with a 55-minute expiry.
   *
   * @throws {AuthError} If the auth endpoint returns an error or lacks auth_token
   */
  private async authenticate(): Promise<string> {
    const url = `${this.baseUrl}${this.appendToken('/auth')}`;
    this.logger.debug('Authenticating with Joplin Data API');

    const response = await fetch(url, { method: 'POST' });

    if (!response.ok) {
      throw new AuthError(
        `Authentication failed: ${response.status} ${response.statusText}`,
      );
    }

    const data = (await response.json()) as { auth_token?: string };
    if (!data.auth_token) {
      throw new AuthError('Authentication response missing auth_token');
    }

    this.authToken = data.auth_token;
    // Token expires after 55 minutes (3300 seconds)
    this.tokenExpiresAt = Date.now() + 3300 * 1000;
    return this.authToken;
  }

  /**
   * Build the Authorization header if a cached token is available.
   * Performs proactive refresh when the token is within 60 seconds of expiry.
   * Deduplicates concurrent in-flight authentication requests.
   */
  private async getAuthHeaders(): Promise<Record<string, string> | null> {
    // If nothing is cached or in-flight, skip
    if (!this.authToken && !this.pendingAuthPromise) {
      return null;
    }

    const bufferMs = 60 * 1000; // 60-second proactive refresh buffer
    const now = Date.now();

    // Proactive refresh: if the token is within the buffer window, clear it
    if (this.authToken && now >= this.tokenExpiresAt - bufferMs) {
      this.authToken = null;
    }

    // If we need a token, obtain one (deduplicate concurrent requests)
    if (!this.authToken) {
      if (!this.pendingAuthPromise) {
        this.pendingAuthPromise = this.authenticate().finally(() => {
          this.pendingAuthPromise = null;
        });
      }
      await this.pendingAuthPromise;
    }

    if (!this.authToken) {
      return null;
    }

    return { Authorization: `Bearer ${this.authToken}` };
  }

  /**
   * Discard the cached authentication token.
   * Next request will trigger a fresh authentication cycle.
   */
  clearToken(): void {
    this.authToken = null;
    this.tokenExpiresAt = 0;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return this.enqueueRequest(async () => {
      return this.executeRequest<T>(method, path, body);
    });
  }

  private async executeRequest<T>(
    method: string,
    path: string,
    body?: unknown,
    isRetry = false,
  ): Promise<T> {
    const url = `${this.baseUrl}${this.appendToken(path)}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Add auth header if available (also triggers proactive refresh)
    const authHeaders = await this.getAuthHeaders();
    if (authHeaders) {
      Object.assign(headers, authHeaders);
    }

    this.logger.debug({ method, path, isRetry }, 'Data API request');

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    // --- 401 handling: token refresh and retry ---
    if (response.status === 401) {
      if (isRetry) {
        // Already refreshed once, give up
        throw new AuthError('Authentication failed after token refresh');
      }
      // Clear the stale token and obtain a fresh one
      this.clearToken();
      try {
        await this.authenticate();
      } catch (err) {
        if (err instanceof AuthError) throw err;
        throw new AuthError('Authentication failed');
      }
      // Retry the original request with the new token
      return this.executeRequest<T>(method, path, body, true);
    }

    if (response.status === 404) {
      const resourceType = path.split('/').filter(Boolean)[0] || 'resource';
      this.logger.debug({ status: 404, path }, 'Request failed');
      throw new NotFoundError(resourceType, resourceType);
    }
    if (response.status === 409) {
      const resourceType = path.split('/').filter(Boolean)[0] || 'resource';
      this.logger.debug({ status: 409, path }, 'Request failed');
      throw new ConflictError(resourceType, resourceType);
    }
    if (response.status === 400) {
      const body = await response.text().catch(() => '');
      this.logger.debug({ status: 400, path, body }, 'Request failed');
      throw new ValidationError('Bad request');
    }
    if (response.status === 403) {
      const body = await response.text().catch(() => '');
      this.logger.debug({ status: 403, path, body }, 'Request failed');
      throw new ValidationError(`Forbidden: ${body}`);
    }
    if ([500, 502, 503].includes(response.status)) {
      const resourceType = path.split('/').filter(Boolean)[0] || 'resource';
      const body = await response.text().catch(() => '');
      this.logger.debug({ status: response.status, path }, 'Request failed');
      throw new DataApiError(
        `Server error (${response.status}) accessing ${resourceType}`,
        response.status,
        body,
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new DataApiError(
        `Joplin Data API error: ${response.status} ${response.statusText}`,
        response.status,
        body,
      );
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json() as Promise<T>;
    }
    // Non-JSON response (e.g., /ping returns plain text)
    return response.text() as unknown as T;
  }

  // === Ping ===

  /**
   * Ping the Joplin Data API to verify connectivity.
   *
   * @returns A ping response containing `status` and `version` strings
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async ping(): Promise<PingResponse> {
    const response = await this.request<string>('GET', '/ping');
    // ClipperServer returns plain text (e.g., "JoplinClipperServer")
    if (typeof response === 'string') {
      return { status: 'ok', version: response };
    }
    return response as unknown as PingResponse;
  }

  // === Notes ===

  /**
   * List notes with optional pagination.
   *
   * @param limit - Maximum items per page (clamped to 1–100; defaults to 100)
   * @param page - Page number (1-based; defaults to 1)
   * @returns A paginated response containing an array of notes and a `has_more` flag
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async listNotes(limit?: number, page?: number): Promise<PaginatedResponse<Note>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Note>>('GET', `/notes${params}`);
  }

  /**
   * Fetch all notes by iterating through all pages automatically.
   *
   * @returns A complete, flattened array of all notes
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async getAllNotes(): Promise<Note[]> {
    return fetchAllPages((page) => this.listNotes(100, page));
  }

  /**
   * Read a single note by ID.
   *
   * @param id - The 32-character hex note ID
   * @returns The full note object, including body content
   * @throws {ValidationError} If the ID contains invalid characters
   * @throws {NotFoundError} If the note does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async getNote(id: string): Promise<Note> {
    this.validateId(id, 'note_id');
    return this.request<Note>('GET', `/notes/${id}`);
  }

  /**
   * Create a new note.
   *
   * @param payload - The note creation payload (title is required; parent_id, body, and other fields are optional)
   * @returns The newly created note object
   * @throws {ValidationError} If the payload is invalid
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async createNote(payload: NoteCreatePayload): Promise<Note> {
    return this.request<Note>('POST', '/notes', payload);
  }

  /**
   * Update an existing note.
   *
   * @param id - The 32-character hex note ID
   * @param payload - The fields to update (all optional; only provided fields are changed)
   * @returns The updated note object
   * @throws {ValidationError} If the ID contains invalid characters
   * @throws {NotFoundError} If the note does not exist
   * @throws {ConflictError} If the note was modified since last fetch
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async updateNote(id: string, payload: NoteUpdatePayload): Promise<Note> {
    this.validateId(id, 'note_id');
    return this.request<Note>('PUT', `/notes/${id}`, payload);
  }

  /**
   * Delete a note by ID.
   *
   * @param id - The 32-character hex note ID
   * @throws {ValidationError} If the ID contains invalid characters
   * @throws {NotFoundError} If the note does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async deleteNote(id: string): Promise<void> {
    this.validateId(id, 'note_id');
    await this.request<never>('DELETE', `/notes/${id}`);
  }

  // === Folders (Notebooks) ===

  /**
   * List folders (notebooks) with optional pagination.
   *
   * @param limit - Maximum items per page (clamped to 1–100; defaults to 100)
   * @param page - Page number (1-based; defaults to 1)
   * @returns A paginated response containing an array of folders and a `has_more` flag
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async listFolders(limit?: number, page?: number): Promise<PaginatedResponse<Folder>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Folder>>('GET', `/folders${params}`);
  }

  /**
   * Fetch all folders by iterating through all pages automatically.
   *
   * @returns A complete, flattened array of all folders
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async getAllFolders(): Promise<Folder[]> {
    return fetchAllPages((page) => this.listFolders(100, page));
  }

  /**
   * Read a single folder (notebook) by ID.
   *
   * @param id - The 32-character hex folder ID
   * @returns The folder object
   * @throws {ValidationError} If the ID contains invalid characters
   * @throws {NotFoundError} If the folder does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async getFolder(id: string): Promise<Folder> {
    this.validateId(id, 'folder_id');
    return this.request<Folder>('GET', `/folders/${id}`);
  }

  /**
   * Create a new folder (notebook).
   *
   * @param payload - The folder creation payload (title is required; parent_id and icon are optional)
   * @returns The newly created folder object
   * @throws {ValidationError} If the payload is invalid
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async createFolder(payload: FolderCreatePayload): Promise<Folder> {
    return this.request<Folder>('POST', '/folders', payload);
  }

  /**
   * Update an existing folder (notebook).
   *
   * @param id - The 32-character hex folder ID
   * @param payload - The fields to update (all optional; only provided fields are changed)
   * @returns The updated folder object
   * @throws {ValidationError} If the ID contains invalid characters
   * @throws {NotFoundError} If the folder does not exist
   * @throws {ConflictError} If the folder was modified since last fetch
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async updateFolder(id: string, payload: FolderUpdatePayload): Promise<Folder> {
    this.validateId(id, 'folder_id');
    return this.request<Folder>('PUT', `/folders/${id}`, payload);
  }

  /**
   * Delete a folder (notebook) by ID.
   *
   * @param id - The 32-character hex folder ID
   * @throws {ValidationError} If the ID contains invalid characters
   * @throws {NotFoundError} If the folder does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async deleteFolder(id: string): Promise<void> {
    this.validateId(id, 'folder_id');
    await this.request<never>('DELETE', `/folders/${id}`);
  }

  // === Tags ===

  /**
   * List tags with optional pagination.
   *
   * @param limit - Maximum items per page (clamped to 1–100; defaults to 100)
   * @param page - Page number (1-based; defaults to 1)
   * @returns A paginated response containing an array of tags and a `has_more` flag
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async listTags(limit?: number, page?: number): Promise<PaginatedResponse<Tag>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Tag>>('GET', `/tags${params}`);
  }

  /**
   * Fetch all tags by iterating through all pages automatically.
   *
   * @returns A complete, flattened array of all tags
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async getAllTags(): Promise<Tag[]> {
    return fetchAllPages((page) => this.listTags(100, page));
  }

  /**
   * Read a single tag by ID.
   *
   * @param id - The 32-character hex tag ID
   * @returns The tag object
   * @throws {ValidationError} If the ID contains invalid characters
   * @throws {NotFoundError} If the tag does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async getTag(id: string): Promise<Tag> {
    this.validateId(id, 'tag_id');
    return this.request<Tag>('GET', `/tags/${id}`);
  }

  /**
   * Create a new tag.
   *
   * @param payload - The tag creation payload (title is required)
   * @returns The newly created tag object
   * @throws {ValidationError} If the payload is invalid
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async createTag(payload: TagCreatePayload): Promise<Tag> {
    return this.request<Tag>('POST', '/tags', payload);
  }

  /**
   * Delete a tag by ID.
   *
   * @param id - The 32-character hex tag ID
   * @throws {ValidationError} If the ID contains invalid characters
   * @throws {NotFoundError} If the tag does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async deleteTag(id: string): Promise<void> {
    this.validateId(id, 'tag_id');
    await this.request<never>('DELETE', `/tags/${id}`);
  }

  // === Note-Tag relationships ===

  /**
   * Get all tags associated with a note.
   *
   * @param noteId - The 32-character hex note ID
   * @returns An array of tags attached to the note
   * @throws {ValidationError} If the note ID contains invalid characters
   * @throws {NotFoundError} If the note does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async getNoteTags(noteId: string): Promise<Tag[]> {
    this.validateId(noteId, 'note_id');
    return this.request<Tag[]>('GET', `/notes/${noteId}/tags`);
  }

  /**
   * Apply a tag to a note.
   *
   * @param noteId - The 32-character hex note ID
   * @param tagId - The 32-character hex tag ID
   * @returns The created note-tag relationship object
   * @throws {ValidationError} If either ID contains invalid characters
   * @throws {NotFoundError} If the note or tag does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async tagNote(noteId: string, tagId: string): Promise<NoteTag> {
    this.validateId(noteId, 'note_id');
    this.validateId(tagId, 'tag_id');
    return this.request<NoteTag>('POST', `/notes/${noteId}/tags`, {
      id: tagId,
    });
  }

  /**
   * Remove a tag from a note.
   *
   * @param noteId - The 32-character hex note ID
   * @param tagId - The 32-character hex tag ID
   * @throws {ValidationError} If either ID contains invalid characters
   * @throws {NotFoundError} If the note, tag, or note-tag relationship does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async untagNote(noteId: string, tagId: string): Promise<void> {
    this.validateId(noteId, 'note_id');
    this.validateId(tagId, 'tag_id');
    await this.request<never>('DELETE', `/notes/${noteId}/tags/${tagId}`);
  }

  // === Resources ===

  /**
   * List resources with optional pagination.
   *
   * @param limit - Maximum items per page (clamped to 1–100; defaults to 100)
   * @param page - Page number (1-based; defaults to 1)
   * @returns A paginated response containing an array of resources and a `has_more` flag
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async listResources(limit?: number, page?: number): Promise<PaginatedResponse<Resource>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Resource>>('GET', `/resources${params}`);
  }

  /**
   * Fetch all resources by iterating through all pages automatically.
   *
   * @returns A complete, flattened array of all resources
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async getAllResources(): Promise<Resource[]> {
    return fetchAllPages((page) => this.listResources(100, page));
  }

  /**
   * Read a single resource by ID.
   *
   * @param id - The 32-character hex resource ID
   * @returns The resource object
   * @throws {ValidationError} If the ID contains invalid characters
   * @throws {NotFoundError} If the resource does not exist
   * @throws {AuthError} If the token is expired or authentication fails
   */
  async getResource(id: string): Promise<Resource> {
    this.validateId(id, 'resource_id');
    return this.request<Resource>('GET', `/resources/${id}`);
  }

  // === Events ===

  /**
   * List events with optional pagination.
   *
   * @param limit - Maximum items per page (clamped to 1–100; defaults to 100)
   * @param page - Page number (1-based; defaults to 1)
   * @returns A paginated response containing an array of events and a `has_more` flag
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async listEvents(limit?: number, page?: number): Promise<PaginatedResponse<Event>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Event>>('GET', `/events${params}`);
  }

  // === Search ===

  /**
   * Search for notes, folders, and tags by a query string.
   *
   * @param query - The search query including the text and an optional type filter
   * @returns An array of search results matching the query
   * @throws {ValidationError} If the query is invalid
   * @throws {AuthError} If the token is expired or authentication fails
   * @throws {DataApiError} On unexpected HTTP errors
   */
  async search(query: SearchQuery): Promise<SearchResult[]> {
    const params = new URLSearchParams();
    params.set('query', query.query);
    if (query.type) params.set('type', query.type);

    return this.request<SearchResult[]>('GET', `/search?${params.toString()}`);
  }
}
