import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Attachment, Collection, Message } from "discord.js";
import { config } from "../config";
import { GitIssue, ProjectColumn, Thread } from "../interfaces";
import {
  ActionValue,
  Actions,
  Triggerer,
  getGithubUrl,
  logger,
} from "../logger";
import { store } from "../store";

export const octokit = new Octokit({
  authStrategy: createAppAuth,
  auth: {
    appId: config.GITHUB_APP_ID,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
    installationId: config.GITHUB_APP_INSTALLATION_ID,
  },
});

export const repoCredentials = {
  owner: config.GITHUB_OWNER,
  repo: config.GITHUB_REPOSITORY,
};

const info = (action: ActionValue, thread: Thread) =>
  logger.info(`${Triggerer.Discord} | ${action} | ${getGithubUrl(thread)}`);
const error = (action: ActionValue | string, thread?: Thread) =>
  logger.error(
    `${Triggerer.Discord} | ${action} ` +
      (thread ? `| ${getGithubUrl(thread)}` : ""),
  );

function attachmentsToMarkdown(attachments: Collection<string, Attachment>) {
  let md = "";
  attachments.forEach(({ url, name, contentType }) => {
    switch (contentType) {
      case "image/png":
      case "image/jpeg":
        md += `![${name}](${url} "${name}")`;
        break;
    }
  });
  return md;
}

function getIssueBody(params: Message) {
  const { guildId, channelId, id, content, author, attachments } = params;
  const displayName =
    author.globalName || author.displayName || author.username;
  const avatarUrl = author.avatar
    ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.webp?size=40`
    : `https://cdn.discordapp.com/embed/avatars/${Number(author.discriminator || 0) % 5}.png?size=40`;

  return (
    `<kbd>[![${displayName}](${avatarUrl})](https://discord.com/channels/${guildId}/${channelId}/${id})</kbd> [${displayName}](https://discord.com/channels/${guildId}/${channelId}/${id})  \`BOT\`\n\n` +
    `${content}\n` +
    `${attachmentsToMarkdown(attachments)}\n`
  );
}

const regexForDiscordCredentials =
  /https:\/\/discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)(?=\))/;
export function getDiscordInfoFromGithubBody(body: string | null | undefined) {
  if (!body) return { channelId: undefined, id: undefined };
  const match = body.match(regexForDiscordCredentials);
  if (!match || match.length !== 4)
    return { channelId: undefined, id: undefined };
  const [, , channelId, id] = match;
  return { channelId, id };
}

function formatIssuesToThreads(issues: GitIssue[]): Thread[] {
  const res: Thread[] = [];
  issues.forEach(({ title, body, number, node_id, locked, state }) => {
    const { id } = getDiscordInfoFromGithubBody(body);
    if (!id) return;
    res.push({
      id,
      title,
      number,
      body,
      node_id,
      locked,
      comments: [],
      appliedTags: [],
      archived: state === "closed",
    });
  });
  return res;
}

async function update(issue_number: number, state: "open" | "closed") {
  try {
    await octokit.rest.issues.update({
      ...repoCredentials,
      issue_number,
      state,
    });
    return true;
  } catch (err) {
    return err;
  }
}

export async function closeIssue(thread: Thread) {
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  const response = await update(issue_number, "closed");
  if (response === true) info(Actions.Closed, thread);
  else if (response instanceof Error)
    error(`Failed to close issue: ${response.message}`, thread);
  else error("Failed to close issue due to an unknown error", thread);
}

export async function openIssue(thread: Thread) {
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  const response = await update(issue_number, "open");
  if (response === true) info(Actions.Reopened, thread);
  else if (response instanceof Error)
    error(`Failed to open issue: ${response.message}`, thread);
  else error("Failed to open issue due to an unknown error", thread);
}

export async function lockIssue(thread: Thread) {
  const { number: issue_number } = thread;
  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    await octokit.rest.issues.lock({
      ...repoCredentials,
      issue_number,
    });

    info(Actions.Locked, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to lock issue: ${err.message}`, thread);
    } else {
      error("Failed to lock issue due to an unknown error", thread);
    }
  }
}

export async function unlockIssue(thread: Thread) {
  const { number: issue_number } = thread;
  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    await octokit.rest.issues.unlock({
      ...repoCredentials,
      issue_number,
    });

    info(Actions.Unlocked, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to unlock issue: ${err.message}`, thread);
    } else {
      error("Failed to unlock issue due to an unknown error", thread);
    }
  }
}

export async function createIssue(thread: Thread, params: Message) {
  const { title, number } = thread;
  const { appliedTags } = thread;

  if (number) {
    error("Thread already has an issue number", thread);
    return;
  }

  try {
    const body = getIssueBody(params);

    // Map opinionated Discord tags to GitHub label/type names
    const allTagNames = appliedTags
      .map((tagId) => {
        for (const [name, id] of store.tagMap.entries()) {
          if (id === tagId) return name;
        }
        return undefined;
      })
      .filter((name): name is string => name !== undefined);

    // Split into type tags (handled via native issue types) and label tags
    const typeNames = allTagNames.filter((n) => store.issueTypeMap.has(n));
    const labels = allTagNames.filter((n) => !store.issueTypeMap.has(n));

    const response = await octokit.rest.issues.create({
      ...repoCredentials,
      title,
      body,
      labels,
    });

    if (response && response.data) {
      thread.node_id = response.data.node_id;
      thread.body = response.data.body!;
      thread.number = response.data.number;
      info(Actions.Created, thread);

      // Set native issue type after creation
      for (const typeName of typeNames) {
        await setIssueType(thread, typeName);
      }
    } else {
      error("Failed to create issue - No response data", thread);
    }
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to create issue: ${err.message}`, thread);
    } else {
      error("Failed to create issue due to an unknown error", thread);
    }
  }
}

export async function createIssueComment(thread: Thread, params: Message) {
  const body = getIssueBody(params);
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    const response = await octokit.rest.issues.createComment({
      ...repoCredentials,
      issue_number: thread.number!,
      body,
    });
    if (response && response.data) {
      const git_id = response.data.id;
      const id = params.id;
      thread.comments.push({ id, git_id });
      info(Actions.Commented, thread);
    } else {
      error("Failed to create comment - No response data", thread);
    }
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to create comment: ${err.message}`, thread);
    } else {
      error("Failed to create comment due to an unknown error", thread);
    }
  }
}

export async function deleteIssue(thread: Thread) {
  const { node_id } = thread;
  if (!node_id) {
    error("Thread does not have a node ID", thread);
    return;
  }

  try {
    await octokit.graphql(
      `mutation {deleteIssue(input: {issueId: "${node_id}"}) {clientMutationId}}`,
    );
    info(Actions.Deleted, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Error deleting issue: ${err.message}`, thread);
    } else {
      error("Error deleting issue due to an unknown error", thread);
    }
  }
}

export async function deleteComment(thread: Thread, comment_id: number) {
  try {
    await octokit.rest.issues.deleteComment({
      ...repoCredentials,
      comment_id,
    });
    info(Actions.DeletedComment, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to delete comment: ${err.message}`, thread);
    } else {
      error("Failed to delete comment due to an unknown error", thread);
    }
  }
}

export async function addLabelsToIssue(thread: Thread, labels: string[]) {
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    await octokit.rest.issues.addLabels({
      ...repoCredentials,
      issue_number,
      labels,
    });

    labels.forEach(() => info(Actions.Tagged, thread));
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to add labels: ${err.message}`, thread);
    } else {
      error("Failed to add labels due to an unknown error", thread);
    }
  }
}

export async function removeLabelFromIssue(thread: Thread, label: string) {
  const { number: issue_number } = thread;

  if (!issue_number) {
    error("Thread does not have an issue number", thread);
    return;
  }

  try {
    await octokit.rest.issues.removeLabel({
      ...repoCredentials,
      issue_number,
      name: label,
    });

    info(Actions.Untagged, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to remove label: ${err.message}`, thread);
    } else {
      error("Failed to remove label due to an unknown error", thread);
    }
  }
}

export async function getIssue(issueNumber: number) {
  try {
    const response = await octokit.rest.issues.get({
      ...repoCredentials,
      issue_number: issueNumber,
    });
    return response.data;
  } catch (err) {
    if (
      err instanceof Error &&
      "status" in err &&
      (err as any).status === 404
    ) {
      return null;
    }
    error(
      `Failed to get issue #${issueNumber}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    return null;
  }
}

export async function getIssueComments(issueNumber: number) {
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      ...repoCredentials,
      issue_number: issueNumber,
      per_page: 100,
    });
    return comments;
  } catch (err) {
    error(
      `Failed to get comments for issue #${issueNumber}: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
    return [];
  }
}

export async function getIssues() {
  try {
    // Must paginate: the default page size is 30, so on any repository with
    // more issues than that the older thread-to-issue links are never loaded
    // and every handler that looks a thread up in the store silently no-ops.
    const issues = await octokit.paginate(octokit.rest.issues.listForRepo, {
      ...repoCredentials,
      state: "all",
      per_page: 100,
    });

    const threads = formatIssuesToThreads(issues as GitIssue[]);
    await fillCommentsData(threads);

    logger.info(
      `Issues: ${issues.length} fetched, ${threads.length} carry a Discord link`,
    );
    return threads;
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to get issues: ${err.message}`);
    } else {
      error("Failed to get issues due to an unknown error");
    }
    return [];
  }
}

// Takes the threads explicitly rather than reading store.threads: the caller
// assigns the store only after getIssues() resolves, so on startup this used to
// match every comment against an empty array and record nothing.
async function fillCommentsData(threads: Thread[]) {
  try {
    const comments = await octokit.paginate(
      octokit.rest.issues.listCommentsForRepo,
      { ...repoCredentials, per_page: 100 },
    );

    for (const comment of comments) {
      const { channelId, id } = getDiscordInfoFromGithubBody(comment.body);
      if (!channelId || !id) continue;

      const thread = threads.find((i) => i.id === channelId);
      thread?.comments.push({ id, git_id: comment.id });
    }
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to load comments: ${err.message}`);
    } else {
      error("Failed to load comments due to an unknown error");
    }
  }
}

export async function discoverIssueTypes(): Promise<void> {
  try {
    const result: any = await octokit.graphql(
      `query($owner: String!) {
        organization(login: $owner) {
          issueTypes(first: 100) {
            nodes {
              id
              name
            }
          }
        }
      }`,
      {
        owner: config.GITHUB_OWNER,
        headers: { "GraphQL-Features": "issue_types" },
      },
    );

    const types = result.organization?.issueTypes?.nodes;
    if (!types || types.length === 0) {
      logger.warn("Issue types: No issue types found for organization.");
      return;
    }

    store.issueTypeMap.clear();
    for (const t of types) {
      store.issueTypeMap.set(t.name, t.id);
    }

    logger.info(
      `Issue types: Discovered ${store.issueTypeMap.size} types (${[...store.issueTypeMap.keys()].join(", ")})`,
    );
  } catch (err) {
    logger.error(
      `Issue types: Failed to discover issue types: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
}

export async function setIssueType(thread: Thread, typeName: string) {
  const { node_id } = thread;
  if (!node_id) {
    error("Thread does not have a node ID", thread);
    return;
  }

  const issueTypeId = store.issueTypeMap.get(typeName);
  if (!issueTypeId) {
    error(`No issue type ID found for "${typeName}"`, thread);
    return;
  }

  try {
    await octokit.graphql(
      `mutation($issueId: ID!, $issueTypeId: ID!) {
        updateIssueIssueType(input: { issueId: $issueId, issueTypeId: $issueTypeId }) {
          issue { issueType { name } }
        }
      }`,
      {
        issueId: node_id,
        issueTypeId,
        headers: { "GraphQL-Features": "issue_types" },
      },
    );

    info(Actions.Tagged, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to set issue type: ${err.message}`, thread);
    } else {
      error("Failed to set issue type due to an unknown error", thread);
    }
  }
}

export async function clearIssueType(thread: Thread) {
  const { node_id } = thread;
  if (!node_id) {
    error("Thread does not have a node ID", thread);
    return;
  }

  try {
    await octokit.graphql(
      `mutation($issueId: ID!) {
        updateIssueIssueType(input: { issueId: $issueId, issueTypeId: null }) {
          issue { issueType { name } }
        }
      }`,
      {
        issueId: node_id,
        headers: { "GraphQL-Features": "issue_types" },
      },
    );

    info(Actions.Untagged, thread);
  } catch (err) {
    if (err instanceof Error) {
      error(`Failed to clear issue type: ${err.message}`, thread);
    } else {
      error("Failed to clear issue type due to an unknown error", thread);
    }
  }
}

/** Shape of the projectsV2 nodes returned by the discovery query below. */
interface ProjectV2Node {
  id: string;
  title: string;
  number: number;
  closed?: boolean;
  fields?: {
    nodes?: {
      id?: string;
      name?: string;
      options?: { id: string; name: string; color?: string }[];
    }[];
  };
}

export async function discoverProject(): Promise<{
  projectId: string;
  projectTitle: string;
  statusFieldId: string;
  columns: ProjectColumn[];
} | null> {
  try {
    const result: any = await octokit.graphql(
      `query($owner: String!, $repo: String!) {
        repository(owner: $owner, name: $repo) {
          projectsV2(first: 20) {
            nodes {
              id
              title
              number
              closed
              fields(first: 50) {
                nodes {
                  ... on ProjectV2SingleSelectField {
                    id
                    name
                    options {
                      id
                      name
                      color
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      {
        owner: config.GITHUB_OWNER,
        repo: config.GITHUB_REPOSITORY,
      },
    );

    const nodes: ProjectV2Node[] = result.repository?.projectsV2?.nodes ?? [];
    if (nodes.length === 0) {
      logger.warn(
        "Kanban: No GitHub Project found for repository. Kanban sync disabled.",
      );
      return null;
    }

    const hasStatusField = (p: ProjectV2Node) =>
      p?.fields?.nodes?.some(
        (f) => f?.name?.toLowerCase() === "status" && f.options,
      );

    // Selecting by number is the only stable option: the API returns linked
    // projects in a server-defined order, so "the first one" is arbitrary as
    // soon as a repository has more than one project.
    const pinned = config.GITHUB_PROJECT_NUMBER;
    const project = pinned
      ? nodes.find((p) => p?.number === pinned)
      : nodes.find((p) => !p?.closed && hasStatusField(p));

    if (!project) {
      const available = nodes
        .map((p) => `#${p?.number} "${p?.title}"`)
        .join(", ");
      logger.warn(
        pinned
          ? `Kanban: Project #${pinned} is not linked to this repository. Linked projects: ${available}. Kanban sync disabled.`
          : `Kanban: No open project with a Status field found. Linked projects: ${available}. Kanban sync disabled.`,
      );
      return null;
    }

    if (!pinned && nodes.length > 1) {
      logger.warn(
        `Kanban: ${nodes.length} projects are linked to this repository and GITHUB_PROJECT_NUMBER is not set. ` +
          `Auto-selected #${project.number} "${project.title}"; set GITHUB_PROJECT_NUMBER to pin a specific one.`,
      );
    }

    const { id: projectId, title, number: projectNumber } = project;

    const statusField = project.fields?.nodes?.find(
      (f) => f?.name?.toLowerCase() === "status" && f.options,
    );
    // A non-single-select field comes back as {} from the inline fragment, so
    // id and options are only guaranteed once the Status field is identified.
    if (!statusField?.id || !statusField.options) {
      logger.warn(
        "Kanban: No Status field found in project. Kanban sync disabled.",
      );
      return null;
    }

    const columns: ProjectColumn[] = statusField.options.map((opt) => ({
      id: opt.id,
      name: opt.name,
      ...(opt.color && { color: opt.color }),
    }));

    logger.info(
      `Kanban: Using project "${title}" (#${projectNumber}) with ${columns.length} status columns`,
    );

    return {
      projectId,
      projectTitle: title,
      statusFieldId: statusField.id,
      columns,
    };
  } catch (err) {
    if (
      err instanceof Error &&
      err.message.includes("Resource not accessible")
    ) {
      logger.warn(
        "Kanban: GitHub token may need 'read:project' scope. Kanban sync disabled.",
      );
    } else {
      logger.error(
        `Kanban: Failed to discover project: ${err instanceof Error ? err.message : "Unknown error"}`,
      );
    }
    return null;
  }
}
