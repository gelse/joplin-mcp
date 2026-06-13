import { z } from "zod";

// Helper: Joplin CLI uses 0/1 for booleans, but we accept both
const booleanNum = z
  .union([z.boolean(), z.number().transform((n) => n !== 0)])
  .optional();

// === list_notebooks ===
export const ListNotebooksSchema = z.object({});

// === search_notes ===
export const SearchNotesSchema = z.object({
  query: z.string().describe("Search query string"),
  type: z
    .enum(["note", "folder", "tag"])
    .optional()
    .describe("Filter by item type"),
});

// === read_note ===
export const ReadNoteSchema = z.object({
  note_id: z.string().describe("The ID of the note to read"),
});

// === read_notebook ===
export const ReadNotebookSchema = z.object({
  notebook_id: z.string().describe("The ID of the notebook/folder to read"),
});

// === read_multinote ===
export const ReadMultinoteSchema = z.object({
  note_ids: z.array(z.string()).describe("Array of note IDs to read"),
});

// === read_tags ===
export const ReadTagsSchema = z.object({
  note_id: z.string().describe("The ID of the note to get tags for"),
});

// === create_note ===
export const CreateNoteSchema = z.object({
  title: z.string().describe("Note title"),
  parent_id: z.string().optional().describe("Parent notebook/folder ID"),
  body: z.string().optional().describe("Note body content (markdown)"),
  author: z.string().optional(),
  source_url: z.string().optional(),
  is_todo: booleanNum.describe("Whether this note is a todo"),
  todo_due: z.number().optional().describe("Todo due date (unix timestamp in ms)"),
});

// === create_folder ===
export const CreateFolderSchema = z.object({
  title: z.string().describe("Folder/notebook title"),
  parent_id: z.string().optional().describe("Parent folder ID"),
  icon: z.string().optional().describe("Emoji icon for the folder"),
});

// === edit_note ===
export const EditNoteSchema = z.object({
  note_id: z.string().describe("The ID of the note to edit"),
  title: z.string().optional(),
  parent_id: z.string().optional(),
  body: z.string().optional(),
  author: z.string().optional(),
  source_url: z.string().optional(),
  is_todo: booleanNum,
  todo_due: z.number().optional(),
});

// === edit_folder ===
export const EditFolderSchema = z.object({
  folder_id: z.string().describe("The ID of the folder to edit"),
  title: z.string().optional(),
  parent_id: z.string().optional(),
  icon: z.string().optional(),
});

// === create_tag ===
export const CreateTagSchema = z.object({
  title: z.string().describe("Tag title"),
});

// === tag_note ===
export const TagNoteSchema = z.object({
  note_id: z.string().describe("The ID of the note"),
  tag_id: z.string().describe("The ID of the tag to apply"),
});

// === untag_note ===
export const UntagNoteSchema = z.object({
  note_id: z.string().describe("The ID of the note"),
  tag_id: z.string().describe("The ID of the tag to remove"),
});

// === delete_note ===
export const DeleteNoteSchema = z.object({
  note_id: z.string().describe("The ID of the note to delete"),
});

// === delete_folder ===
export const DeleteFolderSchema = z.object({
  folder_id: z.string().describe("The ID of the folder to delete"),
});

// === sync ===
export const SyncSchema = z.object({});
