import type { SourceDto } from '../sources/service.js';
import type { SourceProfile } from '../feed/parse.js';
import type { EventLogDto } from '../logs/service.js';
import type { GroupDto } from '../groups/service.js';
import type { TemplateDto } from '../templates/service.js';
import type { PresetVariable } from '../templates/render.js';

export interface DashboardSourceSummary {
  id: string;
  name: string | null;
  enabled: boolean;
  lastOutcome: SourceDto['lastOutcome'];
  profile: SourceProfile;
  feedUrl: string;
  hasError: boolean;
  outcomeLabel: string;
}

export interface DashboardViewModel {
  sources: DashboardSourceSummary[];
  counts: {
    sources: number;
    enabled: number;
    errors: number;
    connectedGroups: number;
  };
  recentEvents: Array<EventLogDto & {
    icon: string;
    label: string;
    failed: boolean;
    timeLabel: string;
  }>;
}

/** 소스 폼 그룹: 현재 배정 여부(selected) 체크박스 prefill용 — web.ts withGroupSelection. */
export interface GroupWithSelection extends GroupDto {
  selected: boolean;
}

export interface SourceFormViewModel {
  // web.ts가 withDestinationStatus로 source.hasAnyDestination을, withGroupSelection으로 groups[].selected를 주입한다.
  source: (SourceDto & {
    hasAnyDestination: boolean
  }) | null;
  groups: GroupWithSelection[];
  templates: TemplateDto[];
  profiles: readonly SourceProfile[];
}

export interface TemplateEditorViewModel {
  template: TemplateDto;
  presetVars: readonly PresetVariable[];
  sources: Array<{
    id: string;
    name: string
  }>;
  needsCodeMirror: boolean; // web.ts: CodeMirror 자산 로드 플래그(=true)
}

export type LogsViewModel = Record<string, never>;
