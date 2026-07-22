import { GuildForumTag } from "discord.js";
import { ProjectColumn, Thread } from "./interfaces";

class Store {
  threads: Thread[] = [];
  availableTags: GuildForumTag[] = [];
  tagMap: Map<string, string> = new Map();

  // Issue type state: maps type name (e.g. "Bug") -> GitHub node_id
  issueTypeMap: Map<string, string> = new Map();

  // Kanban state (Phase 5)
  projectId?: string;
  statusFieldId?: string;
  kanbanColumns: ProjectColumn[] = [];
  kanbanTagMap: Map<string, string> = new Map();

  // Project Priority field: mirrored as tags with the same replace-on-change
  // semantics as Status, so an issue carries at most one priority tag.
  priorityFieldId?: string;
  priorityColumns: ProjectColumn[] = [];
  priorityTagMap: Map<string, string> = new Map();

  deleteThread(id: string | undefined) {
    const index = this.threads.findIndex((obj) => obj.id === id);
    if (index !== -1) {
      this.threads.splice(index, 1);
    }
    return this.threads;
  }
}

export const store = new Store();
