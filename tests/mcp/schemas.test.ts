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
  extractSchemaShape,
} from '../../src/mcp/schemas.js';
import { z } from 'zod';

// 32-character hex IDs for testing
const VALID_ID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VALID_ID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const VALID_ID_C = 'cccccccccccccccccccccccccccccccc';
const VALID_ID_D = 'dddddddddddddddddddddddddddddddd';
const VALID_ID_E = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const VALID_HEX_MIXED = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

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

  it('rejects empty query string', () => {
    expect(() => SearchNotesSchema.parse({ query: '' })).toThrow();
  });

  it('rejects wrong type for query', () => {
    expect(() => SearchNotesSchema.parse({ query: 123 })).toThrow();
  });

  it('rejects query exceeding max length', () => {
    const longQuery = 'a'.repeat(1001);
    expect(() => SearchNotesSchema.parse({ query: longQuery })).toThrow();
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
  it('accepts valid input with 32-char hex ID', () => {
    const result = ReadNoteSchema.parse({ note_id: VALID_ID_A });
    expect(result).toEqual({ note_id: VALID_ID_A });
  });

  it('rejects missing note_id', () => {
    expect(() => ReadNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => ReadNoteSchema.parse({ note_id: 123 })).toThrow();
  });

  it('rejects short ID (wrong length)', () => {
    expect(() => ReadNoteSchema.parse({ note_id: 'abc123' })).toThrow();
  });

  it('rejects ID with non-hex characters', () => {
    expect(() => ReadNoteSchema.parse({ note_id: 'gggggggggggggggggggggggggggggggg' })).toThrow();
  });

  it('rejects 31-char hex string', () => {
    expect(() => ReadNoteSchema.parse({ note_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = ReadNoteSchema.parse({ note_id: VALID_ID_A, extra: true });
    expect(result).toEqual({ note_id: VALID_ID_A });
  });
});

// =============================================================================
// Schema: ReadNotebookSchema
// =============================================================================
describe('ReadNotebookSchema', () => {
  it('accepts valid input with 32-char hex ID', () => {
    const result = ReadNotebookSchema.parse({ notebook_id: VALID_ID_B });
    expect(result).toEqual({ notebook_id: VALID_ID_B });
  });

  it('rejects missing notebook_id', () => {
    expect(() => ReadNotebookSchema.parse({})).toThrow();
  });

  it('rejects wrong type for notebook_id', () => {
    expect(() => ReadNotebookSchema.parse({ notebook_id: 456 })).toThrow();
  });

  it('rejects short notebook_id', () => {
    expect(() => ReadNotebookSchema.parse({ notebook_id: 'short' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = ReadNotebookSchema.parse({
      notebook_id: VALID_ID_B,
      extra: true,
    });
    expect(result).toEqual({ notebook_id: VALID_ID_B });
  });
});

// =============================================================================
// Schema: ReadMultinoteSchema
// =============================================================================
describe('ReadMultinoteSchema', () => {
  it('accepts valid input with multiple 32-char hex IDs', () => {
    const result = ReadMultinoteSchema.parse({
      note_ids: [VALID_ID_A, VALID_ID_B, VALID_ID_C],
    });
    expect(result).toEqual({ note_ids: [VALID_ID_A, VALID_ID_B, VALID_ID_C] });
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

  it('rejects array elements that are not 32-char hex', () => {
    expect(() => ReadMultinoteSchema.parse({ note_ids: [VALID_ID_A, 'short'] })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = ReadMultinoteSchema.parse({
      note_ids: [VALID_ID_A],
      extra: true,
    });
    expect(result).toEqual({ note_ids: [VALID_ID_A] });
  });
});

// =============================================================================
// Schema: ReadTagsSchema
// =============================================================================
describe('ReadTagsSchema', () => {
  it('accepts valid input with 32-char hex ID', () => {
    const result = ReadTagsSchema.parse({ note_id: VALID_ID_D });
    expect(result).toEqual({ note_id: VALID_ID_D });
  });

  it('rejects missing note_id', () => {
    expect(() => ReadTagsSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => ReadTagsSchema.parse({ note_id: true })).toThrow();
  });

  it('rejects short note_id', () => {
    expect(() => ReadTagsSchema.parse({ note_id: 'n1' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = ReadTagsSchema.parse({ note_id: VALID_ID_D, extra: true });
    expect(result).toEqual({ note_id: VALID_ID_D });
  });
});

// =============================================================================
// Schema: CreateNoteSchema
// =============================================================================
describe('CreateNoteSchema', () => {
  const validCreate = {
    title: 'My Note',
    parent_id: VALID_ID_B,
    body: '# Content',
    author: 'me',
    source_url: 'https://example.com',
    is_todo: true,
    todo_due: 1700000000000,
  };

  it('accepts minimal valid input (title and parent_id)', () => {
    const result = CreateNoteSchema.parse({ title: 'My Note', parent_id: VALID_ID_A });
    expect(result).toEqual({ title: 'My Note', parent_id: VALID_ID_A });
  });

  it('accepts full valid input', () => {
    const result = CreateNoteSchema.parse(validCreate);
    expect(result).toEqual(validCreate);
  });

  it('accepts is_todo as number 1 (truthy) and transforms it to true', () => {
    const result = CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, is_todo: 1 });
    expect(result.is_todo).toBe(true);
  });

  it('accepts is_todo as number 0 (falsy) and transforms it to false', () => {
    const result = CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, is_todo: 0 });
    expect(result.is_todo).toBe(false);
  });

  it('accepts is_todo as boolean false', () => {
    const result = CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, is_todo: false });
    expect(result.is_todo).toBe(false);
  });

  it('accepts is_todo as boolean true', () => {
    const result = CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, is_todo: true });
    expect(result.is_todo).toBe(true);
  });

  it('rejects missing parent_id', () => {
    expect(() => CreateNoteSchema.parse({ title: 'x' })).toThrow();
  });

  it('rejects missing title', () => {
    expect(() => CreateNoteSchema.parse({ parent_id: VALID_ID_A })).toThrow();
  });

  it('rejects empty title', () => {
    expect(() => CreateNoteSchema.parse({ title: '', parent_id: VALID_ID_A })).toThrow();
  });

  it('rejects title exceeding 500 chars', () => {
    const longTitle = 'a'.repeat(501);
    expect(() => CreateNoteSchema.parse({ title: longTitle, parent_id: VALID_ID_A })).toThrow();
  });

  it('accepts title at exactly 500 chars', () => {
    const title500 = 'a'.repeat(500);
    const result = CreateNoteSchema.parse({ title: title500, parent_id: VALID_ID_A });
    expect(result.title).toHaveLength(500);
  });

  it('rejects wrong type for title', () => {
    expect(() => CreateNoteSchema.parse({ title: 123, parent_id: VALID_ID_A })).toThrow();
  });

  it('rejects wrong type for is_todo (string)', () => {
    expect(() =>
      CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, is_todo: 'yes' }),
    ).toThrow();
  });

  it('rejects wrong type for todo_due (string)', () => {
    expect(() =>
      CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, todo_due: 'later' }),
    ).toThrow();
  });

  it('rejects invalid parent_id (non-hex)', () => {
    expect(() => CreateNoteSchema.parse({ title: 'x', parent_id: 'not-a-valid-id' })).toThrow();
  });

  it('rejects body exceeding 1,000,000 chars', () => {
    const longBody = 'a'.repeat(1_000_001);
    expect(() =>
      CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, body: longBody }),
    ).toThrow();
  });

  it('rejects author exceeding 200 chars', () => {
    const longAuthor = 'a'.repeat(201);
    expect(() =>
      CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, author: longAuthor }),
    ).toThrow();
  });

  it('accepts valid source_url', () => {
    const result = CreateNoteSchema.parse({
      title: 'x',
      parent_id: VALID_ID_A,
      source_url: 'https://example.com/page',
    });
    expect(result.source_url).toBe('https://example.com/page');
  });

  it('rejects invalid source_url', () => {
    expect(() =>
      CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, source_url: 'not-a-url' }),
    ).toThrow();
  });

  it('strips unknown properties', () => {
    const result = CreateNoteSchema.parse({ title: 'x', parent_id: VALID_ID_A, unknown: true });
    expect(result).toEqual({ title: 'x', parent_id: VALID_ID_A });
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
    const iconJson = '{"emoji":"📁","name":"file_folder","type":1}';
    const result = CreateFolderSchema.parse({
      title: 'Folder',
      parent_id: VALID_ID_A,
      icon: iconJson,
    });
    expect(result).toEqual({
      title: 'Folder',
      parent_id: VALID_ID_A,
      icon: iconJson,
    });
  });

  it('rejects missing title', () => {
    expect(() => CreateFolderSchema.parse({})).toThrow();
  });

  it('rejects empty title', () => {
    expect(() => CreateFolderSchema.parse({ title: '' })).toThrow();
  });

  it('rejects title exceeding 500 chars', () => {
    const longTitle = 'a'.repeat(501);
    expect(() => CreateFolderSchema.parse({ title: longTitle })).toThrow();
  });

  it('rejects wrong type for title', () => {
    expect(() => CreateFolderSchema.parse({ title: true })).toThrow();
  });

  it('rejects invalid parent_id', () => {
    expect(() => CreateFolderSchema.parse({ title: 'x', parent_id: 'invalid' })).toThrow();
  });

  it('rejects wrong type for parent_id (number)', () => {
    expect(() => CreateFolderSchema.parse({ title: 'x', parent_id: 123 })).toThrow();
  });

  it('rejects icon exceeding 100 chars', () => {
    const longIcon = 'a'.repeat(101);
    expect(() => CreateFolderSchema.parse({ title: 'x', icon: longIcon })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = CreateFolderSchema.parse({ title: 'x', unknown: true });
    expect(result).toEqual({ title: 'x' });
  });

  it('accepts valid JSON icon string', () => {
    const iconJson = '{"emoji":"🧙","name":"mage","type":1}';
    const result = CreateFolderSchema.parse({
      title: 'x',
      icon: iconJson,
    });
    expect(result).toEqual({ title: 'x', icon: iconJson });
  });

  it('accepts empty string icon (clearing)', () => {
    const result = CreateFolderSchema.parse({ title: 'x', icon: '' });
    expect(result).toEqual({ title: 'x', icon: '' });
  });

  it('accepts omitted icon', () => {
    const result = CreateFolderSchema.parse({ title: 'x' });
    expect(result).toEqual({ title: 'x' });
  });

  it('rejects raw emoji string as icon', () => {
    expect(() => CreateFolderSchema.parse({ title: 'x', icon: '🧙' })).toThrow();
  });

  it('rejects invalid JSON as icon', () => {
    expect(() => CreateFolderSchema.parse({ title: 'x', icon: '{broken' })).toThrow();
  });

  it('rejects JSON icon missing required keys', () => {
    expect(() =>
      CreateFolderSchema.parse({
        title: 'x',
        icon: '{"emoji":"🧙"}',
      }),
    ).toThrow();
  });
});

// =============================================================================
// Schema: EditNoteSchema
// =============================================================================
describe('EditNoteSchema', () => {
  const validEditInput = {
    note_id: VALID_ID_A,
    title: 'Updated',
    parent_id: VALID_ID_B,
    body: 'New body',
    author: 'me',
    source_url: 'https://example.com',
    is_todo: false,
    todo_due: 1700000000000,
  };

  it('accepts valid input with only required note_id', () => {
    const result = EditNoteSchema.parse({ note_id: VALID_ID_A });
    expect(result).toEqual({ note_id: VALID_ID_A });
  });

  it('accepts partial update (note_id + only title)', () => {
    const result = EditNoteSchema.parse({
      note_id: VALID_ID_A,
      title: 'New Title',
    });
    expect(result).toEqual({ note_id: VALID_ID_A, title: 'New Title' });
  });

  it('accepts full valid input', () => {
    const result = EditNoteSchema.parse(validEditInput);
    expect(result).toEqual(validEditInput);
  });

  it('accepts is_todo as number and transforms it', () => {
    const result = EditNoteSchema.parse({ note_id: VALID_ID_A, is_todo: 1 });
    expect(result.is_todo).toBe(true);
    const result2 = EditNoteSchema.parse({ note_id: VALID_ID_A, is_todo: 0 });
    expect(result2.is_todo).toBe(false);
  });

  it('rejects missing note_id', () => {
    expect(() => EditNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => EditNoteSchema.parse({ note_id: 123 })).toThrow();
  });

  it('rejects short note_id', () => {
    expect(() => EditNoteSchema.parse({ note_id: 'n1' })).toThrow();
  });

  it('rejects title exceeding 500 chars', () => {
    const longTitle = 'a'.repeat(501);
    expect(() => EditNoteSchema.parse({ note_id: VALID_ID_A, title: longTitle })).toThrow();
  });

  it('rejects wrong type for body (number)', () => {
    expect(() => EditNoteSchema.parse({ note_id: VALID_ID_A, body: 123 })).toThrow();
  });

  it('rejects body exceeding 1,000,000 chars', () => {
    const longBody = 'a'.repeat(1_000_001);
    expect(() => EditNoteSchema.parse({ note_id: VALID_ID_A, body: longBody })).toThrow();
  });

  it('rejects author exceeding 200 chars', () => {
    const longAuthor = 'a'.repeat(201);
    expect(() => EditNoteSchema.parse({ note_id: VALID_ID_A, author: longAuthor })).toThrow();
  });

  it('rejects invalid source_url', () => {
    expect(() => EditNoteSchema.parse({ note_id: VALID_ID_A, source_url: 'bad-url' })).toThrow();
  });

  it('accepts valid source_url', () => {
    const result = EditNoteSchema.parse({
      note_id: VALID_ID_A,
      source_url: 'https://example.com',
    });
    expect(result.source_url).toBe('https://example.com');
  });

  it('strips unknown properties', () => {
    const result = EditNoteSchema.parse({ note_id: VALID_ID_A, extra: true });
    expect(result).toEqual({ note_id: VALID_ID_A });
  });
});

// =============================================================================
// Schema: EditFolderSchema
// =============================================================================
describe('EditFolderSchema', () => {
  it('accepts valid input with only required folder_id', () => {
    const result = EditFolderSchema.parse({ folder_id: VALID_ID_A });
    expect(result).toEqual({ folder_id: VALID_ID_A });
  });

  it('accepts partial update (folder_id + only title)', () => {
    const result = EditFolderSchema.parse({
      folder_id: VALID_ID_A,
      title: 'Renamed',
    });
    expect(result).toEqual({ folder_id: VALID_ID_A, title: 'Renamed' });
  });

  it('accepts full valid input', () => {
    const iconJson = '{"emoji":"🎉","name":"tada","type":1}';
    const result = EditFolderSchema.parse({
      folder_id: VALID_ID_A,
      title: 'Updated',
      parent_id: VALID_ID_B,
      icon: iconJson,
    });
    expect(result).toEqual({
      folder_id: VALID_ID_A,
      title: 'Updated',
      parent_id: VALID_ID_B,
      icon: iconJson,
    });
  });

  it('rejects missing folder_id', () => {
    expect(() => EditFolderSchema.parse({})).toThrow();
  });

  it('rejects wrong type for folder_id', () => {
    expect(() => EditFolderSchema.parse({ folder_id: true })).toThrow();
  });

  it('rejects short folder_id', () => {
    expect(() => EditFolderSchema.parse({ folder_id: 'f1' })).toThrow();
  });

  it('rejects title exceeding 500 chars', () => {
    const longTitle = 'a'.repeat(501);
    expect(() => EditFolderSchema.parse({ folder_id: VALID_ID_A, title: longTitle })).toThrow();
  });

  it('rejects wrong type for icon (boolean)', () => {
    expect(() => EditFolderSchema.parse({ folder_id: VALID_ID_A, icon: false })).toThrow();
  });

  it('rejects invalid parent_id', () => {
    expect(() => EditFolderSchema.parse({ folder_id: VALID_ID_A, parent_id: 'bad' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = EditFolderSchema.parse({ folder_id: VALID_ID_A, extra: true });
    expect(result).toEqual({ folder_id: VALID_ID_A });
  });

  it('accepts valid JSON icon string', () => {
    const iconJson = '{"emoji":"🧙","name":"mage","type":1}';
    const result = EditFolderSchema.parse({
      folder_id: VALID_ID_A,
      icon: iconJson,
    });
    expect(result).toEqual({ folder_id: VALID_ID_A, icon: iconJson });
  });

  it('accepts empty string icon (clearing)', () => {
    const result = EditFolderSchema.parse({ folder_id: VALID_ID_A, icon: '' });
    expect(result).toEqual({ folder_id: VALID_ID_A, icon: '' });
  });

  it('accepts omitted icon', () => {
    const result = EditFolderSchema.parse({ folder_id: VALID_ID_A });
    expect(result).toEqual({ folder_id: VALID_ID_A });
  });

  it('rejects raw emoji string as icon', () => {
    expect(() => EditFolderSchema.parse({ folder_id: VALID_ID_A, icon: '🧙' })).toThrow();
  });

  it('rejects invalid JSON as icon', () => {
    expect(() => EditFolderSchema.parse({ folder_id: VALID_ID_A, icon: '{broken' })).toThrow();
  });

  it('rejects JSON icon missing required keys', () => {
    expect(() =>
      EditFolderSchema.parse({
        folder_id: VALID_ID_A,
        icon: '{"emoji":"🧙"}',
      }),
    ).toThrow();
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

  it('rejects empty title', () => {
    expect(() => CreateTagSchema.parse({ title: '' })).toThrow();
  });

  it('rejects title exceeding 200 chars', () => {
    const longTitle = 'a'.repeat(201);
    expect(() => CreateTagSchema.parse({ title: longTitle })).toThrow();
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
  it('accepts valid input with 32-char hex IDs', () => {
    const result = TagNoteSchema.parse({
      note_id: VALID_ID_A,
      tag_id: VALID_ID_B,
    });
    expect(result).toEqual({ note_id: VALID_ID_A, tag_id: VALID_ID_B });
  });

  it('rejects missing note_id', () => {
    expect(() => TagNoteSchema.parse({ tag_id: VALID_ID_B })).toThrow();
  });

  it('rejects missing tag_id', () => {
    expect(() => TagNoteSchema.parse({ note_id: VALID_ID_A })).toThrow();
  });

  it('rejects missing both fields', () => {
    expect(() => TagNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => TagNoteSchema.parse({ note_id: 123, tag_id: VALID_ID_B })).toThrow();
  });

  it('rejects wrong type for tag_id', () => {
    expect(() => TagNoteSchema.parse({ note_id: VALID_ID_A, tag_id: 456 })).toThrow();
  });

  it('rejects short note_id', () => {
    expect(() => TagNoteSchema.parse({ note_id: 'n1', tag_id: VALID_ID_B })).toThrow();
  });

  it('rejects short tag_id', () => {
    expect(() => TagNoteSchema.parse({ note_id: VALID_ID_A, tag_id: 't1' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = TagNoteSchema.parse({
      note_id: VALID_ID_A,
      tag_id: VALID_ID_B,
      extra: true,
    });
    expect(result).toEqual({ note_id: VALID_ID_A, tag_id: VALID_ID_B });
  });
});

// =============================================================================
// Schema: UntagNoteSchema
// =============================================================================
describe('UntagNoteSchema', () => {
  it('accepts valid input with 32-char hex IDs', () => {
    const result = UntagNoteSchema.parse({
      note_id: VALID_ID_A,
      tag_id: VALID_ID_B,
    });
    expect(result).toEqual({ note_id: VALID_ID_A, tag_id: VALID_ID_B });
  });

  it('rejects missing note_id', () => {
    expect(() => UntagNoteSchema.parse({ tag_id: VALID_ID_B })).toThrow();
  });

  it('rejects missing tag_id', () => {
    expect(() => UntagNoteSchema.parse({ note_id: VALID_ID_A })).toThrow();
  });

  it('rejects missing both fields', () => {
    expect(() => UntagNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => UntagNoteSchema.parse({ note_id: null, tag_id: VALID_ID_B })).toThrow();
  });

  it('rejects short note_id', () => {
    expect(() => UntagNoteSchema.parse({ note_id: 'short', tag_id: VALID_ID_B })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = UntagNoteSchema.parse({
      note_id: VALID_ID_A,
      tag_id: VALID_ID_B,
      extra: true,
    });
    expect(result).toEqual({ note_id: VALID_ID_A, tag_id: VALID_ID_B });
  });
});

// =============================================================================
// Schema: DeleteNoteSchema
// =============================================================================
describe('DeleteNoteSchema', () => {
  it('accepts valid input with 32-char hex ID', () => {
    const result = DeleteNoteSchema.parse({ note_id: VALID_ID_E });
    expect(result).toEqual({ note_id: VALID_ID_E });
  });

  it('rejects missing note_id', () => {
    expect(() => DeleteNoteSchema.parse({})).toThrow();
  });

  it('rejects wrong type for note_id', () => {
    expect(() => DeleteNoteSchema.parse({ note_id: [] })).toThrow();
  });

  it('rejects short note_id', () => {
    expect(() => DeleteNoteSchema.parse({ note_id: 'note1' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = DeleteNoteSchema.parse({ note_id: VALID_ID_E, extra: true });
    expect(result).toEqual({ note_id: VALID_ID_E });
  });
});

// =============================================================================
// Schema: DeleteFolderSchema
// =============================================================================
describe('DeleteFolderSchema', () => {
  it('accepts valid input with 32-char hex ID', () => {
    const result = DeleteFolderSchema.parse({ folder_id: VALID_ID_C });
    expect(result).toEqual({ folder_id: VALID_ID_C });
  });

  it('rejects missing folder_id', () => {
    expect(() => DeleteFolderSchema.parse({})).toThrow();
  });

  it('rejects wrong type for folder_id', () => {
    expect(() => DeleteFolderSchema.parse({ folder_id: null })).toThrow();
  });

  it('rejects short folder_id', () => {
    expect(() => DeleteFolderSchema.parse({ folder_id: 'folder1' })).toThrow();
  });

  it('strips unknown properties', () => {
    const result = DeleteFolderSchema.parse({
      folder_id: VALID_ID_C,
      extra: true,
    });
    expect(result).toEqual({ folder_id: VALID_ID_C });
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

// =============================================================================
// Helper: extractSchemaShape
// =============================================================================
describe('extractSchemaShape', () => {
  it('extracts shape from a ZodObject', () => {
    const schema = z.object({ note_id: z.string(), title: z.string() });
    const shape = extractSchemaShape(schema);
    expect(shape).toHaveProperty('note_id');
    expect(shape).toHaveProperty('title');
    expect(Object.keys(shape)).toHaveLength(2);
  });

  it('returns empty object for ZodString (non-object schema)', () => {
    const schema = z.string();
    const shape = extractSchemaShape(schema);
    expect(shape).toEqual({});
  });

  it('returns empty object for ZodNumber (non-object schema)', () => {
    const schema = z.number();
    const shape = extractSchemaShape(schema);
    expect(shape).toEqual({});
  });

  it('returns empty object for ZodEnum (non-object schema)', () => {
    const schema = z.enum(['a', 'b']);
    const shape = extractSchemaShape(schema);
    expect(shape).toEqual({});
  });

  it('returns empty object for ZodArray (non-object schema)', () => {
    const schema = z.array(z.string());
    const shape = extractSchemaShape(schema);
    expect(shape).toEqual({});
  });

  it('returns empty object for ZodOptional wrapping non-object', () => {
    const schema = z.string().optional();
    const shape = extractSchemaShape(schema);
    expect(shape).toEqual({});
  });

  it('extracts shape from a complex ZodObject', () => {
    const schema = z.object({
      note_id: z.string(),
      title: z.string().min(1).max(500),
      body: z.string().optional(),
      tags: z.array(z.string()),
    });
    const shape = extractSchemaShape(schema);
    expect(shape).toHaveProperty('note_id');
    expect(shape).toHaveProperty('title');
    expect(shape).toHaveProperty('body');
    expect(shape).toHaveProperty('tags');
    expect(Object.keys(shape)).toHaveLength(4);
  });

  it('extracted shape validates input correctly', () => {
    const schema = z.object({ name: z.string().min(1).max(100) });
    const shape = extractSchemaShape(schema);

    // The extracted shape should be the same as the original object's shape
    const validationSchema = z.object(shape as Record<string, z.ZodTypeAny>);
    expect(validationSchema.parse({ name: 'hello' })).toEqual({ name: 'hello' });
    expect(() => validationSchema.parse({ name: '' })).toThrow();
    expect(() => validationSchema.parse({ name: 123 })).toThrow();
  });
});
