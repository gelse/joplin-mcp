import { z } from 'zod';

// Shared Joplin ID validator: 32-character hex string
const joplinId = z.string().regex(/^[0-9a-f]{32}$/, 'Expected 32-character hex ID');

// Helper: Joplin CLI uses 0/1 for booleans, but we accept both
const booleanNum = z.union([z.boolean(), z.number().transform((n) => n !== 0)]).optional();

// Schema for the JSON icon object format used by Joplin's Data API
const IconObjectSchema = z.object({
  emoji: z.string(),
  name: z.string(),
  type: z.number(),
});

// Icon must be empty/omitted OR a valid JSON icon object string
const iconSchema = z
  .string()
  .max(100)
  .optional()
  .refine(
    (val) => {
      if (val === undefined || val === '') return true;
      try {
        const parsed = JSON.parse(val);
        return IconObjectSchema.safeParse(parsed).success;
      } catch {
        return false;
      }
    },
    {
      message:
        'Icon must be empty or a JSON object string with emoji, name, and type fields (e.g. {"emoji":"🧙","name":"mage","type":1})',
    },
  );

// === list_notes ===
export const ListNotesSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe('Maximum number of notes to return (1-100)'),
  page: z.number().int().min(1).optional().describe('Page number for pagination'),
});

// === list_notebooks ===
export const ListNotebooksSchema = z.object({});

// === search_notes ===
export const SearchNotesSchema = z.object({
  query: z.string().min(1).max(1000).describe('Search query string'),
  type: z.enum(['note', 'folder', 'tag']).optional().describe('Filter by item type'),
});

// === read_note ===
export const ReadNoteSchema = z.object({
  note_id: joplinId.describe('The ID of the note to read'),
});

// === read_notebook ===
export const ReadNotebookSchema = z.object({
  notebook_id: joplinId.describe('The ID of the notebook/folder to read'),
});

// === read_multinote ===
export const ReadMultinoteSchema = z.object({
  note_ids: z.array(joplinId).describe('Array of note IDs to read'),
});

// === read_tags ===
export const ReadTagsSchema = z.object({
  note_id: joplinId.describe('The ID of the note to get tags for'),
});

// === create_note ===
export const CreateNoteSchema = z.object({
  title: z.string().min(1).max(500).describe('Note title'),
  parent_id: joplinId.describe('Parent notebook/folder ID'),
  body: z.string().max(1_000_000).optional().describe('Note body content (markdown)'),
  author: z.string().max(200).optional(),
  source_url: z.string().url().optional(),
  is_todo: booleanNum.describe('Whether this note is a todo'),
  todo_due: z.number().optional().describe('Todo due date (unix timestamp in ms)'),
});

// === create_folder ===
export const CreateFolderSchema = z.object({
  title: z.string().min(1).max(500).describe('Folder/notebook title'),
  parent_id: joplinId.optional().describe('Parent folder ID'),
  icon: iconSchema.describe(
    'Icon as JSON object string (e.g. {"emoji":"🧙","name":"mage","type":1})',
  ),
});

// === edit_note ===
export const EditNoteSchema = z.object({
  note_id: joplinId.describe('The ID of the note to edit'),
  title: z.string().max(500).optional(),
  parent_id: joplinId.optional(),
  body: z.string().max(1_000_000).optional(),
  author: z.string().max(200).optional(),
  source_url: z.string().url().optional(),
  is_todo: booleanNum,
  todo_due: z.number().optional(),
});

// === edit_folder ===
export const EditFolderSchema = z.object({
  folder_id: joplinId.describe('The ID of the folder to edit'),
  title: z.string().max(500).optional(),
  parent_id: joplinId.optional(),
  icon: iconSchema,
});

// === create_tag ===
export const CreateTagSchema = z.object({
  title: z.string().min(1).max(200).describe('Tag title'),
});

// === tag_note ===
export const TagNoteSchema = z.object({
  note_id: joplinId.describe('The ID of the note'),
  tag_id: joplinId.describe('The ID of the tag to apply'),
});

// === untag_note ===
export const UntagNoteSchema = z.object({
  note_id: joplinId.describe('The ID of the note'),
  tag_id: joplinId.describe('The ID of the tag to remove'),
});

// === delete_note ===
export const DeleteNoteSchema = z.object({
  note_id: joplinId.describe('The ID of the note to delete'),
});

// === delete_folder ===
export const DeleteFolderSchema = z.object({
  folder_id: joplinId.describe('The ID of the folder to delete'),
});

// === sync ===
export const SyncSchema = z.object({});

// Extract the shape from a Zod schema using the public API
export function extractSchemaShape(schema: z.ZodTypeAny): Record<string, z.ZodTypeAny> {
  if (schema instanceof z.ZodObject) {
    return schema.shape as Record<string, z.ZodTypeAny>;
  }
  return {};
}
