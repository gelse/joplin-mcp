import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JoplinDataClient } from '../../src/data-client.js';
import type { SyncManager } from '../../src/sync-manager.js';
import { NotFoundError } from '../../src/errors.js';
import type { Note, Folder, Tag } from '../../src/api-types.js';
import {
  listNotebooks,
  searchNotes,
  readNote,
  readNotebook,
  readMultinote,
  readTags,
  createNote,
  createFolder,
  editNote,
  editFolder,
  createTag,
  tagNote,
  untagNote,
  deleteNote,
  deleteFolder,
  sync,
  type ToolContext,
  type ReadMultinoteResult,
} from '../../src/mcp/tools.js';

// =============================================================================
// Mock setup
// =============================================================================

const createMockClient = () =>
  ({
    getAllFolders: vi.fn(),
    search: vi.fn(),
    getNote: vi.fn(),
    getFolder: vi.fn(),
    getNoteTags: vi.fn(),
    createNote: vi.fn(),
    createFolder: vi.fn(),
    updateNote: vi.fn(),
    updateFolder: vi.fn(),
    createTag: vi.fn(),
    tagNote: vi.fn(),
    untagNote: vi.fn(),
    deleteNote: vi.fn(),
    deleteFolder: vi.fn(),
  }) as unknown as JoplinDataClient;

const createMockSyncManager = () =>
  ({
    triggerSync: vi.fn(),
    getSyncStatus: vi.fn(),
    getLastSyncTime: vi.fn(),
  }) as unknown as SyncManager;

const createMockLogger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});

// Sample data
const sampleNote: Note = {
  id: 'note1',
  parent_id: 'folder1',
  title: 'Test Note',
  body: 'Content',
  created_time: 1000,
  updated_time: 2000,
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
  user_created_time: 1000,
  user_updated_time: 2000,
  encryption_cipher_text: '',
  encryption_applied: 0,
  markup_language: 1,
  is_shared: 0,
  share_id: '',
  conflict_original_id: '',
  master_key_id: '',
  type_: 1,
};

const sampleFolder: Folder = {
  id: 'folder1',
  parent_id: '',
  title: 'My Notebook',
  created_time: 1000,
  updated_time: 2000,
  user_created_time: 1000,
  user_updated_time: 2000,
  encryption_cipher_text: '',
  encryption_applied: 0,
  is_shared: 0,
  share_id: '',
  master_key_id: '',
  icon: '',
};

const sampleTag: Tag = {
  id: 'tag1',
  title: 'important',
  created_time: 1000,
  updated_time: 2000,
  user_created_time: 1000,
  user_updated_time: 2000,
  encryption_cipher_text: '',
  encryption_applied: 0,
  is_shared: 0,
  parent_id: '',
};

interface ToolTestContext {
  client: ReturnType<typeof createMockClient>;
  syncManager: ReturnType<typeof createMockSyncManager>;
  logger: ReturnType<typeof createMockLogger>;
}

function createContext(): ToolTestContext & ToolContext {
  return {
    client: createMockClient(),
    syncManager: createMockSyncManager(),
    logger: createMockLogger(),
  } as ToolTestContext & ToolContext;
}

// =============================================================================
// Read Tools — these should NOT trigger sync
// =============================================================================

describe('listNotebooks', () => {
  it('delegates to client.getAllFolders', async () => {
    const context = createContext();
    context.client.getAllFolders.mockResolvedValue([sampleFolder]);

    const result = await listNotebooks({}, context);

    expect(context.client.getAllFolders).toHaveBeenCalledOnce();
    expect(result).toEqual([sampleFolder]);
  });

  it('does NOT trigger sync', async () => {
    const context = createContext();
    context.client.getAllFolders.mockResolvedValue([]);

    await listNotebooks({}, context);

    expect(context.syncManager.triggerSync).not.toHaveBeenCalled();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    const error = new Error('API error');
    context.client.getAllFolders.mockRejectedValue(error);

    await expect(listNotebooks({}, context)).rejects.toThrow('API error');
  });
});

describe('searchNotes', () => {
  it('delegates to client.search with query and type', async () => {
    const context = createContext();
    const searchResult = {
      id: 'n1',
      title: 'Found',
      type: 'note',
      parent_id: '',
      is_todo: 0,
      todo_completed: 0,
      updated_time: 2000,
      created_time: 1000,
    };
    context.client.search.mockResolvedValue([searchResult]);

    const result = await searchNotes({ query: 'hello', type: 'note' }, context);

    expect(context.client.search).toHaveBeenCalledWith({
      query: 'hello',
      type: 'note',
    });
    expect(result).toEqual([searchResult]);
  });

  it('delegates to client.search without type', async () => {
    const context = createContext();
    context.client.search.mockResolvedValue([]);

    await searchNotes({ query: 'hello' }, context);

    expect(context.client.search).toHaveBeenCalledWith({
      query: 'hello',
      type: undefined,
    });
  });

  it('does NOT trigger sync', async () => {
    const context = createContext();
    context.client.search.mockResolvedValue([]);

    await searchNotes({ query: 'test', type: 'folder' }, context);

    expect(context.syncManager.triggerSync).not.toHaveBeenCalled();
  });

  it('rejects empty string query', async () => {
    const context = createContext();

    await expect(searchNotes({ query: '' }, context)).rejects.toThrow(
      'query must be a non-empty string',
    );
  });

  it('rejects whitespace-only query', async () => {
    const context = createContext();

    await expect(searchNotes({ query: '   ' }, context)).rejects.toThrow(
      'query must be a non-empty string',
    );
  });

  it('does not call client.search for empty query', async () => {
    const context = createContext();

    try {
      await searchNotes({ query: '' }, context);
    } catch {
      // expected
    }

    expect(context.client.search).not.toHaveBeenCalled();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.search.mockRejectedValue(new Error('Search failed'));

    await expect(searchNotes({ query: 'x' }, context)).rejects.toThrow('Search failed');
  });
});

describe('readNote', () => {
  it('delegates to client.getNote with note_id', async () => {
    const context = createContext();
    context.client.getNote.mockResolvedValue(sampleNote);

    const result = await readNote({ note_id: 'note1' }, context);

    expect(context.client.getNote).toHaveBeenCalledWith('note1', expect.any(Array));
    expect(result).toEqual(sampleNote);
  });

  it('does NOT trigger sync', async () => {
    const context = createContext();
    context.client.getNote.mockResolvedValue(sampleNote);

    await readNote({ note_id: 'n1' }, context);

    expect(context.syncManager.triggerSync).not.toHaveBeenCalled();
  });

  it('propagates NotFoundError from client', async () => {
    const context = createContext();
    context.client.getNote.mockRejectedValue(new NotFoundError('note', 'bad-id'));

    await expect(readNote({ note_id: 'bad-id' }, context)).rejects.toThrow(NotFoundError);
  });
});

describe('readNotebook', () => {
  it('delegates to client.getFolder with notebook_id', async () => {
    const context = createContext();
    context.client.getFolder.mockResolvedValue(sampleFolder);

    const result = await readNotebook({ notebook_id: 'folder1' }, context);

    expect(context.client.getFolder).toHaveBeenCalledWith('folder1');
    expect(result).toEqual(sampleFolder);
  });

  it('does NOT trigger sync', async () => {
    const context = createContext();
    context.client.getFolder.mockResolvedValue(sampleFolder);

    await readNotebook({ notebook_id: 'f1' }, context);

    expect(context.syncManager.triggerSync).not.toHaveBeenCalled();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.getFolder.mockRejectedValue(new Error('Not found'));

    await expect(readNotebook({ notebook_id: 'bad' }, context)).rejects.toThrow('Not found');
  });
});

describe('readMultinote', () => {
  it('delegates to client.getNote for each ID', async () => {
    const context = createContext();
    const noteA = { ...sampleNote, id: 'a', title: 'A' };
    const noteB = { ...sampleNote, id: 'b', title: 'B' };
    context.client.getNote.mockResolvedValueOnce(noteA).mockResolvedValueOnce(noteB);

    const result: ReadMultinoteResult = await readMultinote({ note_ids: ['a', 'b'] }, context);

    expect(context.client.getNote).toHaveBeenCalledTimes(2);
    expect(context.client.getNote).toHaveBeenCalledWith('a', expect.any(Array));
    expect(context.client.getNote).toHaveBeenCalledWith('b', expect.any(Array));
    expect(result).toEqual({ notes: [noteA, noteB], errors: [] });
  });

  it('handles empty array gracefully', async () => {
    const context = createContext();

    const result: ReadMultinoteResult = await readMultinote({ note_ids: [] }, context);

    expect(context.client.getNote).not.toHaveBeenCalled();
    expect(result).toEqual({ notes: [], errors: [] });
  });

  it('does NOT trigger sync', async () => {
    const context = createContext();
    context.client.getNote.mockResolvedValue(sampleNote);

    await readMultinote({ note_ids: ['a'] }, context);

    expect(context.syncManager.triggerSync).not.toHaveBeenCalled();
  });

  it('returns all results when all notes succeed', async () => {
    const context = createContext();
    const noteA = { ...sampleNote, id: 'a', title: 'A' };
    const noteB = { ...sampleNote, id: 'b', title: 'B' };
    context.client.getNote.mockResolvedValueOnce(noteA).mockResolvedValueOnce(noteB);

    const result: ReadMultinoteResult = await readMultinote({ note_ids: ['a', 'b'] }, context);

    expect(result.notes).toHaveLength(2);
    expect(result.notes).toEqual([noteA, noteB]);
    expect(result.errors).toHaveLength(0);
  });

  it('returns partial results when some notes fail', async () => {
    const context = createContext();
    const noteA = { ...sampleNote, id: 'a', title: 'A' };
    context.client.getNote
      .mockResolvedValueOnce(noteA)
      .mockRejectedValueOnce(new Error('Not found'))
      .mockResolvedValueOnce({ ...sampleNote, id: 'c', title: 'C' });

    const result: ReadMultinoteResult = await readMultinote({ note_ids: ['a', 'b', 'c'] }, context);

    expect(result.notes).toHaveLength(2);
    expect(result.notes).toEqual([
      { ...sampleNote, id: 'a', title: 'A' },
      { ...sampleNote, id: 'c', title: 'C' },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual({
      note_id: 'b',
      error: 'Not found',
    });
  });

  it('returns no results when all notes fail', async () => {
    const context = createContext();
    context.client.getNote
      .mockRejectedValueOnce(new Error('Fetch failed'))
      .mockRejectedValueOnce(new Error('Not found'));

    const result: ReadMultinoteResult = await readMultinote({ note_ids: ['a', 'b'] }, context);

    expect(result.notes).toHaveLength(0);
    expect(result.errors).toHaveLength(2);
    expect(result.errors).toEqual([
      { note_id: 'a', error: 'Fetch failed' },
      { note_id: 'b', error: 'Not found' },
    ]);
  });
});

describe('readTags', () => {
  it('delegates to client.getNoteTags with note_id', async () => {
    const context = createContext();
    context.client.getNoteTags.mockResolvedValue([sampleTag]);

    const result = await readTags({ note_id: 'note1' }, context);

    expect(context.client.getNoteTags).toHaveBeenCalledWith('note1');
    expect(result).toEqual([sampleTag]);
  });

  it('does NOT trigger sync', async () => {
    const context = createContext();
    context.client.getNoteTags.mockResolvedValue([]);

    await readTags({ note_id: 'n1' }, context);

    expect(context.syncManager.triggerSync).not.toHaveBeenCalled();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.getNoteTags.mockRejectedValue(new Error('Bad note'));

    await expect(readTags({ note_id: 'bad' }, context)).rejects.toThrow('Bad note');
  });
});

// =============================================================================
// Write Tools — these MUST trigger sync
// =============================================================================

describe('createNote', () => {
  it('delegates to client.createNote with full payload', async () => {
    const context = createContext();
    context.client.createNote.mockResolvedValue(sampleNote);

    const input = {
      title: 'New Note',
      parent_id: 'folder1',
      body: '# Hello',
      author: 'me',
      source_url: 'https://example.com',
      is_todo: true,
      todo_due: 1700000000000,
    };
    const result = await createNote(input, context);

    expect(context.client.createNote).toHaveBeenCalledWith({
      title: 'New Note',
      parent_id: 'folder1',
      body: '# Hello',
      author: 'me',
      source_url: 'https://example.com',
      is_todo: 1,
      todo_due: 1700000000000,
    });
    expect(result).toEqual(sampleNote);
  });

  it('converts is_todo boolean true to number 1', async () => {
    const context = createContext();
    context.client.createNote.mockResolvedValue(sampleNote);

    await createNote({ title: 'Todo', parent_id: 'folder1', is_todo: true }, context);

    expect(context.client.createNote).toHaveBeenCalledWith(expect.objectContaining({ is_todo: 1 }));
  });

  it('converts is_todo boolean false to number 0', async () => {
    const context = createContext();
    context.client.createNote.mockResolvedValue(sampleNote);

    await createNote({ title: 'Not Todo', parent_id: 'folder1', is_todo: false }, context);

    expect(context.client.createNote).toHaveBeenCalledWith(expect.objectContaining({ is_todo: 0 }));
  });

  it('passes is_todo number through directly', async () => {
    const context = createContext();
    context.client.createNote.mockResolvedValue(sampleNote);

    await createNote({ title: 'Num Todo', parent_id: 'folder1', is_todo: 1 }, context);

    expect(context.client.createNote).toHaveBeenCalledWith(expect.objectContaining({ is_todo: 1 }));
  });

  it('triggers sync after creation', async () => {
    const context = createContext();
    context.client.createNote.mockResolvedValue(sampleNote);

    await createNote({ title: 'Sync Test', parent_id: 'folder1' }, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('create_note');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.createNote.mockRejectedValue(new Error('Creation failed'));

    await expect(createNote({ title: 'Fail', parent_id: 'folder1' }, context)).rejects.toThrow(
      'Creation failed',
    );
  });
});

describe('createFolder', () => {
  it('delegates to client.createFolder with full payload', async () => {
    const context = createContext();
    context.client.createFolder.mockResolvedValue(sampleFolder);

    const result = await createFolder(
      { title: 'New Folder', parent_id: 'parent1', icon: '📁' },
      context,
    );

    expect(context.client.createFolder).toHaveBeenCalledWith({
      title: 'New Folder',
      parent_id: 'parent1',
      icon: '📁',
    });
    expect(result).toEqual(sampleFolder);
  });

  it('triggers sync after creation', async () => {
    const context = createContext();
    context.client.createFolder.mockResolvedValue(sampleFolder);

    await createFolder({ title: 'Folder' }, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('create_folder');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.createFolder.mockRejectedValue(new Error('Create failed'));

    await expect(createFolder({ title: 'Fail' }, context)).rejects.toThrow('Create failed');
  });
});

describe('editNote', () => {
  it('delegates to client.updateNote with note_id and partial payload', async () => {
    const context = createContext();
    context.client.updateNote.mockResolvedValue(sampleNote);

    const result = await editNote(
      { note_id: 'note1', title: 'Updated Title', body: 'New body' },
      context,
    );

    expect(context.client.updateNote).toHaveBeenCalledWith('note1', {
      title: 'Updated Title',
      body: 'New body',
    });
    expect(result).toEqual(sampleNote);
  });

  it('supports partial update with only title', async () => {
    const context = createContext();
    context.client.updateNote.mockResolvedValue(sampleNote);

    await editNote({ note_id: 'note1', title: 'Just Title' }, context);

    expect(context.client.updateNote).toHaveBeenCalledWith('note1', {
      title: 'Just Title',
    });
  });

  it('converts is_todo boolean to number', async () => {
    const context = createContext();
    context.client.updateNote.mockResolvedValue(sampleNote);

    await editNote({ note_id: 'n1', is_todo: false }, context);

    expect(context.client.updateNote).toHaveBeenCalledWith('n1', {
      is_todo: 0,
    });
  });

  it('passes is_todo number through directly in edit', async () => {
    const context = createContext();
    context.client.updateNote.mockResolvedValue(sampleNote);

    await editNote({ note_id: 'n1', is_todo: 1 }, context);

    expect(context.client.updateNote).toHaveBeenCalledWith('n1', {
      is_todo: 1,
    });
  });

  it('strips note_id from the payload passed to updateNote', async () => {
    const context = createContext();
    context.client.updateNote.mockResolvedValue(sampleNote);

    await editNote({ note_id: 'n1', title: 'Test', parent_id: 'f1' }, context);

    // note_id should be the first arg, not in the payload
    expect(context.client.updateNote).toHaveBeenCalledWith('n1', {
      title: 'Test',
      parent_id: 'f1',
    });
  });

  it('triggers sync after update', async () => {
    const context = createContext();
    context.client.updateNote.mockResolvedValue(sampleNote);

    await editNote({ note_id: 'n1', title: 'Updated' }, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('edit_note');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.updateNote.mockRejectedValue(new Error('Update failed'));

    await expect(editNote({ note_id: 'n1', title: 'Fail' }, context)).rejects.toThrow(
      'Update failed',
    );
  });
});

describe('editFolder', () => {
  it('delegates to client.updateFolder with folder_id and partial payload', async () => {
    const context = createContext();
    context.client.updateFolder.mockResolvedValue(sampleFolder);

    const result = await editFolder(
      { folder_id: 'folder1', title: 'Renamed', icon: '🎉' },
      context,
    );

    expect(context.client.updateFolder).toHaveBeenCalledWith('folder1', {
      title: 'Renamed',
      icon: '🎉',
    });
    expect(result).toEqual(sampleFolder);
  });

  it('supports partial update with only title', async () => {
    const context = createContext();
    context.client.updateFolder.mockResolvedValue(sampleFolder);

    await editFolder({ folder_id: 'f1', title: 'Just Title' }, context);

    expect(context.client.updateFolder).toHaveBeenCalledWith('f1', {
      title: 'Just Title',
    });
  });

  it('strips folder_id from the payload passed to updateFolder', async () => {
    const context = createContext();
    context.client.updateFolder.mockResolvedValue(sampleFolder);

    await editFolder({ folder_id: 'f1', title: 'T', parent_id: 'p1' }, context);

    expect(context.client.updateFolder).toHaveBeenCalledWith('f1', {
      title: 'T',
      parent_id: 'p1',
    });
  });

  it('triggers sync after update', async () => {
    const context = createContext();
    context.client.updateFolder.mockResolvedValue(sampleFolder);

    await editFolder({ folder_id: 'f1', title: 'Renamed' }, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('edit_folder');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.updateFolder.mockRejectedValue(new Error('Update failed'));

    await expect(editFolder({ folder_id: 'f1', title: 'Fail' }, context)).rejects.toThrow(
      'Update failed',
    );
  });
});

describe('createTag', () => {
  it('delegates to client.createTag with title', async () => {
    const context = createContext();
    context.client.createTag.mockResolvedValue(sampleTag);

    const result = await createTag({ title: 'important' }, context);

    expect(context.client.createTag).toHaveBeenCalledWith({
      title: 'important',
    });
    expect(result).toEqual(sampleTag);
  });

  it('triggers sync after creation', async () => {
    const context = createContext();
    context.client.createTag.mockResolvedValue(sampleTag);

    await createTag({ title: 'tag' }, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('create_tag');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.createTag.mockRejectedValue(new Error('Tag failed'));

    await expect(createTag({ title: 'Fail' }, context)).rejects.toThrow('Tag failed');
  });
});

describe('tagNote', () => {
  it('delegates to client.tagNote with note_id and tag_id', async () => {
    const context = createContext();
    const noteTagResult = {
      id: 'rel1',
      note_id: 'note1',
      tag_id: 'tag1',
      created_time: 1000,
      updated_time: 1000,
      user_created_time: 1000,
      user_updated_time: 1000,
      encryption_cipher_text: '',
      encryption_applied: 0,
    };
    context.client.tagNote.mockResolvedValue(noteTagResult);

    const result = await tagNote({ note_id: 'note1', tag_id: 'tag1' }, context);

    expect(context.client.tagNote).toHaveBeenCalledWith('note1', 'tag1');
    expect(result).toEqual(noteTagResult);
  });

  it('triggers sync after tagging', async () => {
    const context = createContext();
    context.client.tagNote.mockResolvedValue({
      id: 'r1',
      note_id: 'n1',
      tag_id: 't1',
    });

    await tagNote({ note_id: 'n1', tag_id: 't1' }, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('tag_note');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.tagNote.mockRejectedValue(new Error('Tag failed'));

    await expect(tagNote({ note_id: 'n1', tag_id: 't1' }, context)).rejects.toThrow('Tag failed');
  });
});

describe('untagNote', () => {
  it('delegates to client.untagNote with note_id and tag_id', async () => {
    const context = createContext();
    context.client.untagNote.mockResolvedValue(undefined);

    const result = await untagNote({ note_id: 'note1', tag_id: 'tag1' }, context);

    expect(context.client.untagNote).toHaveBeenCalledWith('note1', 'tag1');
    expect(result).toEqual({ success: true });
  });

  it('triggers sync after untagging', async () => {
    const context = createContext();
    context.client.untagNote.mockResolvedValue(undefined);

    await untagNote({ note_id: 'n1', tag_id: 't1' }, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('untag_note');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.untagNote.mockRejectedValue(new Error('Untag failed'));

    await expect(untagNote({ note_id: 'n1', tag_id: 't1' }, context)).rejects.toThrow(
      'Untag failed',
    );
  });
});

// =============================================================================
// Delete Tools
// =============================================================================

describe('deleteNote', () => {
  it('delegates to client.deleteNote with note_id', async () => {
    const context = createContext();
    context.client.deleteNote.mockResolvedValue(undefined);

    const result = await deleteNote({ note_id: 'note1' }, context);

    expect(context.client.deleteNote).toHaveBeenCalledWith('note1');
    expect(result).toEqual({ success: true });
  });

  it('triggers sync after deletion', async () => {
    const context = createContext();
    context.client.deleteNote.mockResolvedValue(undefined);

    await deleteNote({ note_id: 'n1' }, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('delete_note');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.deleteNote.mockRejectedValue(new Error('Delete failed'));

    await expect(deleteNote({ note_id: 'n1' }, context)).rejects.toThrow('Delete failed');
  });
});

describe('deleteFolder', () => {
  it('delegates to client.deleteFolder with folder_id', async () => {
    const context = createContext();
    context.client.deleteFolder.mockResolvedValue(undefined);

    const result = await deleteFolder({ folder_id: 'folder1' }, context);

    expect(context.client.deleteFolder).toHaveBeenCalledWith('folder1');
    expect(result).toEqual({ success: true });
  });

  it('triggers sync after deletion', async () => {
    const context = createContext();
    context.client.deleteFolder.mockResolvedValue(undefined);

    await deleteFolder({ folder_id: 'f1' }, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('delete_folder');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
  });

  it('propagates client errors', async () => {
    const context = createContext();
    context.client.deleteFolder.mockRejectedValue(new Error('Delete failed'));

    await expect(deleteFolder({ folder_id: 'f1' }, context)).rejects.toThrow('Delete failed');
  });
});

// =============================================================================
// Sync Tool
// =============================================================================

describe('sync', () => {
  it("triggers sync with 'manual' source", async () => {
    const context = createContext();
    context.syncManager.triggerSync.mockResolvedValue(undefined);
    context.syncManager.getSyncStatus.mockReturnValue('idle');
    context.syncManager.getLastSyncTime.mockReturnValue(new Date(1000));

    const result = await sync({}, context);

    expect(context.syncManager.triggerSync).toHaveBeenCalledWith('manual');
    expect(context.syncManager.triggerSync).toHaveBeenCalledOnce();
    expect(result).toEqual({
      status: 'idle',
      lastSyncTime: '1970-01-01T00:00:01.000Z',
    });
  });

  it('returns null lastSyncTime when never synced', async () => {
    const context = createContext();
    context.syncManager.triggerSync.mockResolvedValue(undefined);
    context.syncManager.getSyncStatus.mockReturnValue('syncing');
    context.syncManager.getLastSyncTime.mockReturnValue(null);

    const result = await sync({}, context);

    expect(result).toEqual({
      status: 'syncing',
      lastSyncTime: null,
    });
  });

  it('propagates errors from triggerSync', async () => {
    const context = createContext();
    context.syncManager.triggerSync.mockRejectedValue(new Error('Sync failed'));

    await expect(sync({}, context)).rejects.toThrow('Sync failed');
  });
});
