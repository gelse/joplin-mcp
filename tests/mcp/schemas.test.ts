import { describe, it, expect } from 'vitest';
import {
  ListNotebooksSchema,
  SearchNotesSchema,
  ReadNoteSchema,
  ReadNotebookSchema,
  ReadMultinoteSchema,
  ReadTagsSchema,
  CreateNoteSchema,
  CreateFolderSchema,
  EditNoteSchema,
  EditFolderSchema,
  CreateTagSchema,
  TagNoteSchema,
  UntagNoteSchema,
  DeleteNoteSchema,
  DeleteFolderSchema,
  SyncSchema,
} from '../../src/mcp/schemas.js';

// =============================================================================
// Schema: ListNotebooksSchema
// =============================================================================
describe('ListNotebooksSchema', () => {
  it('accepts empty input', () => {
    const result = ListNotebooksSchema.parse({});
    expect(result).toEqual({});
  });

  it('strips unknown properties', () => {
    const result = ListNotebooksSchema.parse({ unknown: 'prop' });
    expect(result).toEqual({});
  });
});

// =============================================================================
// Schema: SearchNotesSchema
// =============================================================================
describe('SearchNotesSchema', () => {
  it('accepts valid input with only required query', () => {
    const result = SearchNotesSchema.parse({ query: 'hello' });
    expect(result).toEqual({ query: 'hello' });
  });

  it('accepts valid input with all fields', () => {
    const result = SearchNotesSchema.parse({ query: 'hello', type: 'note' });
    expect(result).toEqual({ query: 'hello', type: 'note' });
  });

  it("accepts type 'folder' and 'tag'", () => {
    expect(SearchNotesSchema.parse({ query: 'x', type: 'folder' })).toEqual({
      query: 'x',
      type: 'folder',
    });
    expect(SearchNotesSchema.parse({ query: 'x', type: 'tag' })).toEqual({
      query: 'x',
      type: 'tag',
    });
  });

  it('rejects missing query', () => {
    expect(() => SearchNotesSchema.parse({})).toThrow();
  });

  it('rejects wrong type for query', () => {
    expect(() => SearchNotesSchema.parse({ query: 123 })).toThrow();
  });

  it('rejects invalid type enum value', () => {
    expect(() => SearchNotesSchema.parse({ query: 'x', type: 'invalid' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = SearchNotesSchema.parse({ query: 'hello', extra: true });
    expect(result).toEqual({ query: 'hello' });
  });
});

// =============================================================================
// Schema: ReadNoteSchema
// =============================================================================
describe('ReadNoteSchema', () => {
  it('accepts valid input', () => {
    const result = ReadNoteSchema.parse({ note_id: 'abc123' });
    expect(result).toEqual({ note_id: 'abc123' });
  });

  it('rejects missing note_id', () => {
    expect(() => ReadNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => ReadNoteSchema.parse({ note_id: 123 })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = ReadNoteSchema.parse({ note_id: 'abc', extra: true });
    expect(result).toEqual({ note_id: 'abc' });
  });
});

// =============================================================================
// Schema: ReadNotebookSchema
// =============================================================================
describe('ReadNotebookSchema', () => {
  it('accepts valid input', () => {
    const result = ReadNotebookSchema.parse({ notebook_id: 'folder1' });
    expect(result).toEqual({ notebook_id: 'folder1' });
  });

  it('rejects missing notebook_id', () => {
    expect(() => ReadNotebookSchema.parse({})).toThrow();
  });

  it('rejects wrong type for notebook_id', () => {
    expect(() => ReadNotebookSchema.parse({ notebook_id: 456 })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = ReadNotebookSchema.parse({
      notebook_id: 'f1',
      extra: true,
    });
    expect(result).toEqual({ notebook_id: 'f1' });
  });
});

// =============================================================================
// Schema: ReadMultinoteSchema
// =============================================================================
describe('ReadMultinoteSchema', () => {
  it('accepts valid input with multiple IDs', () => {
    const result = ReadMultinoteSchema.parse({
      note_ids: ['id1', 'id2', 'id3'],
    });
    expect(result).toEqual({ note_ids: ['id1', 'id2', 'id3'] });
  });

  it('accepts empty array of note_ids', () => {
    const result = ReadMultinoteSchema.parse({ note_ids: [] });
    expect(result).toEqual({ note_ids: [] });
  });

  it('rejects missing note_ids', () => {
    expect(() => ReadMultinoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_ids', () => {
    expect(() => ReadMultinoteSchema.parse({ note_ids: 'not-array' })).toThrow();
  });

  it('rejects non-string array elements', () => {
    expect(() => ReadMultinoteSchema.parse({ note_ids: [1, 2, 3] })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = ReadMultinoteSchema.parse({
      note_ids: ['a'],
      extra: true,
    });
    expect(result).toEqual({ note_ids: ['a'] });
  });
});

// =============================================================================
// Schema: ReadTagsSchema
// =============================================================================
describe('ReadTagsSchema', () => {
  it('accepts valid input', () => {
    const result = ReadTagsSchema.parse({ note_id: 'note1' });
    expect(result).toEqual({ note_id: 'note1' });
  });

  it('rejects missing note_id', () => {
    expect(() => ReadTagsSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => ReadTagsSchema.parse({ note_id: true })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = ReadTagsSchema.parse({ note_id: 'n1', extra: true });
    expect(result).toEqual({ note_id: 'n1' });
  });
});

// =============================================================================
// Schema: CreateNoteSchema
// =============================================================================
describe('CreateNoteSchema', () => {
  it('accepts minimal valid input (only title)', () => {
    const result = CreateNoteSchema.parse({ title: 'My Note' });
    expect(result).toEqual({ title: 'My Note' });
  });

  it('accepts full valid input', () => {
    const input = {
      title: 'Full Note',
      parent_id: 'folder1',
      body: '# Content',
      author: 'me',
      source_url: 'https://example.com',
      is_todo: true,
      todo_due: 1700000000000,
    };
    const result = CreateNoteSchema.parse(input);
    expect(result).toEqual(input);
  });

  it('accepts is_todo as number 1 (truthy) and transforms it to true', () => {
    const result = CreateNoteSchema.parse({ title: 'x', is_todo: 1 });
    expect(result.is_todo).toBe(true);
  });

  it('accepts is_todo as number 0 (falsy) and transforms it to false', () => {
    const result = CreateNoteSchema.parse({ title: 'x', is_todo: 0 });
    expect(result.is_todo).toBe(false);
  });

  it('accepts is_todo as boolean false', () => {
    const result = CreateNoteSchema.parse({ title: 'x', is_todo: false });
    expect(result.is_todo).toBe(false);
  });

  it('accepts is_todo as boolean true', () => {
    const result = CreateNoteSchema.parse({ title: 'x', is_todo: true });
    expect(result.is_todo).toBe(true);
  });

  it('rejects missing title', () => {
    expect(() => CreateNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for title', () => {
    expect(() => CreateNoteSchema.parse({ title: 123 })).toThrow();
  });

  it('rejects wrong type for is_todo (string)', () => {
    expect(() => CreateNoteSchema.parse({ title: 'x', is_todo: 'yes' })).toThrow();
  });

  it('rejects wrong type for todo_due (string)', () => {
    expect(() => CreateNoteSchema.parse({ title: 'x', todo_due: 'later' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = CreateNoteSchema.parse({ title: 'x', unknown: true });
    expect(result).toEqual({ title: 'x' });
  });
});

// =============================================================================
// Schema: CreateFolderSchema
// =============================================================================
describe('CreateFolderSchema', () => {
  it('accepts minimal valid input (only title)', () => {
    const result = CreateFolderSchema.parse({ title: 'My Folder' });
    expect(result).toEqual({ title: 'My Folder' });
  });

  it('accepts full valid input', () => {
    const result = CreateFolderSchema.parse({
      title: 'Folder',
      parent_id: 'parent1',
      icon: '📁',
    });
    expect(result).toEqual({
      title: 'Folder',
      parent_id: 'parent1',
      icon: '📁',
    });
  });

  it('rejects missing title', () => {
    expect(() => CreateFolderSchema.parse({})).toThrow();
  });

  it('rejects wrong type for title', () => {
    expect(() => CreateFolderSchema.parse({ title: true })).toThrow();
  });

  it('rejects wrong type for parent_id (number)', () => {
    expect(() => CreateFolderSchema.parse({ title: 'x', parent_id: 123 })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = CreateFolderSchema.parse({ title: 'x', unknown: true });
    expect(result).toEqual({ title: 'x' });
  });
});

// =============================================================================
// Schema: EditNoteSchema
// =============================================================================
describe('EditNoteSchema', () => {
  it('accepts valid input with only required note_id', () => {
    const result = EditNoteSchema.parse({ note_id: 'note1' });
    expect(result).toEqual({ note_id: 'note1' });
  });

  it('accepts partial update (note_id + only title)', () => {
    const result = EditNoteSchema.parse({
      note_id: 'n1',
      title: 'New Title',
    });
    expect(result).toEqual({ note_id: 'n1', title: 'New Title' });
  });

  it('accepts full valid input', () => {
    const input = {
      note_id: 'n1',
      title: 'Updated',
      parent_id: 'f1',
      body: 'New body',
      author: 'me',
      source_url: 'https://example.com',
      is_todo: false,
      todo_due: 1700000000000,
    };
    const result = EditNoteSchema.parse(input);
    expect(result).toEqual(input);
  });

  it('accepts is_todo as number and transforms it', () => {
    const result = EditNoteSchema.parse({ note_id: 'n1', is_todo: 1 });
    expect(result.is_todo).toBe(true);
    const result2 = EditNoteSchema.parse({ note_id: 'n1', is_todo: 0 });
    expect(result2.is_todo).toBe(false);
  });

  it('rejects missing note_id', () => {
    expect(() => EditNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => EditNoteSchema.parse({ note_id: 123 })).toThrow();
  });

  it('rejects wrong type for body (number)', () => {
    expect(() => EditNoteSchema.parse({ note_id: 'n1', body: 123 })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = EditNoteSchema.parse({ note_id: 'n1', extra: true });
    expect(result).toEqual({ note_id: 'n1' });
  });
});

// =============================================================================
// Schema: EditFolderSchema
// =============================================================================
describe('EditFolderSchema', () => {
  it('accepts valid input with only required folder_id', () => {
    const result = EditFolderSchema.parse({ folder_id: 'f1' });
    expect(result).toEqual({ folder_id: 'f1' });
  });

  it('accepts partial update (folder_id + only title)', () => {
    const result = EditFolderSchema.parse({
      folder_id: 'f1',
      title: 'Renamed',
    });
    expect(result).toEqual({ folder_id: 'f1', title: 'Renamed' });
  });

  it('accepts full valid input', () => {
    const result = EditFolderSchema.parse({
      folder_id: 'f1',
      title: 'Updated',
      parent_id: 'parent1',
      icon: '🎉',
    });
    expect(result).toEqual({
      folder_id: 'f1',
      title: 'Updated',
      parent_id: 'parent1',
      icon: '🎉',
    });
  });

  it('rejects missing folder_id', () => {
    expect(() => EditFolderSchema.parse({})).toThrow();
  });

  it('rejects wrong type for folder_id', () => {
    expect(() => EditFolderSchema.parse({ folder_id: true })).toThrow();
  });

  it('rejects wrong type for icon (boolean)', () => {
    expect(() => EditFolderSchema.parse({ folder_id: 'f1', icon: false })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = EditFolderSchema.parse({ folder_id: 'f1', extra: true });
    expect(result).toEqual({ folder_id: 'f1' });
  });
});

// =============================================================================
// Schema: CreateTagSchema
// =============================================================================
describe('CreateTagSchema', () => {
  it('accepts valid input', () => {
    const result = CreateTagSchema.parse({ title: 'important' });
    expect(result).toEqual({ title: 'important' });
  });

  it('rejects missing title', () => {
    expect(() => CreateTagSchema.parse({})).toThrow();
  });

  it('rejects wrong type for title', () => {
    expect(() => CreateTagSchema.parse({ title: null })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = CreateTagSchema.parse({ title: 'tag', extra: true });
    expect(result).toEqual({ title: 'tag' });
  });
});

// =============================================================================
// Schema: TagNoteSchema
// =============================================================================
describe('TagNoteSchema', () => {
  it('accepts valid input', () => {
    const result = TagNoteSchema.parse({
      note_id: 'note1',
      tag_id: 'tag1',
    });
    expect(result).toEqual({ note_id: 'note1', tag_id: 'tag1' });
  });

  it('rejects missing note_id', () => {
    expect(() => TagNoteSchema.parse({ tag_id: 't1' })).toThrow();
  });

  it('rejects missing tag_id', () => {
    expect(() => TagNoteSchema.parse({ note_id: 'n1' })).toThrow();
  });

  it('rejects missing both fields', () => {
    expect(() => TagNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => TagNoteSchema.parse({ note_id: 123, tag_id: 't1' })).toThrow();
  });

  it('rejects wrong type for tag_id', () => {
    expect(() => TagNoteSchema.parse({ note_id: 'n1', tag_id: 456 })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = TagNoteSchema.parse({
      note_id: 'n1',
      tag_id: 't1',
      extra: true,
    });
    expect(result).toEqual({ note_id: 'n1', tag_id: 't1' });
  });
});

// =============================================================================
// Schema: UntagNoteSchema
// =============================================================================
describe('UntagNoteSchema', () => {
  it('accepts valid input', () => {
    const result = UntagNoteSchema.parse({
      note_id: 'note1',
      tag_id: 'tag1',
    });
    expect(result).toEqual({ note_id: 'note1', tag_id: 'tag1' });
  });

  it('rejects missing note_id', () => {
    expect(() => UntagNoteSchema.parse({ tag_id: 't1' })).toThrow();
  });

  it('rejects missing tag_id', () => {
    expect(() => UntagNoteSchema.parse({ note_id: 'n1' })).toThrow();
  });

  it('rejects missing both fields', () => {
    expect(() => UntagNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => UntagNoteSchema.parse({ note_id: null, tag_id: 't1' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = UntagNoteSchema.parse({
      note_id: 'n1',
      tag_id: 't1',
      extra: true,
    });
    expect(result).toEqual({ note_id: 'n1', tag_id: 't1' });
  });
});

// =============================================================================
// Schema: DeleteNoteSchema
// =============================================================================
describe('DeleteNoteSchema', () => {
  it('accepts valid input', () => {
    const result = DeleteNoteSchema.parse({ note_id: 'note1' });
    expect(result).toEqual({ note_id: 'note1' });
  });

  it('rejects missing note_id', () => {
    expect(() => DeleteNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => DeleteNoteSchema.parse({ note_id: [] })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = DeleteNoteSchema.parse({ note_id: 'n1', extra: true });
    expect(result).toEqual({ note_id: 'n1' });
  });
});

// =============================================================================
// Schema: DeleteFolderSchema
// =============================================================================
describe('DeleteFolderSchema', () => {
  it('accepts valid input', () => {
    const result = DeleteFolderSchema.parse({ folder_id: 'folder1' });
    expect(result).toEqual({ folder_id: 'folder1' });
  });

  it('rejects missing folder_id', () => {
    expect(() => DeleteFolderSchema.parse({})).toThrow();
  });

  it('rejects wrong type for folder_id', () => {
    expect(() => DeleteFolderSchema.parse({ folder_id: null })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = DeleteFolderSchema.parse({
      folder_id: 'f1',
      extra: true,
    });
    expect(result).toEqual({ folder_id: 'f1' });
  });
});

// =============================================================================
// Schema: SyncSchema
// =============================================================================
describe('SyncSchema', () => {
  it('accepts empty input', () => {
    const result = SyncSchema.parse({});
    expect(result).toEqual({});
  });

  it('strips unknown properties', () => {
    const result = SyncSchema.parse({ unknown: 'prop' });
    expect(result).toEqual({});
  });
});
