# MCP Tools

Reader: an MCP client integrator wiring AI assistants to this server — which tools exist, what input each accepts, what each returns, and how errors are shaped.

## Tool overview

The server exposes 17 tools, registered in [`src/mcp/tool-registry.ts:50-154`](src/mcp/tool-registry.ts:50):

| Tool             | Description                                    | Writes? |
| ---------------- | ---------------------------------------------- | ------- |
| `list_notebooks` | List all notebooks/folders                     | No      |
| `list_notes`     | List notes with pagination and metadata fields | No      |
| `search_notes`   | Search notes, folders, and tags                | No      |
| `read_note`      | Read a single note by ID                       | No      |
| `read_notebook`  | Read a single notebook by ID                   | No      |
| `read_multinote` | Read multiple notes by IDs                     | No      |
| `read_tags`      | Get tags for a note                            | No      |
| `create_note`    | Create a new note                              | **Yes** |
| `create_folder`  | Create a new notebook                          | **Yes** |
| `edit_note`      | Edit an existing note                          | **Yes** |
| `edit_folder`    | Edit an existing folder                        | **Yes** |
| `create_tag`     | Create a new tag                               | **Yes** |
| `tag_note`       | Apply a tag to a note                          | **Yes** |
| `untag_note`     | Remove a tag from a note                       | **Yes** |
| `delete_note`    | Delete a note                                  | **Yes** |
| `delete_folder`  | Delete a folder                                | **Yes** |
| `sync`           | Report sync handling                           | No      |

All input is validated with [Zod](https://zod.dev/) schemas ([`src/mcp/schemas.ts`](src/mcp/schemas.ts)). Every ID is a 32-character hex string. Writes persist to the local Data API immediately and reach Joplin Server on the next scheduled sync — see [`docs/sync.md`](docs/sync.md).

## Read tools

| Tool             | Input                                                                  | Output                                            |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| `list_notebooks` | `{}`                                                                   | `Folder[]`                                        |
| `list_notes`     | `{ limit?: number (1–100), page?: number (≥1) }`                       | `{ items: Note[], has_more: boolean }`            |
| `search_notes`   | `{ query: string (1–1000 chars), type?: "note" \| "folder" \| "tag" }` | `SearchResult[]`                                  |
| `read_note`      | `{ note_id: string (32-char hex) }`                                    | `Note`                                            |
| `read_notebook`  | `{ notebook_id: string (32-char hex) }`                                | `Folder`                                          |
| `read_multinote` | `{ note_ids: string[] (array of 32-char hex IDs) }`                    | `{ notes: Note[], errors: { note_id, error }[] }` |
| `read_tags`      | `{ note_id: string (32-char hex) }`                                    | `Tag[]`                                           |

### `search_notes` FTS limitation

`search_notes` returns empty results for notes created or edited through the Data API: Joplin's `/search` endpoint reads a SQLite full-text-search index that the headless CLI (`joplin server start`) does not build or update. Such notes remain readable via `list_notes`/`read_note` but are not findable through `search_notes`. This is a known upstream issue: [laurent22/joplin#11631](https://github.com/laurent22/joplin/issues/11631). Until it is resolved, locate recently-written notes with `list_notes` and filter client-side.

## Write tools

| Tool            | Input                                                                                                                                                                          | Output              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `create_note`   | `{ title (1–500 chars, required), parent_id (32-char hex, **required**), body? (max 1 MB), author? (max 200), source_url? (validated URL), is_todo?, todo_due? (unix ms) }`    | `Note`              |
| `create_folder` | `{ title (1–500 chars), parent_id? (32-char hex), icon? (JSON-object string) }`                                                                                                 | `Folder`            |
| `edit_note`     | `{ note_id (required), title?, parent_id?, body?, author?, source_url?, is_todo?, todo_due? }`                                                                                  | `Note`              |
| `edit_folder`   | `{ folder_id (required), title?, parent_id?, icon? }`                                                                                                                           | `Folder`            |
| `create_tag`    | `{ title (1–200 chars) }`                                                                                                                                                       | `Tag`               |
| `tag_note`      | `{ note_id, tag_id }`                                                                                                                                                           | `NoteTag`           |
| `untag_note`    | `{ note_id, tag_id }`                                                                                                                                                           | `{ success: true }` |

Field-level rules worth knowing before you build a client ([`src/mcp/schemas.ts`](src/mcp/schemas.ts)):

- **`parent_id` is required for `create_note`** — a note must be created inside a notebook ([`src/mcp/schemas.ts:81`](src/mcp/schemas.ts:81)). For `edit_note` it is optional (moving a note between notebooks) ([`src/mcp/schemas.ts:102`](src/mcp/schemas.ts:102)).
- **`icon` must be a JSON-object string** with `emoji`, `name`, and `type` fields, e.g. `"{\"emoji\":\"🧙\",\"name\":\"mage\",\"type\":1}"`, max 100 chars ([`src/mcp/schemas.ts:16-35`](src/mcp/schemas.ts:16)). A plain string or raw object is rejected.
- **`is_todo` accepts a boolean or any number**; any non-zero number means `true` ([`src/mcp/schemas.ts:7`](src/mcp/schemas.ts:7)).

## Delete tools

| Tool            | Input           | Output              |
| --------------- | --------------- | ------------------- |
| `delete_note`   | `{ note_id }`   | `{ success: true }` |
| `delete_folder` | `{ folder_id }` | `{ success: true }` |

## The `sync` tool

In the combined container the `sync` tool does **not** trigger a sync. The entrypoint's bash scheduler owns all syncing, and the MCP server is started without a `SyncManager` ([`src/mcp/entry.ts:50-55`](src/mcp/entry.ts:50)). The tool always returns a fixed status ([`src/mcp/tools.ts:228-243`](src/mcp/tools.ts:228)):

```json
{
  "status": "Sync is handled automatically on a schedule by the container entrypoint.",
  "lastSyncTime": null
}
```

Writes are picked up by the scheduler within one `SYNC_INTERVAL_SECONDS` window; see [`docs/sync.md`](docs/sync.md) and [`docs/architecture.md#component-map`](docs/architecture.md#component-map).

## Error response format

When a tool execution fails, the MCP server returns `isError: true` with a single text entry ([`src/mcp/server.ts:16-48`](src/mcp/server.ts:16)):

```json
{
  "content": [{ "type": "text", "text": "Error message describing the failure" }],
  "isError": true
}
```

Two error classes are distinguished:

- **Validation errors** (Zod schema mismatch) are logged at `warn` level and name the field path and reason, e.g. `Validation error: note_id: Expected 32-character hex ID`
- **Execution errors** (API failures, timeouts) are logged at `error` level and read `Error executing <tool>: <message>`

## Where to read next

- How the server and its transport are deployed: [`docs/architecture.md`](docs/architecture.md)
- Running and extending the server locally: [`docs/development.md`](docs/development.md)
