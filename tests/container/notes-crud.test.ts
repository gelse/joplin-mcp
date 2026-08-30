import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { createTestClient, callTool, uid, CleanupTracker } from './helpers.js';

let client: Client;
const cleanup = new CleanupTracker();
let testFolderId: string;

interface NoteResult {
  id: string;
  title: string;
  body?: string;
  parent_id?: string;
}

interface FolderResult {
  id: string;
  title: string;
}

interface ListResult {
  items: NoteResult[];
  has_more: boolean;
}

interface MultinoteResult {
  notes: NoteResult[];
  errors: { note_id: string; error: string }[];
}

beforeAll(async () => {
  client = await createTestClient();
  const folderName = `test-notes-crud-${uid()}`;
  const folder = await callTool<FolderResult>(client, 'create_folder', {
    title: folderName,
  });
  testFolderId = folder.id;
  cleanup.trackFolder(testFolderId);
});

afterAll(async () => {
  await cleanup.cleanup(client);
  await client?.close();
});

describe('Notes CRUD', () => {
  it('create_note — creates a note with title and body', async () => {
    const title = `note-create-${uid()}`;
    const body = `Body content for ${title}`;

    const note = await callTool<NoteResult>(client, 'create_note', {
      title,
      parent_id: testFolderId,
      body,
    });

    cleanup.trackNote(note.id);

    expect(note).toBeDefined();
    expect(note.id).toBeTruthy();
    expect(note.title).toBe(title);
    expect(note.body).toBe(body);
    expect(note.parent_id).toBe(testFolderId);
  });

  it('read_note — reads a created note and verifies fields', async () => {
    const title = `note-read-${uid()}`;
    const body = `Read test body for ${title}`;

    const created = await callTool<NoteResult>(client, 'create_note', {
      title,
      parent_id: testFolderId,
      body,
    });
    cleanup.trackNote(created.id);

    const note = await callTool<NoteResult>(client, 'read_note', {
      note_id: created.id,
    });

    expect(note.id).toBe(created.id);
    expect(note.title).toBe(title);
    expect(note.body).toBe(body);
    expect(note.parent_id).toBe(testFolderId);
  });

  it('list_notes — lists notes and finds the created one', async () => {
    const title = `note-list-${uid()}`;
    const body = `List test body`;

    const created = await callTool<NoteResult>(client, 'create_note', {
      title,
      parent_id: testFolderId,
      body,
    });
    cleanup.trackNote(created.id);

    const result = await callTool<ListResult>(client, 'list_notes', {
      limit: 50,
    });

    expect(result.items).toBeInstanceOf(Array);
    const found = result.items.find((n) => n.id === created.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe(title);
  });

  it('edit_note — edits title and body, verifies changes', async () => {
    const title = `note-edit-${uid()}`;
    const body = `Original body`;

    const created = await callTool<NoteResult>(client, 'create_note', {
      title,
      parent_id: testFolderId,
      body,
    });
    cleanup.trackNote(created.id);

    const newTitle = `note-edit-updated-${uid()}`;
    const newBody = `Updated body content`;

    await callTool<NoteResult>(client, 'edit_note', {
      note_id: created.id,
      title: newTitle,
      body: newBody,
    });

    const note = await callTool<NoteResult>(client, 'read_note', {
      note_id: created.id,
    });

    expect(note.title).toBe(newTitle);
    expect(note.body).toBe(newBody);
  });

  it('read_multinote — reads multiple notes by ID', async () => {
    const title1 = `note-multi-a-${uid()}`;
    const title2 = `note-multi-b-${uid()}`;

    const noteA = await callTool<NoteResult>(client, 'create_note', {
      title: title1,
      parent_id: testFolderId,
      body: 'Body A',
    });
    cleanup.trackNote(noteA.id);

    const noteB = await callTool<NoteResult>(client, 'create_note', {
      title: title2,
      parent_id: testFolderId,
      body: 'Body B',
    });
    cleanup.trackNote(noteB.id);

    const result = await callTool<MultinoteResult>(client, 'read_multinote', {
      note_ids: [noteA.id, noteB.id],
    });

    expect(result.notes).toHaveLength(2);
    expect(result.errors).toHaveLength(0);

    const ids = result.notes.map((n) => n.id);
    expect(ids).toContain(noteA.id);
    expect(ids).toContain(noteB.id);

    const readA = result.notes.find((n) => n.id === noteA.id)!;
    expect(readA.title).toBe(title1);
    expect(readA.body).toBe('Body A');

    const readB = result.notes.find((n) => n.id === noteB.id)!;
    expect(readB.title).toBe(title2);
    expect(readB.body).toBe('Body B');
  });

  it('delete_note — deletes a note, subsequent read returns error', async () => {
    const title = `note-delete-${uid()}`;

    const created = await callTool<NoteResult>(client, 'create_note', {
      title,
      parent_id: testFolderId,
      body: 'To be deleted',
    });

    await callTool<{ success: boolean }>(client, 'delete_note', {
      note_id: created.id,
    });

    await expect(callTool(client, 'read_note', { note_id: created.id })).rejects.toThrow();
  });
});
