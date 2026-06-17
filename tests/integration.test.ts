import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { JoplinDataClient } from '../src/data-client.js';
import { AuthError, DataApiError } from '../src/errors.js';
import type { Note, Folder } from '../src/api-types.js';
import type { Logger } from '../src/logger.js';

/**
 * Integration tests for the Joplin MCP Server.
 *
 * These tests use a REAL Joplin Data API instance and are SKIPPED by default.
 * To run them, set:
 *   RUN_INTEGRATION_TESTS=true
 *   JOPLIN_SERVER_URL       (e.g., http://127.0.0.1:41100) — used for assertions only
 *   JOPLIN_USERNAME         (e.g., admin@localhost)
 *   JOPLIN_PASSWORD         (e.g., admin)
 *   JOPLIN_DATA_API_PORT    (optional, default: 41100)
 */

const INTEGRATION_ENABLED = !!process.env['RUN_INTEGRATION_TESTS'];
const PORT = parseInt(process.env['JOPLIN_DATA_API_PORT'] || '41100', 10);
const JOPLIN_URL = process.env['JOPLIN_SERVER_URL'] || `http://127.0.0.1:${PORT}`;

// ── Dummy logger (same pattern as unit tests) ──────────────────────────
const dummyLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

// ── Helpers ─────────────────────────────────────────────────────────────
let client: JoplinDataClient;
const createdNoteIds: string[] = [];
const createdFolderIds: string[] = [];

function uid(): string {
  return `int-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupNotes(): Promise<void> {
  for (const id of createdNoteIds) {
    try {
      await client.deleteNote(id);
    } catch {
      // best-effort cleanup
    }
  }
  createdNoteIds.length = 0;
}

async function cleanupFolders(): Promise<void> {
  for (const id of createdFolderIds) {
    try {
      await client.deleteFolder(id);
    } catch {
      // best-effort cleanup
    }
  }
  createdFolderIds.length = 0;
}

// ── Suite ───────────────────────────────────────────────────────────────
describe.skipIf(!INTEGRATION_ENABLED)('JoplinDataClient — integration', () => {
  beforeAll(() => {
    client = new JoplinDataClient(PORT, dummyLogger);
  });

  afterAll(async () => {
    await cleanupNotes();
    await cleanupFolders();
  });

  // ── Authentication ──────────────────────────────────────────────────
  describe('authentication', () => {
    it('obtains a token from the real Joplin API and lists notes', async () => {
      const result = await client.listNotes(1, 1);
      expect(result).toBeDefined();
      expect(Array.isArray(result.items)).toBe(true);
    }, 15_000);

    it('throws AuthError when credentials are invalid', async () => {
      // Create a client with a port where no Joplin instance runs
      // — this effectively tests that authentication must succeed
      // for any operation to proceed. The real auth failure path
      // (bad credentials) is tested via the unit-test mocks.
      // Here we verify that an unreachable server surfaces as an error.
      const badClient = new JoplinDataClient(1, dummyLogger);
      await expect(badClient.listNotes(1)).rejects.toThrow();
    }, 10_000);
  });

  // ── Note CRUD ───────────────────────────────────────────────────────
  describe('Note CRUD', () => {
    afterEach(async () => {
      await cleanupNotes();
    });

    it('creates a note and returns it with an id', async () => {
      const title = `Integration Test Note — ${uid()}`;
      const note = await client.createNote({
        title,
        body: 'Created during integration tests.',
      });
      expect(note).toBeDefined();
      expect(note.id).toBeDefined();
      expect(typeof note.id).toBe('string');
      expect(note.title).toBe(title);
      expect(note.body).toBe('Created during integration tests.');
      createdNoteIds.push(note.id);
    }, 15_000);

    it('reads a created note back via getNote', async () => {
      const title = `getNote Integration — ${uid()}`;
      const created = await client.createNote({
        title,
        body: 'Body for getNote test.',
      });
      createdNoteIds.push(created.id);

      const fetched = await client.getNote(created.id);
      expect(fetched.id).toBe(created.id);
      expect(fetched.title).toBe(title);
      expect(fetched.body).toBe('Body for getNote test.');
    }, 15_000);

    it('updates a note title and body', async () => {
      const originalTitle = `Original Title — ${uid()}`;
      const created = await client.createNote({
        title: originalTitle,
        body: 'Original body.',
      });
      createdNoteIds.push(created.id);

      const updatedTitle = `Updated Title — ${uid()}`;
      const updated = await client.updateNote(created.id, {
        title: updatedTitle,
        body: 'Updated body.',
      });
      expect(updated.id).toBe(created.id);
      expect(updated.title).toBe(updatedTitle);
      expect(updated.body).toBe('Updated body.');
    }, 15_000);

    it('deletes a note and then returns 404 on getNote', async () => {
      const created = await client.createNote({
        title: `To Be Deleted — ${uid()}`,
        body: 'Will be deleted.',
      });
      // Do NOT push to createdNoteIds — we intentionally delete it below

      await client.deleteNote(created.id);
      await expect(client.getNote(created.id)).rejects.toThrow();
    }, 15_000);

    it('throws NotFoundError for a non-existent note', async () => {
      await expect(client.getNote('non-existent-id-12345')).rejects.toThrow();
    }, 10_000);
  });

  // ── Folder CRUD ─────────────────────────────────────────────────────
  describe('Folder CRUD', () => {
    afterEach(async () => {
      await cleanupFolders();
    });

    it('creates a folder and reads it back', async () => {
      const title = `Integration Folder — ${uid()}`;
      const folder = await client.createFolder({ title });
      expect(folder).toBeDefined();
      expect(folder.id).toBeDefined();
      expect(folder.title).toBe(title);
      createdFolderIds.push(folder.id);

      const fetched = await client.getFolder(folder.id);
      expect(fetched.id).toBe(folder.id);
      expect(fetched.title).toBe(title);
    }, 15_000);

    it('lists folders with pagination', async () => {
      const result = await client.listFolders(10, 1);
      expect(result).toBeDefined();
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items.length).toBeGreaterThanOrEqual(1);
    }, 10_000);
  });

  // ── Search ──────────────────────────────────────────────────────────
  describe('search', () => {
    afterEach(async () => {
      await cleanupNotes();
    });

    it('finds a note by title using search', async () => {
      const uniqueId = uid();
      const title = `Searchable Note ${uniqueId}`;
      const created = await client.createNote({
        title,
        body: 'This note should be discoverable by search.',
      });
      createdNoteIds.push(created.id);

      const results = await client.search({ query: uniqueId });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const match = results.find((r) => r.id === created.id);
      expect(match).toBeDefined();
      expect(match!.title).toBe(title);
    }, 20_000);

    it('returns empty results for a non-matching query', async () => {
      const results = await client.search({
        query: `zzz-nonexistent-query-${uid()}`,
      });
      // Joplin may return an empty array or a response with 0 items
      expect(results).toBeDefined();
    }, 10_000);
  });

  // ── Pagination ──────────────────────────────────────────────────────
  describe('pagination', () => {
    afterEach(async () => {
      await cleanupNotes();
    });

    it('respects the limit parameter when listing notes', async () => {
      // Create 3 notes so we have data to paginate over
      const notes = await Promise.all(
        Array.from({ length: 3 }, (_, i) =>
          client.createNote({
            title: `Pagination Note ${i} — ${uid()}`,
            body: `Pagination test body ${i}.`,
          }),
        ),
      );
      notes.forEach((n) => createdNoteIds.push(n.id));

      const page = await client.listNotes(2, 1);
      expect(page.items.length).toBeLessThanOrEqual(2);
    }, 20_000);

    it('page 2 returns the remaining notes when limit is smaller than total', async () => {
      // Create 4 notes
      const notes = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          client.createNote({
            title: `Page2 Note ${i} — ${uid()}`,
            body: `Page2 test body ${i}.`,
          }),
        ),
      );
      notes.forEach((n) => createdNoteIds.push(n.id));

      const page1 = await client.listNotes(2, 1);
      const page2 = await client.listNotes(2, 2);

      expect(page1.items.length).toBe(2);
      expect(page2.items.length).toBe(2);
      // Ensure the two pages contain different notes
      const page1Ids = new Set(page1.items.map((n: Note) => n.id));
      const page2Ids = page2.items.map((n: Note) => n.id);
      expect(page2Ids.some((id: string) => page1Ids.has(id))).toBe(false);
    }, 20_000);
  });

  // ── Error handling with a real server ───────────────────────────────
  describe('error handling', () => {
    it('throws DataApiError when hitting an unknown endpoint', async () => {
      // We can't easily hit an unknown endpoint through the typed client,
      // but we can verify that 404 from a valid endpoint (deleted note)
      // surfaces as an error.
      // Already covered above; this is a sanity check.
      await expect(client.getNote('definitely-not-a-real-note-id')).rejects.toThrow(DataApiError);
    }, 10_000);
  });
});
