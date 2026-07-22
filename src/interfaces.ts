import { Request } from "express";

interface Thread {
  id: string;
  title: string;
  appliedTags: string[];
  number?: number;
  body?: string;
  node_id?: string;
  comments: ThreadComment[];
  archived: boolean | null;
  locked: boolean | null;
  lockArchiving?: boolean;
  lockLocking?: boolean;
  lockTagging?: boolean;
  lockLabeling?: boolean;
  lockBoard?: boolean;
}

interface ThreadComment {
  id: string;
  git_id: number;
}

interface GitIssue {
  title: string;
  body: string;
  number: number;
  node_id: string;
  locked: boolean;
  state: "open" | "closed";
}

// eslint-disable-next-line no-unused-vars
type GithubHandlerFunction = (req: Request) => Promise<void>;

interface ProjectColumn {
  id: string;
  name: string;
  color?: string; // GitHub Project column color enum (e.g., "GREEN", "BLUE")
}

export {
  Thread,
  ThreadComment,
  GitIssue,
  GithubHandlerFunction,
  ProjectColumn,
};
