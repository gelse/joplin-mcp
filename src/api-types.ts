export interface Note {
  id: string;
  parent_id: string;
  title: string;
  body?: string;
  created_time: number;
  updated_time: number;
  is_conflict: number;
  latitude: number;
  longitude: number;
  altitude: number;
  author: string;
  source_url: string;
  is_todo: number;
  todo_due: number;
  todo_completed: number;
  source: string;
  source_application: string;
  application_data: string;
  order: number;
  user_created_time: number;
  user_updated_time: number;
  encryption_cipher_text: string;
  encryption_applied: number;
  markup_language: number;
  is_shared: number;
  share_id: string;
  conflict_original_id: string;
  master_key_id: string;
  body_html?: string;
  base_url?: string;
  image_data_url?: string;
  crop_rect?: string;
  type_: number;
}

export interface Folder {
  id: string;
  parent_id: string;
  title: string;
  created_time: number;
  updated_time: number;
  user_created_time: number;
  user_updated_time: number;
  encryption_cipher_text: string;
  encryption_applied: number;
  is_shared: number;
  share_id: string;
  master_key_id: string;
  icon: string;
}

export interface Tag {
  id: string;
  title: string;
  created_time: number;
  updated_time: number;
  user_created_time: number;
  user_updated_time: number;
  encryption_cipher_text: string;
  encryption_applied: number;
  is_shared: number;
  parent_id: string;
}

export interface Resource {
  id: string;
  title: string;
  mime: string;
  filename: string;
  created_time: number;
  updated_time: number;
  user_created_time: number;
  user_updated_time: number;
  file_extension: string;
  encryption_cipher_text: string;
  encryption_applied: number;
  encryption_blob_encrypted: number;
  size: number;
  is_shared: number;
  share_id: string;
  master_key_id: string;
}

export interface NoteTag {
  id: string;
  note_id: string;
  tag_id: string;
  created_time: number;
  updated_time: number;
  user_created_time: number;
  user_updated_time: number;
  encryption_cipher_text: string;
  encryption_applied: number;
}

export interface Event {
  id: string;
  item_type: string;
  item_id: string;
  type: number;
  created_time: number;
  source: number;
  before_change_item: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  has_more: boolean;
}

export interface Pagination {
  page?: number;
}

export interface SearchQuery {
  query: string;
  type?: "note" | "folder" | "tag";
}

export interface SearchResult {
  id: string;
  title: string;
  type: string;
  parent_id: string;
  is_todo: number;
  todo_completed: number;
  body?: string;
  updated_time: number;
  created_time: number;
}

export interface NoteCreatePayload {
  parent_id?: string;
  title: string;
  body?: string;
  author?: string;
  source_url?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  is_todo?: number;
  todo_due?: number;
  markup_language?: number;
}

export interface NoteUpdatePayload {
  parent_id?: string;
  title?: string;
  body?: string;
  author?: string;
  source_url?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  is_todo?: number;
  todo_due?: number;
  markup_language?: number;
}

export interface FolderCreatePayload {
  parent_id?: string;
  title: string;
  icon?: string;
}

export interface FolderUpdatePayload {
  parent_id?: string;
  title?: string;
  icon?: string;
}

export interface TagCreatePayload {
  title: string;
}

export interface PingResponse {
  status: string;
  version: string;
}
