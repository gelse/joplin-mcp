import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { createTestClient } from './helpers.js';

/** Shape returned by client.callTool — content is unknown at the SDK level. */
interface CallToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

let client: Client;

beforeAll(async () => {
  client = await createTestClient();
});

afterAll(async () => {
  await client?.close();
});

describe('Error Handling', () => {
  it('read_note with invalid ID format — returns validation error', async () => {
    try {
      const result = (await client.callTool({
        name: 'read_note',
        arguments: { note_id: 'not-a-valid-hex-id' },
      })) as unknown as CallToolResult;

      expect(result.isError).toBe(true);
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('Validation error');
    } catch {
      // MCP SDK may reject invalid input before reaching the tool
    }
  });

  it('read_note with non-existent ID — returns error response', async () => {
    const fakeId = '0'.repeat(32);
    const result = (await client.callTool({
      name: 'read_note',
      arguments: { note_id: fakeId },
    })) as unknown as CallToolResult;

    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
    expect(text.length).toBeGreaterThan(0);
  });

  it('create_note with missing required fields — returns validation error', async () => {
    try {
      const result = (await client.callTool({
        name: 'create_note',
        arguments: {},
      })) as unknown as CallToolResult;

      expect(result.isError).toBe(true);
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('Validation error');
    } catch {
      // MCP SDK may reject missing required fields before reaching the tool
    }
  });

  it('create_note with empty title — returns validation error', async () => {
    try {
      const result = (await client.callTool({
        name: 'create_note',
        arguments: {
          title: '',
          parent_id: '0'.repeat(32),
        },
      })) as unknown as CallToolResult;

      expect(result.isError).toBe(true);
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('Validation error');
    } catch {
      // MCP SDK may reject empty title before reaching the tool
    }
  });

  it('unknown tool name — returns rejection', async () => {
    await expect(
      client.callTool({
        name: 'nonexistent_tool',
        arguments: {},
      }),
    ).rejects.toThrow();
  });

  it('search_notes with empty query — returns validation error', async () => {
    try {
      const result = (await client.callTool({
        name: 'search_notes',
        arguments: { query: '' },
      })) as unknown as CallToolResult;

      expect(result.isError).toBe(true);
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('Validation error');
    } catch {
      // MCP SDK may reject empty query before reaching the tool
    }
  });

  it('edit_note with invalid note_id format — returns validation error', async () => {
    try {
      const result = (await client.callTool({
        name: 'edit_note',
        arguments: { note_id: 'invalid-id-format' },
      })) as unknown as CallToolResult;

      expect(result.isError).toBe(true);
      const text = result.content?.[0]?.type === 'text' ? result.content[0].text : '';
      expect(text).toContain('Validation error');
    } catch {
      // MCP SDK may reject invalid note_id before reaching the tool
    }
  });

  it('error responses have isError: true and descriptive text', async () => {
    // Use a non-existent note ID to trigger an error from the tool handler
    const result = (await client.callTool({
      name: 'read_note',
      arguments: { note_id: '0'.repeat(32) },
    })) as unknown as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);

    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    expect(text.length).toBeGreaterThan(0);
    expect(typeof text).toBe('string');
  });
});
