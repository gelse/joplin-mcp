import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp';

const MCP_URL = process.env['MCP_URL'] || 'http://localhost:3000/';

/** Create and connect an MCP client to the test server. */
export async function createTestClient(): Promise<Client> {
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  await client.connect(transport);
  return client;
}

/** Generate a unique test ID prefix for resource isolation. */
export function uid(): string {
  return `itest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Typed wrapper for client.callTool that parses the JSON text content. */
export async function callTool<T = unknown>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.type === 'text' ? result.content[0].text : undefined;
  if (result.isError) {
    throw new Error(`Tool ${name} returned error: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

/** Track resource IDs for cleanup. */
export class CleanupTracker {
  private noteIds: string[] = [];
  private folderIds: string[] = [];
  private tagIds: string[] = [];

  trackNote(id: string): void {
    this.noteIds.push(id);
  }
  trackFolder(id: string): void {
    this.folderIds.push(id);
  }
  trackTag(id: string): void {
    this.tagIds.push(id);
  }

  async cleanup(client: Client): Promise<void> {
    // Delete in reverse order: notes, tags, folders
    for (const id of this.noteIds) {
      await client.callTool({ name: 'delete_note', arguments: { note_id: id } }).catch(() => {});
    }
    for (const id of this.tagIds) {
      // No delete_tag MCP tool exists. Tags are cleaned up when the
      // joplin_data volume is destroyed via `docker compose down -v`.
    }
    for (const id of this.folderIds) {
      await client
        .callTool({ name: 'delete_folder', arguments: { folder_id: id } })
        .catch(() => {});
    }
  }
}
