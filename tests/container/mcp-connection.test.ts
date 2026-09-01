import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { createTestClient } from './helpers.js';

let client: Client;

beforeAll(async () => {
  client = await createTestClient();
});

afterAll(async () => {
  await client?.close();
});

describe('MCP connection and tool discovery', () => {
  it('connects and completes initialize handshake', async () => {
    const capabilities = client.getServerCapabilities();
    expect(capabilities).toBeDefined();
    expect(capabilities?.tools).toBeDefined();
  });

  it('discovers all 17 tools', async () => {
    const { tools } = await client.listTools();
    // Intentionally brittle (see PR review): if a legitimate MCP tool is added,
    // this test failing is the reminder that the tool count must also be updated
    // in README.md, PROMPT.md, SBOM.md and the other tests/docs referencing it.
    expect(tools).toHaveLength(17);
  });

  it('each tool has name, description, and inputSchema', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('lists expected tool names', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('list_notes');
    expect(names).toContain('create_note');
    expect(names).toContain('read_note');
    expect(names).toContain('edit_note');
    expect(names).toContain('delete_note');
    expect(names).toContain('search_notes');
    expect(names).toContain('list_notebooks');
    expect(names).toContain('create_folder');
    expect(names).toContain('read_notebook');
    expect(names).toContain('edit_folder');
    expect(names).toContain('delete_folder');
    expect(names).toContain('create_tag');
    expect(names).toContain('tag_note');
    expect(names).toContain('untag_note');
    expect(names).toContain('read_tags');
    expect(names).toContain('read_multinote');
    expect(names).toContain('sync');
  });

  it('health endpoint returns ok', async () => {
    const res = await fetch(`${process.env['MCP_URL'] || 'http://localhost:3000/'}health`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });
});
