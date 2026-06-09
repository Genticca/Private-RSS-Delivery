import type { NormalizedItem, Profile } from '../domain/normalize/types.js';

export interface PresetRenderItem extends NormalizedItem {
  publishedAtFormatted?: string;
}

export interface PresetRenderSource {
  id: string;
  name: string;
  feedUrl?: string;
  profile?: Profile;
}

export interface PresetRenderContext {
  item: PresetRenderItem;
  source: PresetRenderSource;
}

export const PRESET_VARIABLES = [
  'item.title',
  'item.link',
  'item.summary',
  'item.publishedAtFormatted',
  'item.author',
  'source.name',
  'item.incidentStage',
  'item.commentsUrl',
  'item.image',
  'source.feedUrl',
  'source.profile'
] as const;

export const PRESET_HELPERS = ['truncate', 'stageColor', 'stageLabel', 'eq', 'json'] as const;

export type PresetVariable = (typeof PRESET_VARIABLES)[number];

export type PresetHelper = (typeof PRESET_HELPERS)[number];

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbedFooter {
  text: string;
  icon_url?: string;
}

export interface DiscordEmbedAuthor {
  name: string;
  url?: string;
  icon_url?: string;
}

export interface DiscordEmbedMedia {
  url: string;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: DiscordEmbedFooter;
  author?: DiscordEmbedAuthor;
  thumbnail?: DiscordEmbedMedia;
  image?: DiscordEmbedMedia;
  timestamp?: string;
}

export interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  flags?: number;
  thread_name?: string;
  applied_tags?: string[];
  embeds?: DiscordEmbed[];
  allowed_mentions?: {
    parse?: Array<'roles' | 'users' | 'everyone'>;
    roles?: string[];
    users?: string[];
    replied_user?: boolean;
  };
}
