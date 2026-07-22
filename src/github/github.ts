import crypto from "crypto";
import express from "express";
import { config } from "../config";
import { GithubHandlerFunction } from "../interfaces";
import { logger } from "../logger";
import {
  handleAssigned,
  handleClosed,
  handleCreated,
  handleDeleted,
  handleDemilestoned,
  handleEdited,
  handleLabeled,
  handleLocked,
  handleMilestoned,
  handleOpened,
  handleProjectItemEdited,
  handlePullRequestEdited,
  handlePullRequestMerged,
  handlePullRequestOpened,
  handleReopened,
  handleTransferred,
  handleTyped,
  handleUnassigned,
  handleUnlabeled,
  handleUnlocked,
  handleUntyped,
} from "./githubHandlers";

const app = express();
// Keep the raw bytes GitHub sent: the HMAC must be computed over the exact
// payload, not over a re-serialization of a parsed object. The body is parsed
// manually in the webhook route once the signature checks out.
// Limit is well above real GitHub deliveries while bounding how much an
// unauthenticated caller can make us buffer (the signature can only be checked
// after the whole body is read).
app.use(express.raw({ type: "application/json", limit: "5mb" }));

// Deduplication cache for GitHub webhook deliveries.
// Prevents processing the same event twice when GitHub retries or sends duplicates.
const DELIVERY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const recentDeliveries = new Map<string, number>();

function isDuplicateDelivery(deliveryId: string | undefined): boolean {
  if (!deliveryId) return false; // If no delivery ID, allow through (don't block)

  const now = Date.now();

  // Prune expired entries periodically (when cache exceeds 100 entries)
  if (recentDeliveries.size > 100) {
    for (const [id, timestamp] of recentDeliveries) {
      if (now - timestamp > DELIVERY_CACHE_TTL_MS) {
        recentDeliveries.delete(id);
      }
    }
  }

  if (recentDeliveries.has(deliveryId)) {
    return true; // Already processed
  }

  recentDeliveries.set(deliveryId, now);
  return false;
}

function verifySignature(
  payload: Buffer,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected =
    "sha256=" +
    crypto
      .createHmac("sha256", config.GITHUB_WEBHOOK_SECRET)
      .update(payload)
      .digest("hex");

  const received = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  // timingSafeEqual throws RangeError unless both buffers are the same length,
  // so a malformed header must be rejected before the comparison.
  if (received.length !== expectedBuffer.length) return false;
  return crypto.timingSafeEqual(received, expectedBuffer);
}

export function initGithub() {
  app.get("", (_, res) => {
    res.json({ msg: "github webhooks work" });
  });

  const githubHandlers: {
    [key: string]: GithubHandlerFunction;
  } = {
    "issues.opened": (req) => handleOpened(req),
    "issues.closed": (req) => handleClosed(req),
    "issues.reopened": (req) => handleReopened(req),
    "issues.locked": (req) => handleLocked(req),
    "issues.unlocked": (req) => handleUnlocked(req),
    "issues.deleted": (req) => handleDeleted(req),
    "issues.labeled": (req) => handleLabeled(req),
    "issues.unlabeled": (req) => handleUnlabeled(req),
    "issues.typed": (req) => handleTyped(req),
    "issues.untyped": (req) => handleUntyped(req),
    "issues.assigned": (req) => handleAssigned(req),
    "issues.unassigned": (req) => handleUnassigned(req),
    "issues.milestoned": (req) => handleMilestoned(req),
    "issues.demilestoned": (req) => handleDemilestoned(req),
    "issues.transferred": (req) => handleTransferred(req),
    "issues.edited": (req) => handleEdited(req),
    "issue_comment.created": (req) => handleCreated(req),
    "pull_request.opened": (req) => handlePullRequestOpened(req),
    "pull_request.edited": (req) => handlePullRequestEdited(req),
    "pull_request.closed": (req) => handlePullRequestMerged(req),
    "projects_v2_item.edited": (req) => handleProjectItemEdited(req),
  };

  app.post("/", async (req, res) => {
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = req.body;

    if (!Buffer.isBuffer(rawBody) || !verifySignature(rawBody, signature)) {
      res.status(401).json({ msg: "invalid signature" });
      return;
    }

    try {
      req.body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      res.status(400).json({ msg: "invalid json" });
      return;
    }

    // Deduplicate webhook deliveries using GitHub's unique delivery ID
    const deliveryId = req.headers["x-github-delivery"] as string | undefined;
    if (isDuplicateDelivery(deliveryId)) {
      logger.warn(`Duplicate webhook delivery skipped: ${deliveryId}`);
      res.json({ msg: "duplicate" });
      return;
    }

    const event = req.headers["x-github-event"] as string;
    const action = req.body.action as string;
    const key = `${event}.${action}`;
    const handler = githubHandlers[key];
    if (handler) {
      handler(req).catch((err) =>
        logger.error(
          `Webhook ${key} handler error: ${err instanceof Error ? err.message : "Unknown error"}`,
        ),
      );
    } else {
      logger.info(`Unhandled webhook event: ${key}`);
    }
    res.json({ msg: "ok" });
  });

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
}

export default app;
