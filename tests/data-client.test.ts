import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JoplinDataClient } from '../src/data-client.js';
import { fetchAllPages } from '../src/pagination.js';
import type { Logger } from '../src/logger.js';
import {
  AuthError,
  NotFoundError,
  ConflictError,
  ValidationError,
  DataApiError,
} from '../src/errors.js';

// ---------------------------------------------------------------------------
// Mock the pagination module so we can control fetchAllPages independently
// ---------------------------------------------------------------------------
vi.mock('../src/pagination.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/pagination.js')>();
  return {
    ...actual,
    fetchAllPages: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Helper: build a minimal Response‑like object that satisfies what the
// client's `request` method actually uses.
// ---------------------------------------------------------------------------
function okResponse(
  data: unknown,
  overrides?: Partial<{
    status: number;
    statusText: string;
  }>,
) {
  const status = overrides?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: overrides?.statusText ?? 'OK',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    headers: new Headers({ 'content-type': 'application/json' }),
  } as unknown as Response;
}

function errorResponse(status: number, statusText: string, body?: string) {
  return {
    ok: false,
    status,
    statusText,
    json: () => Promise.reject(new Error('Not JSON')),
    text: () => Promise.resolve(body ?? ''),
    headers: new Headers(),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Shared test values
// ---------------------------------------------------------------------------
const MOCK_AUTH_TOKEN = 'test-auth-token-abc123';
const PORT = 41100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

const sampleNote = {
  id: 'note-1',
  parent_id: '',
  title: 'Test Note',
  body: 'Hello',
  created_time: 1,
  updated_time: 2,
  is_conflict: 0,
  latitude: 0,
  longitude: 0,
  altitude: 0,
  author: '',
  source_url: '',
  is_todo: 0,
  todo_due: 0,
  todo_completed: 0,
  source: '',
  source_application: '',
  application_data: '',
  order: 0,
  user_created_time: 1,
  user_updated_time: 2,
  encryption_cipher_text: '',
  encryption_applied: 0,
  markup_language: 0,
  is_shared: 0,
  share_id: '',
  conflict_original_id: '',
  master_key_id: '',
  type_: 1,
};

const sampleFolder = {
  id: 'folder-1',
  parent_id: '',
  title: 'Test Folder',
  created_time: 1,
  updated_time: 2,
  user_created_time: 1,
  user_updated_time: 2,
  encryption_cipher_text: '',
  encryption_applied: 0,
  is_shared: 0,
  share_id: '',
  master_key_id: '',
  icon: '',
};

const sampleTag = {
  id: 'tag-1',
  title: 'Test Tag',
  created_time: 1,
  updated_time: 2,
  user_created_time: 1,
  user_updated_time: 2,
  encryption_cipher_text: '',
  encryption_applied: 0,
  is_shared: 0,
  parent_id: '',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('JoplinDataClient', () => {
  let client: JoplinDataClient;
  let mockFetch: ReturnType<typeof vi.fn>;
  let fetchAllPagesMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    fetchAllPagesMock = vi.mocked(fetchAllPages);
    client = new JoplinDataClient(PORT, 'test-api-token', mockLogger);
  });

  // =====================================================================
  // Authentication & Token Management
  // =====================================================================
  describe('authentication', () => {
    it('obtains and stores a token on first request that returns 401', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // 1st call → 401
        .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN })) // /auth → token
        .mockResolvedValueOnce(okResponse(sampleNote)); // retry → success

      const note = await client.getNote('note-1');

      expect(note).toMatchObject({ id: 'note-1' });
      // /auth was called exactly once
      const authCalls = mockFetch.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes('/auth'),
      );
      expect(authCalls).toHaveLength(1);
    });

    it('throws AuthError when the auth endpoint returns an error', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // endpoint → 401
        .mockResolvedValueOnce(errorResponse(500, 'Internal Error')); // /auth → 500

      await expect(client.getNote('x')).rejects.toThrow(AuthError);
    });

    it('throws AuthError when auth response lacks auth_token', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // endpoint → 401
        .mockResolvedValueOnce(okResponse({})); // /auth → no auth_token

      await expect(client.getNote('x')).rejects.toThrow(AuthError);
    });

    it('auto‑refreshes token on 401 and retries the original request', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // 1st getNote → 401
        .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN })) // /auth → token
        .mockResolvedValueOnce(okResponse(sampleNote)); // retry → success

      const note = await client.getNote('note-1');

      expect(note).toMatchObject({ id: 'note-1' });
      // fetch should have been called 3 times: endpoint, /auth, endpoint retry
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('reuses a cached token on subsequent requests', async () => {
      // First request: 401 → auth → success (sets the token)
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // listNotes → 401
        .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN })) // /auth → token
        .mockResolvedValueOnce(okResponse({ items: [sampleNote], has_more: false })) // listNotes retry
        // Second request: cached token → no /auth call needed
        .mockResolvedValueOnce(okResponse({ items: [sampleNote], has_more: false }));

      await client.listNotes();
      await client.listNotes();

      // /auth should have been called only once
      const authCalls = mockFetch.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes('/auth'),
      );
      expect(authCalls).toHaveLength(1);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('clears cached token on 401 and fetches a fresh one', async () => {
      // This is covered by the auto‑refresh test — the token is nulled
      // before fetching a new one.  We verify the exact sequence of URLs.
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // 1st → 401
        .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN })) // /auth
        .mockResolvedValueOnce(okResponse(sampleNote)); // retry

      await client.getNote('n1');

      const urls = mockFetch.mock.calls.map((call: unknown[]) => call[0] as string);
      expect(urls[0]).toContain('/notes/n1');
      expect(urls[1]).toContain('/auth');
      expect(urls[2]).toContain('/notes/n1');
    });

    it('proactively refreshes token when near expiry', async () => {
      vi.useFakeTimers();
      try {
        // First request: 401 → /auth → success (token cached with expiry)
        mockFetch
          .mockResolvedValueOnce(errorResponse(401, 'Unauthorized'))
          .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN }))
          .mockResolvedValueOnce(okResponse(sampleNote))
          // Second request: token near expiry → getToken calls /auth proactively
          .mockResolvedValueOnce(okResponse({ auth_token: 'fresh-token-xyz' }))
          .mockResolvedValueOnce(okResponse(sampleNote));

        await client.getNote('n1');

        // Advance time past the 1-min buffer (55min - 1min = 54min = 3240s)
        // At 3250s past original, the token is expired relative to the buffer
        vi.advanceTimersByTime(3250 * 1000);

        await client.getNote('n2');

        // /auth should have been called twice: initial + proactive refresh
        const authCalls = mockFetch.mock.calls.filter((call: unknown[]) =>
          (call[0] as string).includes('/auth'),
        );
        expect(authCalls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT refresh token when still valid', async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(errorResponse(401, 'Unauthorized'))
          .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN }))
          .mockResolvedValueOnce(okResponse(sampleNote))
          .mockResolvedValueOnce(okResponse(sampleNote));

        await client.getNote('n1');

        // Advance only 100 seconds (well within the 54-min buffer)
        vi.advanceTimersByTime(100 * 1000);

        await client.getNote('n2');

        // /auth should have been called only once (the initial fetch)
        const authCalls = mockFetch.mock.calls.filter((call: unknown[]) =>
          (call[0] as string).includes('/auth'),
        );
        expect(authCalls).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('clears token when refresh fails', async () => {
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // 1st getNote → 401
        .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN })) // /auth → token
        .mockResolvedValueOnce(okResponse(sampleNote)) // retry → success
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // 2nd getNote → 401
        .mockResolvedValueOnce(errorResponse(500, 'Server Error')); // /auth → 500 (fails)

      await client.getNote('n1');

      await expect(client.getNote('n2')).rejects.toThrow(AuthError);

      // After clearToken(), subsequent calls should trigger a fresh auth cycle
      // (endpoint 401 → /auth → retry)
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // 3rd getNote → 401
        .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN })) // /auth → token
        .mockResolvedValueOnce(okResponse(sampleNote)); // retry → success

      await client.getNote('n3');

      // /auth called 3 times: initial, failed refresh, fresh start
      const authCalls = mockFetch.mock.calls.filter((call: unknown[]) =>
        (call[0] as string).includes('/auth'),
      );
      expect(authCalls).toHaveLength(3);
    });

    it('deduplicates concurrent in-flight token requests', async () => {
      vi.useFakeTimers();
      try {
        // First request: 401 → /auth → success (token cached with 3300s expiry)
        mockFetch
          .mockResolvedValueOnce(errorResponse(401, 'Unauthorized'))
          .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN }))
          .mockResolvedValueOnce(okResponse(sampleNote));

        await client.getNote('n1');

        // Advance time past the 1-min buffer (55min - 1min = 54min = 3240s)
        // At 3250s the token is within the 60s buffer zone, triggering a refresh
        vi.advanceTimersByTime(3250 * 1000);

        // Two concurrent requests should now share a single /auth refresh call
        const authResponse = okResponse({ auth_token: 'fresh-token-xyz' });
        const noteResponse = okResponse(sampleNote);

        mockFetch
          .mockResolvedValueOnce(authResponse) // shared /auth (only consumed once)
          .mockResolvedValueOnce(noteResponse) // 1st getNote
          .mockResolvedValueOnce(noteResponse); // 2nd getNote

        const [note1, note2] = await Promise.all([client.getNote('n1'), client.getNote('n2')]);

        expect(note1).toMatchObject({ id: 'note-1' });
        expect(note2).toMatchObject({ id: 'note-1' });

        // /auth should have been called twice: initial + shared refresh
        const authCalls = mockFetch.mock.calls.filter((call: unknown[]) =>
          (call[0] as string).includes('/auth'),
        );
        expect(authCalls).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // =====================================================================
  // Note CRUD
  // =====================================================================
  describe('Note CRUD', () => {
    it('listNotes calls GET /notes with pagination parameters', async () => {
      const paginatedResponse = { items: [sampleNote], has_more: false };
      mockFetch.mockResolvedValueOnce(okResponse(paginatedResponse));

      const result = await client.listNotes(50, 2);

      expect(result).toEqual(paginatedResponse);
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toContain('/notes?limit=50&page=2');
      expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: 'GET' });
    });

    it('getNote calls GET /notes/:id and returns the parsed note', async () => {
      mockFetch.mockResolvedValueOnce(okResponse(sampleNote));

      const note = await client.getNote('note-1');

      expect(note).toMatchObject({ id: 'note-1', title: 'Test Note' });
      const fetchUrl = mockFetch.mock.calls[0][0] as string;
      expect(fetchUrl).toBe(`${BASE_URL}/notes/note-1?token=test-api-token`);
    });

    it('getNote throws NotFoundError on 404', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

      await expect(client.getNote('missing')).rejects.toThrow(NotFoundError);
    });

    it('createNote POSTs to /notes with the payload', async () => {
      const payload = { title: 'New Note', body: 'Content' };
      const created = { ...sampleNote, title: 'New Note', body: 'Content' };
      mockFetch.mockResolvedValueOnce(okResponse(created));

      const result = await client.createNote(payload);

      expect(result).toMatchObject({ title: 'New Note' });
      const call = mockFetch.mock.calls[0];
      expect(call[0] as string).toBe(`${BASE_URL}/notes?token=test-api-token`);
      expect((call[1] as Record<string, unknown>).method).toBe('POST');
      expect(JSON.parse((call[1] as Record<string, unknown>).body as string)).toEqual(payload);
    });

    it('updateNote PUTs to /notes/:id with the payload', async () => {
      const payload = { title: 'Updated' };
      const updated = { ...sampleNote, title: 'Updated' };
      mockFetch.mockResolvedValueOnce(okResponse(updated));

      const result = await client.updateNote('note-1', payload);

      expect(result).toMatchObject({ title: 'Updated' });
      const call = mockFetch.mock.calls[0];
      expect(call[0] as string).toBe(`${BASE_URL}/notes/note-1?token=test-api-token`);
      expect((call[1] as Record<string, unknown>).method).toBe('PUT');
      expect(JSON.parse((call[1] as Record<string, unknown>).body as string)).toEqual(payload);
    });

    it('updateNote throws ConflictError on 409', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(409, 'Conflict'));

      await expect(client.updateNote('note-1', { title: 'X' })).rejects.toThrow(ConflictError);
    });

    it('deleteNote DELETEs /notes/:id', async () => {
      mockFetch.mockResolvedValueOnce(okResponse(null));

      await client.deleteNote('note-1');

      const call = mockFetch.mock.calls[0];
      expect(call[0] as string).toBe(`${BASE_URL}/notes/note-1?token=test-api-token`);
      expect((call[1] as Record<string, unknown>).method).toBe('DELETE');
    });

    it('getAllNotes uses fetchAllPages to collect all notes', async () => {
      const notes = [
        { ...sampleNote, id: '1', title: 'A' },
        { ...sampleNote, id: '2', title: 'B' },
      ];
      fetchAllPagesMock.mockImplementation(async (callback) => {
        const res = await callback(1);
        return res.items;
      });
      mockFetch.mockResolvedValue(okResponse({ items: notes, has_more: false }));

      const result = await client.getAllNotes();

      expect(fetchAllPagesMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual(notes);
    });
  });

  // =====================================================================
  // Folder CRUD
  // =====================================================================
  describe('Folder CRUD', () => {
    it('listFolders calls GET /folders with pagination', async () => {
      const paginated = { items: [sampleFolder], has_more: false };
      mockFetch.mockResolvedValueOnce(okResponse(paginated));

      const result = await client.listFolders(25, 1);

      expect(result).toEqual(paginated);
      expect(mockFetch.mock.calls[0][0] as string).toContain('/folders?limit=25');
    });

    it('getFolder returns a single folder', async () => {
      mockFetch.mockResolvedValueOnce(okResponse(sampleFolder));

      const folder = await client.getFolder('folder-1');

      expect(folder).toMatchObject({ id: 'folder-1', title: 'Test Folder' });
      expect(mockFetch.mock.calls[0][0] as string).toBe(
        `${BASE_URL}/folders/folder-1?token=test-api-token`,
      );
    });

    it('createFolder POSTs a new folder', async () => {
      const payload = { title: 'New Folder' };
      const created = { ...sampleFolder, title: 'New Folder' };
      mockFetch.mockResolvedValueOnce(okResponse(created));

      const result = await client.createFolder(payload);

      expect(result).toMatchObject({ title: 'New Folder' });
      const call = mockFetch.mock.calls[0];
      expect((call[1] as Record<string, unknown>).method).toBe('POST');
      expect(JSON.parse((call[1] as Record<string, unknown>).body as string)).toEqual(payload);
    });

    it('updateFolder PUTs folder changes', async () => {
      const payload = { title: 'Renamed' };
      mockFetch.mockResolvedValueOnce(okResponse(sampleFolder));

      await client.updateFolder('folder-1', payload);

      const call = mockFetch.mock.calls[0];
      expect(call[0] as string).toBe(`${BASE_URL}/folders/folder-1?token=test-api-token`);
      expect((call[1] as Record<string, unknown>).method).toBe('PUT');
      expect(JSON.parse((call[1] as Record<string, unknown>).body as string)).toEqual(payload);
    });

    it('deleteFolder DELETEs the folder', async () => {
      mockFetch.mockResolvedValueOnce(okResponse(null));

      await client.deleteFolder('folder-1');

      const call = mockFetch.mock.calls[0];
      expect(call[0] as string).toBe(`${BASE_URL}/folders/folder-1?token=test-api-token`);
      expect((call[1] as Record<string, unknown>).method).toBe('DELETE');
    });

    it('getAllFolders uses fetchAllPages', async () => {
      const folders = [sampleFolder];
      fetchAllPagesMock.mockImplementation(async (callback) => {
        const res = await callback(1);
        return res.items;
      });
      mockFetch.mockResolvedValue(okResponse({ items: folders, has_more: false }));

      const result = await client.getAllFolders();

      expect(fetchAllPagesMock).toHaveBeenCalled();
      expect(result).toEqual(folders);
    });
  });

  // =====================================================================
  // Tag Operations
  // =====================================================================
  describe('Tag operations', () => {
    it('listTags calls GET /tags with pagination', async () => {
      const paginated = { items: [sampleTag], has_more: false };
      mockFetch.mockResolvedValueOnce(okResponse(paginated));

      const result = await client.listTags(10, 1);

      expect(result).toEqual(paginated);
      expect(mockFetch.mock.calls[0][0] as string).toContain('/tags?limit=10');
    });

    it('getTag returns a single tag', async () => {
      mockFetch.mockResolvedValueOnce(okResponse(sampleTag));

      const tag = await client.getTag('tag-1');

      expect(tag).toMatchObject({ id: 'tag-1', title: 'Test Tag' });
      expect(mockFetch.mock.calls[0][0] as string).toBe(
        `${BASE_URL}/tags/tag-1?token=test-api-token`,
      );
    });

    it('createTag POSTs a new tag', async () => {
      const payload = { title: 'New Tag' };
      const created = { ...sampleTag, title: 'New Tag' };
      mockFetch.mockResolvedValueOnce(okResponse(created));

      const result = await client.createTag(payload);

      expect(result).toMatchObject({ title: 'New Tag' });
      const call = mockFetch.mock.calls[0];
      expect((call[1] as Record<string, unknown>).method).toBe('POST');
      expect(JSON.parse((call[1] as Record<string, unknown>).body as string)).toEqual(payload);
    });

    it('deleteTag DELETEs the tag', async () => {
      mockFetch.mockResolvedValueOnce(okResponse(null));

      await client.deleteTag('tag-1');

      const call = mockFetch.mock.calls[0];
      expect(call[0] as string).toBe(`${BASE_URL}/tags/tag-1?token=test-api-token`);
      expect((call[1] as Record<string, unknown>).method).toBe('DELETE');
    });

    it('getNoteTags fetches tags for a note', async () => {
      const tags = [sampleTag];
      mockFetch.mockResolvedValueOnce(okResponse(tags));

      const result = await client.getNoteTags('note-1');

      expect(result).toEqual(tags);
      expect(mockFetch.mock.calls[0][0] as string).toBe(
        `${BASE_URL}/notes/note-1/tags?token=test-api-token`,
      );
    });

    it('tagNote POSTs a note‑tag relationship', async () => {
      const noteTag = {
        id: 'rel-1',
        note_id: 'note-1',
        tag_id: 'tag-1',
        created_time: 1,
        updated_time: 2,
        user_created_time: 1,
        user_updated_time: 2,
        encryption_cipher_text: '',
        encryption_applied: 0,
      };
      mockFetch.mockResolvedValueOnce(okResponse(noteTag));

      const result = await client.tagNote('note-1', 'tag-1');

      expect(result).toMatchObject({ note_id: 'note-1', tag_id: 'tag-1' });
      const call = mockFetch.mock.calls[0];
      expect(call[0] as string).toBe(`${BASE_URL}/notes/note-1/tags?token=test-api-token`);
      expect((call[1] as Record<string, unknown>).method).toBe('POST');
      expect(JSON.parse((call[1] as Record<string, unknown>).body as string)).toEqual({
        id: 'tag-1',
      });
    });

    it('untagNote DELETEs a note‑tag relationship', async () => {
      mockFetch.mockResolvedValueOnce(okResponse(null));

      await client.untagNote('note-1', 'tag-1');

      const call = mockFetch.mock.calls[0];
      expect(call[0] as string).toBe(`${BASE_URL}/notes/note-1/tags/tag-1?token=test-api-token`);
      expect((call[1] as Record<string, unknown>).method).toBe('DELETE');
    });

    it('getAllTags uses fetchAllPages', async () => {
      const tags = [sampleTag];
      fetchAllPagesMock.mockImplementation(async (callback) => {
        const res = await callback(1);
        return res.items;
      });
      mockFetch.mockResolvedValue(okResponse({ items: tags, has_more: false }));

      const result = await client.getAllTags();

      expect(fetchAllPagesMock).toHaveBeenCalled();
      expect(result).toEqual(tags);
    });
  });

  // =====================================================================
  // Error Classification
  // =====================================================================
  describe('error classification', () => {
    it('400 response throws ValidationError', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(400, 'Bad Request', 'invalid field'));

      await expect(client.listNotes()).rejects.toThrow(ValidationError);
    });

    it('404 response throws NotFoundError', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

      await expect(client.getNote('x')).rejects.toThrow(NotFoundError);
    });

    it('409 response throws ConflictError', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(409, 'Conflict'));

      await expect(client.updateNote('x', {})).rejects.toThrow(ConflictError);
    });

    it('401 response after retry throws AuthError', async () => {
      // First endpoint call returns 401 → triggers auth → auth succeeds
      // Retry also returns 401 → throws AuthError
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')) // 1st call
        .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN })) // /auth succeeds
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized')); // retry → 401

      await expect(client.getNote('x')).rejects.toThrow(AuthError);
    });

    it('403 response throws AuthError', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(403, 'Forbidden'));

      await expect(client.listNotes()).rejects.toThrow(AuthError);
    });

    it('500 response throws DataApiError', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(500, 'Internal Server Error', 'oh no'));

      // `expect` resolves to the thrown error; capture it to inspect details
      const err = await client.listNotes().catch((e: unknown) => e as DataApiError);
      expect(err).toBeInstanceOf(DataApiError);
      expect((err as DataApiError).statusCode).toBe(500);
      expect((err as DataApiError).responseBody).toBe('oh no');
    });

    it('429 response throws DataApiError (rate limiting — catch-all branch)', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(429, 'Too Many Requests', 'Rate limit exceeded'),
      );

      const err = await client.listNotes().catch((e: unknown) => e as DataApiError);
      expect(err).toBeInstanceOf(DataApiError);
      expect((err as DataApiError).statusCode).toBe(429);
      expect((err as DataApiError).responseBody).toBe('Rate limit exceeded');
    });

    it('502 response throws DataApiError with server error message', async () => {
      mockFetch.mockResolvedValueOnce(errorResponse(502, 'Bad Gateway', 'upstream error'));

      const err = await client.listNotes().catch((e: unknown) => e as DataApiError);
      expect(err).toBeInstanceOf(DataApiError);
      expect((err as DataApiError).statusCode).toBe(502);
      expect((err as DataApiError).message).toContain('Server error');
      expect((err as DataApiError).responseBody).toBe('upstream error');
    });

    it('503 response throws DataApiError with server error message', async () => {
      mockFetch.mockResolvedValueOnce(
        errorResponse(503, 'Service Unavailable', 'down for maintenance'),
      );

      const err = await client.listNotes().catch((e: unknown) => e as DataApiError);
      expect(err).toBeInstanceOf(DataApiError);
      expect((err as DataApiError).statusCode).toBe(503);
      expect((err as DataApiError).message).toContain('Server error');
      expect((err as DataApiError).responseBody).toBe('down for maintenance');
    });

    // =====================================================================
    // Error Message Sanitization (HIGH-006)
    // =====================================================================
    describe('error message sanitization', () => {
      it('404 error message includes resource type and ID for transparency', async () => {
        mockFetch.mockResolvedValueOnce(errorResponse(404, 'Not Found'));

        try {
          await client.getNote('secret-note-123');
          expect.unreachable('should have thrown');
        } catch (e: unknown) {
          const err = e as NotFoundError;
          expect(err).toBeInstanceOf(NotFoundError);
          // Message should contain resource type and the actual ID for error transparency
          expect(err.message).toContain('notes');
          expect(err.message).toContain('secret-note-123');
        }
      });

      it('409 error message includes resource type and ID for transparency', async () => {
        mockFetch.mockResolvedValueOnce(errorResponse(409, 'Conflict'));

        try {
          await client.updateNote('conflicted-id-456', { title: 'X' });
          expect.unreachable('should have thrown');
        } catch (e: unknown) {
          const err = e as ConflictError;
          expect(err).toBeInstanceOf(ConflictError);
          // Message should contain resource type and the actual ID for error transparency
          expect(err.message).toContain('notes');
          expect(err.message).toContain('conflicted-id-456');
        }
      });

      it('400 error message passes API response body for transparency', async () => {
        mockFetch.mockResolvedValueOnce(
          errorResponse(400, 'Bad Request', 'internal: invalid field "password"'),
        );

        try {
          await client.listNotes();
          expect.unreachable('should have thrown');
        } catch (e: unknown) {
          const err = e as ValidationError;
          expect(err).toBeInstanceOf(ValidationError);
          // Message should pass through the API's actual error body verbatim for transparency
          expect(err.message).toBe('internal: invalid field "password"');
        }
      });

      it('logs full request details at DEBUG level for diagnostics', async () => {
        mockFetch.mockResolvedValueOnce(
          errorResponse(400, 'Bad Request', 'sensitive internal error'),
        );

        await client.listNotes().catch(() => {});

        // Should log the diagnostic details at DEBUG level
        expect(mockLogger.debug).toHaveBeenCalledWith(
          expect.objectContaining({
            status: 400,
            path: expect.any(String),
            body: 'sensitive internal error',
          }),
          'Request failed',
        );
      });
    });

    it('network failure (fetch rejects) propagates the raw error', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      await expect(client.listNotes()).rejects.toThrow(TypeError);
    });
  });

  // =====================================================================
  // Request Building
  // =====================================================================
  describe('request building', () => {
    it('includes Authorization header when token is set', async () => {
      // First call: 401 → auth → success (token cached)
      mockFetch
        .mockResolvedValueOnce(errorResponse(401, 'Unauthorized'))
        .mockResolvedValueOnce(okResponse({ auth_token: MOCK_AUTH_TOKEN }))
        .mockResolvedValueOnce(okResponse({ items: [sampleNote], has_more: false }));

      await client.listNotes();

      // The third fetch call (the retry) should carry the auth header
      const thirdCall = mockFetch.mock.calls[2];
      const headers = (thirdCall[1] as Record<string, unknown>).headers as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${MOCK_AUTH_TOKEN}`);
    });

    it('GET / DELETE requests have no body', async () => {
      // GET
      mockFetch.mockResolvedValueOnce(okResponse(sampleNote));
      await client.getNote('n1');
      expect((mockFetch.mock.calls[0][1] as Record<string, unknown>).body).toBeUndefined();

      // DELETE
      mockFetch.mockResolvedValueOnce(okResponse(null));
      await client.deleteNote('n2');
      expect((mockFetch.mock.calls[1][1] as Record<string, unknown>).body).toBeUndefined();
    });

    it('POST / PUT requests carry a JSON body and Content‑Type header', async () => {
      // POST
      mockFetch.mockResolvedValueOnce(okResponse(sampleNote));
      await client.createNote({ title: 'N' });
      let call = mockFetch.mock.calls[0];
      expect((call[1] as Record<string, unknown>).body).toBe(JSON.stringify({ title: 'N' }));
      expect((call[1] as Record<string, unknown>).headers).toMatchObject({
        'Content-Type': 'application/json',
      });

      // PUT
      mockFetch.mockResolvedValueOnce(okResponse(sampleNote));
      await client.updateNote('n1', { title: 'U' });
      call = mockFetch.mock.calls[1];
      expect((call[1] as Record<string, unknown>).body).toBe(JSON.stringify({ title: 'U' }));
    });

    it('passes pagination parameters (limit, page) correctly', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ items: [], has_more: false }));
      await client.listNotes(25, 3);

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('limit=25');
      expect(url).toContain('page=3');
    });

    it('constructs the base URL from the port parameter', async () => {
      mockFetch.mockResolvedValueOnce(okResponse(sampleNote));
      await client.getNote('n1');

      const url = mockFetch.mock.calls[0][0] as string;
      expect(url.startsWith(BASE_URL)).toBe(true);
    });
  });

  // =====================================================================
  // Additional public methods (resources, events, search, ping)
  // =====================================================================
  describe('additional methods', () => {
    it('ping calls GET /ping', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ status: 'ok', version: '3.0' }));

      const result = await client.ping();

      expect(result).toEqual({ status: 'ok', version: '3.0' });
      expect(mockFetch.mock.calls[0][0] as string).toBe(`${BASE_URL}/ping?token=test-api-token`);
    });

    it('listResources returns paginated resources', async () => {
      const resource = {
        id: 'res-1',
        title: 'Doc',
        mime: 'text/plain',
        filename: 'doc.txt',
        created_time: 1,
        updated_time: 2,
        user_created_time: 1,
        user_updated_time: 2,
        file_extension: 'txt',
        encryption_cipher_text: '',
        encryption_applied: 0,
        encryption_blob_encrypted: 0,
        size: 100,
        is_shared: 0,
        share_id: '',
        master_key_id: '',
      };
      const paginated = { items: [resource], has_more: false };
      mockFetch.mockResolvedValueOnce(okResponse(paginated));

      const result = await client.listResources(50);

      expect(result).toEqual(paginated);
      expect(mockFetch.mock.calls[0][0] as string).toContain('/resources?limit=50');
    });

    it('getAllResources uses fetchAllPages', async () => {
      fetchAllPagesMock.mockImplementation(async (callback) => {
        const res = await callback(1);
        return res.items;
      });
      mockFetch.mockResolvedValue(okResponse({ items: [], has_more: false }));

      await client.getAllResources();

      expect(fetchAllPagesMock).toHaveBeenCalled();
    });

    it('getResource returns a single resource', async () => {
      mockFetch.mockResolvedValueOnce(okResponse({ id: 'r1', title: 'R' }));

      const r = await client.getResource('r1');

      expect(r).toMatchObject({ id: 'r1' });
    });

    it('listEvents returns paginated events', async () => {
      const event = {
        id: 'evt-1',
        item_type: 'note',
        item_id: 'n1',
        type: 1,
        created_time: 1,
        source: 0,
        before_change_item: '',
      };
      mockFetch.mockResolvedValueOnce(okResponse({ items: [event], has_more: false }));

      const result = await client.listEvents(20, 1);

      expect(result.items).toHaveLength(1);
      expect(mockFetch.mock.calls[0][0] as string).toContain('/events?limit=20');
    });

    it('search sends query and optional type parameters', async () => {
      mockFetch.mockResolvedValueOnce(okResponse([{ id: 'n1', title: 'result', type: 'note' }]));

      const result = await client.search({ query: 'hello', type: 'note' });

      expect(result).toHaveLength(1);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('/search?');
      expect(url).toContain('query=hello');
      expect(url).toContain('type=note');
    });
  });

  // =====================================================================
  // Edge Cases (LOW-014)
  // =====================================================================
  describe('edge cases', () => {
    // --- Empty / invalid IDs ---
    it('throws ValidationError for empty string note ID', async () => {
      await expect(client.getNote('')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for empty string folder ID', async () => {
      await expect(client.getFolder('')).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for empty string tag ID', async () => {
      await expect(client.getTag('')).rejects.toThrow(ValidationError);
    });

    // --- Unicode / Emoji ---
    it('handles unicode and emoji characters in note title and body', async () => {
      const payload = { title: '📝 Note with emoji', body: 'Hello ☕ world 🌍 🔥 test' };
      const created = { ...sampleNote, title: payload.title, body: payload.body };
      mockFetch.mockResolvedValueOnce(okResponse(created));

      const result = await client.createNote(payload);
      expect(result).toMatchObject({ title: '📝 Note with emoji' });

      const call = mockFetch.mock.calls[0];
      const sentBody = JSON.parse((call[1] as Record<string, unknown>).body as string);
      expect(sentBody.title).toBe('📝 Note with emoji');
      expect(sentBody.body).toBe('Hello ☕ world 🌍 🔥 test');
    });

    it('handles unicode and emoji characters in search queries', async () => {
      mockFetch.mockResolvedValueOnce(okResponse([{ id: 'n1', title: 'café', type: 'note' }]));

      const result = await client.search({ query: 'café ☕ emoji 🎉' });
      expect(result).toHaveLength(1);

      const url = mockFetch.mock.calls[0][0] as string;
      // URLSearchParams percent-encodes non-ASCII characters
      // (spaces become '+' instead of '%20', so verify individual chars)
      expect(url).toContain('caf%C3%A9');
      expect(url).toContain('%E2%98%95');
      expect(url).toContain('%F0%9F%8E%89');
    });

    // --- Large note content ---
    it('handles very large note content (10K+ characters)', async () => {
      const largeBody = 'x'.repeat(10_000);
      const payload = { title: 'Large Note', body: largeBody };
      const created = { ...sampleNote, title: 'Large Note', body: largeBody };
      mockFetch.mockResolvedValueOnce(okResponse(created));

      const result = await client.createNote(payload);
      expect(result).toMatchObject({ title: 'Large Note' });

      const call = mockFetch.mock.calls[0];
      const sentBody = JSON.parse((call[1] as Record<string, unknown>).body as string);
      expect(sentBody.body).toHaveLength(10_000);
    });

    // --- Network timeout simulation ---
    it('handles network timeout (delayed rejection)', async () => {
      mockFetch.mockImplementationOnce(
        () =>
          new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error('network timeout')), 100);
          }),
      );

      await expect(client.listNotes()).rejects.toThrow('network timeout');
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency limiter  (MEDIUM-013 — data-client)
  // ---------------------------------------------------------------------------
  describe('concurrency limiter', () => {
    it('queues requests beyond maxConcurrency (2) and drains when active ones finish', async () => {
      const concurrencyClient = new JoplinDataClient(PORT, 'test-api-token', mockLogger, 2);

      // A deferred promise that keeps in-flight requests pending
      let holdResolve: () => void;
      const holdPromise = new Promise<void>((resolve) => {
        holdResolve = resolve;
      });

      // All fetch calls go through the same gate
      mockFetch.mockImplementation(() => holdPromise.then(() => okResponse({ items: [] })));

      // Fire 4 concurrent requests
      const results = Promise.all([
        concurrencyClient.listNotes(),
        concurrencyClient.listNotes(),
        concurrencyClient.listNotes(),
        concurrencyClient.listNotes(),
      ]);

      // Only 2 should have been initiated (maxConcurrency = 2)
      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      // Release the gate — both active requests finish, draining the queue
      holdResolve!();

      // All 4 eventually complete
      await results;
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('all queued requests resolve successfully after batch completion', async () => {
      const concurrencyClient = new JoplinDataClient(PORT, 'test-api-token', mockLogger, 2);

      // Track resolution order
      const completionOrder: number[] = [];

      // Each call returns distinct data so we can verify identity
      const responses = [
        okResponse({ items: ['a'] }),
        okResponse({ items: ['b'] }),
        okResponse({ items: ['c'] }),
        okResponse({ items: ['d'] }),
      ];

      let holdResolve: () => void;
      const holdPromise = new Promise<void>((resolve) => {
        holdResolve = resolve;
      });

      // First two calls hang; subsequent calls resolve immediately once dequeued
      mockFetch
        .mockImplementationOnce(() =>
          holdPromise.then(() => {
            completionOrder.push(1);
            return responses[0];
          }),
        )
        .mockImplementationOnce(() =>
          holdPromise.then(() => {
            completionOrder.push(2);
            return responses[1];
          }),
        )
        .mockImplementationOnce(() => {
          completionOrder.push(3);
          return Promise.resolve(responses[2]);
        })
        .mockImplementationOnce(() => {
          completionOrder.push(4);
          return Promise.resolve(responses[3]);
        });

      const p1 = concurrencyClient.listNotes();
      const p2 = concurrencyClient.listNotes();
      const p3 = concurrencyClient.listNotes();
      const p4 = concurrencyClient.listNotes();

      // First two are active, last two queued
      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(2);
      });

      // Release the hold
      holdResolve!();

      const [r1, r2, r3, r4] = await Promise.all([p1, p2, p3, p4]);

      // All four resolved
      expect(r1).toMatchObject({ items: ['a'] });
      expect(r2).toMatchObject({ items: ['b'] });
      expect(r3).toMatchObject({ items: ['c'] });
      expect(r4).toMatchObject({ items: ['d'] });

      // The queued ones (3, 4) completed after the held ones (1, 2)
      expect(completionOrder).toEqual([1, 2, 3, 4]);
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('default maxConcurrency (5) allows five concurrent requests', async () => {
      // Use the default client — maxConcurrency defaults to 5
      const defaultClient = new JoplinDataClient(PORT, 'test-api-token', mockLogger);

      let holdResolve: () => void;
      const holdPromise = new Promise<void>((resolve) => {
        holdResolve = resolve;
      });

      mockFetch.mockImplementation(() => holdPromise.then(() => okResponse({ items: [] })));

      // Fire 6 requests — 5 should start, 1 should be queued
      const results = Promise.all(Array.from({ length: 6 }, () => defaultClient.listNotes()));

      // 5 requests should have been initiated (maxConcurrency = 5)
      await vi.waitFor(() => {
        expect(mockFetch).toHaveBeenCalledTimes(5);
      });

      // Release the hold
      holdResolve!();

      await results;
      expect(mockFetch).toHaveBeenCalledTimes(6);
    });
  });
});
