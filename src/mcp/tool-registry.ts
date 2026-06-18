import type { ZodTypeAny } from "zod";
import {
  ListNotesSchema,
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
} from "./schemas.js";
import {
  listNotes,
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
  type ToolHandler,
  type ToolContext,
} from "./tools.js";

export interface RegisteredTool {
  name: string;
  description: string;
  schema: ZodTypeAny;
  handler: ToolHandler<any, any>;
}

const TOOLS: Record<string, RegisteredTool> = {
  list_notes: {
    name: "list_notes",
    description: "List notes with optional pagination. Returns id, title, body, created_time, updated_time, parent_id, and todo fields for each note.",
    schema: ListNotesSchema,
    handler: listNotes,
  },
  list_notebooks: {
    name: "list_notebooks",
    description: "List all notebooks/folders in Joplin",
    schema: ListNotebooksSchema,
    handler: listNotebooks,
  },
  search_notes: {
    name: "search_notes",
    description: "Search for notes, folders, and tags by query string",
    schema: SearchNotesSchema,
    handler: searchNotes,
  },
  read_note: {
    name: "read_note",
    description: "Read a single note by ID, including its full body content",
    schema: ReadNoteSchema,
    handler: readNote,
  },
  read_notebook: {
    name: "read_notebook",
    description: "Read a single notebook/folder by ID",
    schema: ReadNotebookSchema,
    handler: readNotebook,
  },
  read_multinote: {
    name: "read_multinote",
    description: "Read multiple notes by their IDs",
    schema: ReadMultinoteSchema,
    handler: readMultinote,
  },
  read_tags: {
    name: "read_tags",
    description: "Get all tags associated with a note",
    schema: ReadTagsSchema,
    handler: readTags,
  },
  create_note: {
    name: "create_note",
    description: "Create a new note. Triggers sync after creation.",
    schema: CreateNoteSchema,
    handler: createNote,
  },
  create_folder: {
    name: "create_folder",
    description: "Create a new notebook/folder. Triggers sync after creation.",
    schema: CreateFolderSchema,
    handler: createFolder,
  },
  edit_note: {
    name: "edit_note",
    description: "Edit an existing note by ID. Triggers sync after update.",
    schema: EditNoteSchema,
    handler: editNote,
  },
  edit_folder: {
    name: "edit_folder",
    description: "Edit an existing folder by ID. Triggers sync after update.",
    schema: EditFolderSchema,
    handler: editFolder,
  },
  create_tag: {
    name: "create_tag",
    description: "Create a new tag. Triggers sync after creation.",
    schema: CreateTagSchema,
    handler: createTag,
  },
  tag_note: {
    name: "tag_note",
    description: "Apply a tag to a note. Triggers sync after application.",
    schema: TagNoteSchema,
    handler: tagNote,
  },
  untag_note: {
    name: "untag_note",
    description: "Remove a tag from a note. Triggers sync after removal.",
    schema: UntagNoteSchema,
    handler: untagNote,
  },
  delete_note: {
    name: "delete_note",
    description: "Delete a note by ID. Triggers sync after deletion.",
    schema: DeleteNoteSchema,
    handler: deleteNote,
  },
  delete_folder: {
    name: "delete_folder",
    description: "Delete a folder by ID. Triggers sync after deletion.",
    schema: DeleteFolderSchema,
    handler: deleteFolder,
  },
  sync: {
    name: "sync",
    description:
      "Manually trigger a sync with Joplin Server. Useful to ensure data is up-to-date.",
    schema: SyncSchema,
    handler: sync,
  },
};

export class ToolRegistry {
  getTool(name: string): RegisteredTool | undefined {
    return TOOLS[name];
  }

  getAllTools(): RegisteredTool[] {
    return Object.values(TOOLS);
  }

  getToolNames(): string[] {
    return Object.keys(TOOLS);
  }

  async executeTool(
    name: string,
    input: unknown,
    ctx: ToolContext
  ): Promise<unknown> {
    const tool = this.getTool(name);
    if (!tool) {
      throw new Error(
        `Unknown tool: ${name}. Available: ${this.getToolNames().join(", ")}`
      );
    }

    const parsed = tool.schema.parse(input);
    return tool.handler(parsed, ctx);
  }
}
