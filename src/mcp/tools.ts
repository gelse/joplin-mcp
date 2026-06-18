import type { JoplinDataClient } from '../data-client.js';
import type { Logger } from '../logger.js';
import type { SyncManager } from '../sync-manager.js';
import type { Note, Folder, Tag, SearchResult } from '../api-types.js';

// =============================================================================
// Result Types
// =============================================================================

export interface ReadMultinoteResult {
  notes: Note[];
  errors: { note_id: string; error: string }[];
}

// =============================================================================
// Tool Handler Type
// =============================================================================

export interface ToolContext {
  client: JoplinDataClient;
  syncManager?: SyncManager;
  logger: Logger;
}

export type ToolHandler<TInput = unknown, TOutput = unknown> = (
  input: TInput,
  ctx: ToolContext,
) => Promise<TOutput>;

// =============================================================================
// Read Tools
// =============================================================================

export const listNotebooks: ToolHandler<object, Folder[]> = async (_input, ctx) => {
  return ctx.client.getAllFolders();
};

export const searchNotes: ToolHandler<{ query: string; type?: string }, SearchResult[]> = async (
  input,
  ctx,
) => {
  if (!input.query || input.query.trim().length === 0) {
    throw new Error('searchNotes validation failed: query must be a non-empty string');
  }
  return ctx.client.search({
    query: input.query,
    type: input.type as 'note' | 'folder' | 'tag' | undefined,
  });
};

export const readNote: ToolHandler<{ note_id: string }, Note> = async (input, ctx) => {
  return ctx.client.getNote(input.note_id);
};

export const readNotebook: ToolHandler<{ notebook_id: string }, Folder> = async (input, ctx) => {
  return ctx.client.getFolder(input.notebook_id);
};

export const readMultinote: ToolHandler<{ note_ids: string[] }, ReadMultinoteResult> = async (
  input,
  ctx,
) => {
  const results = await Promise.allSettled(input.note_ids.map((id) => ctx.client.getNote(id)));

  const notes: Note[] = [];
  const errors: { note_id: string; error: string }[] = [];

  results.forEach((result, index) => {
    const noteId = input.note_ids[index];
    if (result.status === 'fulfilled') {
      notes.push(result.value);
    } else {
      errors.push({
        note_id: noteId,
        error: result.reason?.message ?? 'Unknown error',
      });
    }
  });

  return { notes, errors };
};

export const readTags: ToolHandler<{ note_id: string }, Tag[]> = async (input, ctx) => {
  return ctx.client.getNoteTags(input.note_id);
};

// =============================================================================
// Write Tools (trigger sync after write)
// =============================================================================

export const createNote: ToolHandler<
  {
    title: string;
    parent_id?: string;
    body?: string;
    author?: string;
    source_url?: string;
    is_todo?: boolean | number;
    todo_due?: number;
  },
  Note
> = async (input, ctx) => {
  const note = await ctx.client.createNote({
    title: input.title,
    parent_id: input.parent_id,
    body: input.body,
    author: input.author,
    source_url: input.source_url,
    is_todo: typeof input.is_todo === 'boolean' ? (input.is_todo ? 1 : 0) : input.is_todo,
    todo_due: input.todo_due,
  });
  if (ctx.syncManager) await ctx.syncManager.triggerSync('create_note');
  return note;
};

export const createFolder: ToolHandler<
  { title: string; parent_id?: string; icon?: string },
  Folder
> = async (input, ctx) => {
  const folder = await ctx.client.createFolder({
    title: input.title,
    parent_id: input.parent_id,
    icon: input.icon,
  });
  if (ctx.syncManager) await ctx.syncManager.triggerSync('create_folder');
  return folder;
};

export const editNote: ToolHandler<
  {
    note_id: string;
    title?: string;
    parent_id?: string;
    body?: string;
    author?: string;
    source_url?: string;
    is_todo?: boolean | number;
    todo_due?: number;
  },
  Note
> = async (input, ctx) => {
  const { note_id, ...rest } = input;
  const note = await ctx.client.updateNote(note_id, {
    ...rest,
    is_todo: typeof rest.is_todo === 'boolean' ? (rest.is_todo ? 1 : 0) : rest.is_todo,
  });
  if (ctx.syncManager) await ctx.syncManager.triggerSync('edit_note');
  return note;
};

export const editFolder: ToolHandler<
  { folder_id: string; title?: string; parent_id?: string; icon?: string },
  Folder
> = async (input, ctx) => {
  const { folder_id, ...rest } = input;
  const folder = await ctx.client.updateFolder(folder_id, rest);
  if (ctx.syncManager) await ctx.syncManager.triggerSync('edit_folder');
  return folder;
};

export const createTag: ToolHandler<{ title: string }, Tag> = async (input, ctx) => {
  const tag = await ctx.client.createTag({ title: input.title });
  if (ctx.syncManager) await ctx.syncManager.triggerSync('create_tag');
  return tag;
};

export const tagNote: ToolHandler<
  { note_id: string; tag_id: string },
  { id: string; note_id: string; tag_id: string }
> = async (input, ctx) => {
  const result = await ctx.client.tagNote(input.note_id, input.tag_id);
  if (ctx.syncManager) await ctx.syncManager.triggerSync('tag_note');
  return result;
};

export const untagNote: ToolHandler<
  { note_id: string; tag_id: string },
  { success: boolean }
> = async (input, ctx) => {
  await ctx.client.untagNote(input.note_id, input.tag_id);
  if (ctx.syncManager) await ctx.syncManager.triggerSync('untag_note');
  return { success: true };
};

// =============================================================================
// Delete Tools
// =============================================================================

export const deleteNote: ToolHandler<{ note_id: string }, { success: boolean }> = async (
  input,
  ctx,
) => {
  await ctx.client.deleteNote(input.note_id);
  if (ctx.syncManager) await ctx.syncManager.triggerSync('delete_note');
  return { success: true };
};

export const deleteFolder: ToolHandler<{ folder_id: string }, { success: boolean }> = async (
  input,
  ctx,
) => {
  await ctx.client.deleteFolder(input.folder_id);
  if (ctx.syncManager) await ctx.syncManager.triggerSync('delete_folder');
  return { success: true };
};

// =============================================================================
// Sync Tool
// =============================================================================

export const sync: ToolHandler<object, { status: string; lastSyncTime: string | null }> = async (
  _input,
  ctx,
) => {
  if (ctx.syncManager) {
    await ctx.syncManager.triggerSync('manual');
    return {
      status: ctx.syncManager.getSyncStatus(),
      lastSyncTime: ctx.syncManager.getLastSyncTime()?.toISOString() ?? null,
    };
  }
  return {
    status: 'Sync is managed by the core container on a schedule',
    lastSyncTime: null,
  };
};
