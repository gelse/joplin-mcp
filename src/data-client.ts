import type { Logger } from "./logger.js";
import {
  AuthError,
  ConflictError,
  DataApiError,
  NotFoundError,
  ValidationError,
} from "./errors.js";
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
} from "./api-types.js";
import { clampLimit, buildPageParam, fetchAllPages } from "./pagination.js";

export class JoplinDataClient {
  private readonly baseUrl: string;
  private token: string | null = null;

  constructor(
    port: number,
    private readonly logger: Logger
  ) {
    this.baseUrl = `http://127.0.0.1:${port}`;
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;

    const response = await fetch(`${this.baseUrl}/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });

    if (!response.ok) {
      throw new AuthError(
        `Failed to obtain Joplin API token: ${response.status} ${response.statusText}`
      );
    }

    const data = (await response.json()) as { auth_token?: string };
    if (!data.auth_token) {
      throw new AuthError("No auth_token in response");
    }

    this.token = data.auth_token;
    return this.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    retryAuth = true
  ): Promise<T> {
    const makeRequest = async (): Promise<Response> => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (this.token) {
        headers["Authorization"] = `Bearer ${this.token}`;
      }

      this.logger.debug({ method, path }, "Data API request");

      return fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    };

    let response = await makeRequest();

    // If unauthorized, try getting a new token and retry once
    if (response.status === 401 && retryAuth) {
      this.logger.debug("Token expired, refreshing");
      this.token = null;
      await this.getToken();
      response = await makeRequest();
    }

    if (response.status === 401) throw new AuthError();
    if (response.status === 404)
      throw new NotFoundError("resource", path);
    if (response.status === 409)
      throw new ConflictError("resource", path);
    if (response.status === 400) {
      const body = await response.text().catch(() => "");
      throw new ValidationError(
        `Bad request: ${path} — ${body}`
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new DataApiError(
        `Joplin Data API error: ${response.status} ${response.statusText}`,
        response.status,
        body
      );
    }

    return response.json() as Promise<T>;
  }

  // === Ping ===
  async ping(): Promise<PingResponse> {
    return this.request<PingResponse>("GET", "/ping");
  }

  // === Notes ===
  async listNotes(
    limit?: number,
    page?: number
  ): Promise<PaginatedResponse<Note>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Note>>("GET", `/notes${params}`);
  }

  async getAllNotes(): Promise<Note[]> {
    return fetchAllPages((page) => this.listNotes(100, page));
  }

  async getNote(id: string): Promise<Note> {
    return this.request<Note>("GET", `/notes/${id}`);
  }

  async createNote(payload: NoteCreatePayload): Promise<Note> {
    return this.request<Note>("POST", "/notes", payload);
  }

  async updateNote(id: string, payload: NoteUpdatePayload): Promise<Note> {
    return this.request<Note>("PUT", `/notes/${id}`, payload);
  }

  async deleteNote(id: string): Promise<void> {
    await this.request<never>("DELETE", `/notes/${id}`);
  }

  // === Folders (Notebooks) ===
  async listFolders(
    limit?: number,
    page?: number
  ): Promise<PaginatedResponse<Folder>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Folder>>("GET", `/folders${params}`);
  }

  async getAllFolders(): Promise<Folder[]> {
    return fetchAllPages((page) => this.listFolders(100, page));
  }

  async getFolder(id: string): Promise<Folder> {
    return this.request<Folder>("GET", `/folders/${id}`);
  }

  async createFolder(payload: FolderCreatePayload): Promise<Folder> {
    return this.request<Folder>("POST", "/folders", payload);
  }

  async updateFolder(id: string, payload: FolderUpdatePayload): Promise<Folder> {
    return this.request<Folder>("PUT", `/folders/${id}`, payload);
  }

  async deleteFolder(id: string): Promise<void> {
    await this.request<never>("DELETE", `/folders/${id}`);
  }

  // === Tags ===
  async listTags(
    limit?: number,
    page?: number
  ): Promise<PaginatedResponse<Tag>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Tag>>("GET", `/tags${params}`);
  }

  async getAllTags(): Promise<Tag[]> {
    return fetchAllPages((page) => this.listTags(100, page));
  }

  async getTag(id: string): Promise<Tag> {
    return this.request<Tag>("GET", `/tags/${id}`);
  }

  async createTag(payload: TagCreatePayload): Promise<Tag> {
    return this.request<Tag>("POST", "/tags", payload);
  }

  async deleteTag(id: string): Promise<void> {
    await this.request<never>("DELETE", `/tags/${id}`);
  }

  // === Note-Tag relationships ===
  async getNoteTags(noteId: string): Promise<Tag[]> {
    return this.request<Tag[]>("GET", `/notes/${noteId}/tags`);
  }

  async tagNote(noteId: string, tagId: string): Promise<NoteTag> {
    return this.request<NoteTag>("POST", `/notes/${noteId}/tags`, {
      id: tagId,
    });
  }

  async untagNote(noteId: string, tagId: string): Promise<void> {
    await this.request<never>(
      "DELETE",
      `/notes/${noteId}/tags/${tagId}`
    );
  }

  // === Resources ===
  async listResources(
    limit?: number,
    page?: number
  ): Promise<PaginatedResponse<Resource>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Resource>>(
      "GET",
      `/resources${params}`
    );
  }

  async getAllResources(): Promise<Resource[]> {
    return fetchAllPages((page) => this.listResources(100, page));
  }

  async getResource(id: string): Promise<Resource> {
    return this.request<Resource>("GET", `/resources/${id}`);
  }

  // === Events ===
  async listEvents(
    limit?: number,
    page?: number
  ): Promise<PaginatedResponse<Event>> {
    const params = `?limit=${clampLimit(limit)}${buildPageParam(page)}`;
    return this.request<PaginatedResponse<Event>>("GET", `/events${params}`);
  }

  // === Search ===
  async search(query: SearchQuery): Promise<SearchResult[]> {
    const params = new URLSearchParams();
    params.set("query", query.query);
    if (query.type) params.set("type", query.type);

    return this.request<SearchResult[]>(
      "GET",
      `/search?${params.toString()}`
    );
  }
}
