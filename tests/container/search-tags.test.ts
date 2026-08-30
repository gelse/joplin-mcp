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

interface SearchResult {
  id: string;
  title: string;
  type: string;
  parent_id: string;
  body?: string;
}

interface TagResult {
  id: string;
  title: string;
}

interface TagNoteResult {
  id: string;
  note_id: string;
  tag_id: string;
}

interface UntagNoteResult {
  success: boolean;
}

/** Poll until the search result contains the expected note id, or give up. */
async function waitForSearch(
  client: Client,
  query: string,
  expectedId: string,
  maxRetries = 30,
  delayMs = 500,
): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const result = await callTool<Array<{ id: string }>>(client, 'search_notes', {
      query,
    });
    if (result.some((item) => item.id === expectedId)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // If we get here, the search didn't find the expected item, but don't fail —
  // let the actual assertion handle the failure with a clearer message
}

beforeAll(async () => {
  client = await createTestClient();
  const folderName = `test-search-tags-${uid()}`;
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

describe('Search & Tags', () => {
  // ─── search_notes ────────────────────────────────────────────────────────

  it('search_notes — finds a note by unique body content', async () => {
    const uniquePhrase = `XylophoneMelody-${uid()}`;
    const note = await callTool<NoteResult>(client, 'create_note', {
      title: `search-target-${uid()}`,
      parent_id: testFolderId,
      body: uniquePhrase,
    });
    cleanup.trackNote(note.id);

    // Wait for the search index to include the newly created note
    await waitForSearch(client, uniquePhrase, note.id);

    const results = await callTool<SearchResult[]>(client, 'search_notes', {
      query: uniquePhrase,
    });

    expect(results).toBeInstanceOf(Array);
    const found = results.find((r) => r.id === note.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe(note.title);
  });

  it('search_notes with type: note — returns only notes', async () => {
    const query = `SearchTypeNote-${uid()}`;
    const note = await callTool<NoteResult>(client, 'create_note', {
      title: query,
      parent_id: testFolderId,
      body: `Body for ${query}`,
    });
    cleanup.trackNote(note.id);

    await waitForSearch(client, query, note.id);

    const results = await callTool<SearchResult[]>(client, 'search_notes', {
      query,
      type: 'note',
    });

    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.type).toBe('note');
    }
  });

  it('search_notes with type: folder — returns only folders', async () => {
    const folderTitle = `SearchTypeFolder-${uid()}`;
    const folder = await callTool<FolderResult>(client, 'create_folder', {
      title: folderTitle,
    });
    cleanup.trackFolder(folder.id);

    await waitForSearch(client, folderTitle, folder.id);

    const results = await callTool<SearchResult[]>(client, 'search_notes', {
      query: folderTitle,
      type: 'folder',
    });

    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.type).toBe('folder');
    }
  });

  it('search_notes — empty results for non-matching query', async () => {
    const noMatch = `NoMatchQuery-${uid()}-${uid()}`;

    const results = await callTool<SearchResult[]>(client, 'search_notes', {
      query: noMatch,
    });

    expect(results).toBeInstanceOf(Array);
    expect(results).toHaveLength(0);
  });

  // ─── Tags workflow ──────────────────────────────────────────────────────

  it('create_tag — creates a tag with unique title', async () => {
    const tagTitle = `tag-create-${uid()}`;

    const tag = await callTool<TagResult>(client, 'create_tag', {
      title: tagTitle,
    });

    expect(tag).toBeDefined();
    expect(tag.id).toBeTruthy();
    expect(tag.title).toBe(tagTitle);
  });

  it('tag_note — applies a tag to a note', async () => {
    const note = await callTool<NoteResult>(client, 'create_note', {
      title: `tag-target-${uid()}`,
      parent_id: testFolderId,
      body: 'Note to be tagged',
    });
    cleanup.trackNote(note.id);

    const tag = await callTool<TagResult>(client, 'create_tag', {
      title: `tag-apply-${uid()}`,
    });

    const result = await callTool<TagNoteResult>(client, 'tag_note', {
      note_id: note.id,
      tag_id: tag.id,
    });

    // Allow sync to commit the tag association before reading
    await new Promise((r) => setTimeout(r, 2000));

    expect(result).toBeDefined();
    expect(result.note_id).toBe(note.id);
    expect(result.tag_id).toBe(tag.id);
  });

  it('read_tags — tag appears on a tagged note', async () => {
    const note = await callTool<NoteResult>(client, 'create_note', {
      title: `tag-read-${uid()}`,
      parent_id: testFolderId,
      body: 'Note whose tags we will read',
    });
    cleanup.trackNote(note.id);

    const tagTitle = `tag-verify-${uid()}`;
    const tag = await callTool<TagResult>(client, 'create_tag', {
      title: tagTitle,
    });

    await callTool<TagNoteResult>(client, 'tag_note', {
      note_id: note.id,
      tag_id: tag.id,
    });

    // Allow sync to commit the tag association before reading
    await new Promise((r) => setTimeout(r, 2000));

    const tags = await callTool<TagResult[]>(client, 'read_tags', {
      note_id: note.id,
    });

    expect(tags).toBeInstanceOf(Array);
    const found = tags.find((t) => t.id === tag.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe(tagTitle);
  });

  it('untag_note — removes a tag from a note', async () => {
    const note = await callTool<NoteResult>(client, 'create_note', {
      title: `tag-remove-${uid()}`,
      parent_id: testFolderId,
      body: 'Note whose tag will be removed',
    });
    cleanup.trackNote(note.id);

    const tagTitle = `tag-unapply-${uid()}`;
    const tag = await callTool<TagResult>(client, 'create_tag', {
      title: tagTitle,
    });

    await callTool<TagNoteResult>(client, 'tag_note', {
      note_id: note.id,
      tag_id: tag.id,
    });

    // Allow sync to commit the tag association before reading
    await new Promise((r) => setTimeout(r, 2000));

    // Confirm tag is present before removal
    const tagsBefore = await callTool<TagResult[]>(client, 'read_tags', {
      note_id: note.id,
    });
    expect(tagsBefore.some((t) => t.id === tag.id)).toBe(true);

    // Remove the tag
    const untagResult = await callTool<UntagNoteResult>(client, 'untag_note', {
      note_id: note.id,
      tag_id: tag.id,
    });
    expect(untagResult.success).toBe(true);

    // Verify tag is no longer present
    const tagsAfter = await callTool<TagResult[]>(client, 'read_tags', {
      note_id: note.id,
    });
    expect(tagsAfter.some((t) => t.id === tag.id)).toBe(false);
  });
});
