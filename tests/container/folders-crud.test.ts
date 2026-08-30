import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client';
import { createTestClient, callTool, uid, CleanupTracker } from './helpers.js';

let client: Client;
const cleanup = new CleanupTracker();

interface FolderResult {
  id: string;
  title: string;
  parent_id?: string;
}

beforeAll(async () => {
  client = await createTestClient();
});

afterAll(async () => {
  await cleanup.cleanup(client);
  await client?.close();
});

describe('Folders CRUD', () => {
  it('create_folder — creates a folder with unique title', async () => {
    const title = `folder-create-${uid()}`;

    const folder = await callTool<FolderResult>(client, 'create_folder', {
      title,
    });

    cleanup.trackFolder(folder.id);

    expect(folder).toBeDefined();
    expect(folder.id).toBeTruthy();
    expect(folder.title).toBe(title);
  });

  it('read_notebook — reads back the created folder', async () => {
    const title = `folder-read-${uid()}`;

    const created = await callTool<FolderResult>(client, 'create_folder', {
      title,
    });
    cleanup.trackFolder(created.id);

    const folder = await callTool<FolderResult>(client, 'read_notebook', {
      notebook_id: created.id,
    });

    expect(folder.id).toBe(created.id);
    expect(folder.title).toBe(title);
  });

  it('list_notebooks — lists all notebooks and finds the created folder', async () => {
    const title = `folder-list-${uid()}`;

    const created = await callTool<FolderResult>(client, 'create_folder', {
      title,
    });
    cleanup.trackFolder(created.id);

    const notebooks = await callTool<FolderResult[]>(client, 'list_notebooks', {});

    expect(notebooks).toBeInstanceOf(Array);
    const found = notebooks.find((nb) => nb.id === created.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe(title);
  });

  it('edit_folder — edits folder title and verifies changes', async () => {
    const title = `folder-edit-${uid()}`;

    const created = await callTool<FolderResult>(client, 'create_folder', {
      title,
    });
    cleanup.trackFolder(created.id);

    const newTitle = `folder-edit-updated-${uid()}`;

    await callTool<FolderResult>(client, 'edit_folder', {
      folder_id: created.id,
      title: newTitle,
    });

    const folder = await callTool<FolderResult>(client, 'read_notebook', {
      notebook_id: created.id,
    });

    expect(folder.title).toBe(newTitle);
  });

  it('delete_folder — deletes the folder and read returns error', async () => {
    const title = `folder-delete-${uid()}`;

    const created = await callTool<FolderResult>(client, 'create_folder', {
      title,
    });

    await callTool<{ success: boolean }>(client, 'delete_folder', {
      folder_id: created.id,
    });

    await expect(callTool(client, 'read_notebook', { notebook_id: created.id })).rejects.toThrow();
  });

  it('nested folder — creates a child folder with parent_id', async () => {
    const parentTitle = `folder-parent-${uid()}`;

    const parent = await callTool<FolderResult>(client, 'create_folder', {
      title: parentTitle,
    });
    cleanup.trackFolder(parent.id);

    const childTitle = `folder-child-${uid()}`;

    const child = await callTool<FolderResult>(client, 'create_folder', {
      title: childTitle,
      parent_id: parent.id,
    });
    cleanup.trackFolder(child.id);

    expect(child).toBeDefined();
    expect(child.id).toBeTruthy();
    expect(child.title).toBe(childTitle);

    const readChild = await callTool<FolderResult>(client, 'read_notebook', {
      notebook_id: child.id,
    });
    expect(readChild.parent_id).toBe(parent.id);
  });
});
