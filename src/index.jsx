import api, { route, fetch } from "@forge/api";
import { Queue } from "@forge/events";
import Resolver from "@forge/resolver";

import { defaultSchema } from "@atlaskit/adf-schema/schema-default";
import { JSONTransformer } from "@atlaskit/editor-json-transformer";
import { MarkdownTransformer } from "@atlaskit/editor-markdown-transformer";

const RERUN_COMMAND_COMMENT = "mayil-ai rerun";
const queue = new Queue({ key: "queue-comment" });
const resolver = new Resolver();

resolver.define("event-listener", async ({ payload, context }) => {
  const { task_id, issue_id, attempt } = payload;
  console.log(`Checking status for ${task_id}, Attempt: ${attempt}`);

  const response = await fetch(
    process.env.SERVER_URL + `/get-results/${task_id}`,
  );
  const result = await response.json();

  if (result.status === "completed") {
    const mayil_response = result.result;
    let previous_comment_id = null;
    if ("previous_comment_id" in result) {
      previous_comment_id = result.previous_comment_id;
      console.log(`Previous comment id: ${previous_comment_id}`);
    }
    console.log(`Response from Mayil received`);

    const jsonTransformer = new JSONTransformer();
    const markdownTransformer = new MarkdownTransformer(defaultSchema);
    const translatedADF = jsonTransformer.encode(
      markdownTransformer.parse(mayil_response),
    );
    console.log(`ADF generated`);
    if (previous_comment_id != null) {
      await updateComment(issue_id, previous_comment_id, translatedADF);
      return;
    }
    const response_json = await addComment(issue_id, translatedADF);
    await fetch(process.env.SERVER_URL + "/jira/post_comment", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        task_id: task_id,
        comment_id: response_json.id,
      }),
      redirect: "follow",
    });
    console.log(`Comment added to ${issue_id}`);
  } else if (attempt < 10 && result.status !== "failed") {
    console.log(
      `Task: ${task_id} Status: ${
        result.status
      }. Retrying in 60 seconds. Attempt: ${attempt + 1}`,
    );
    await queue.push(
      { task_id: task_id, issue_id: issue_id, attempt: attempt + 1 },
      {
        delayInSeconds: 60,
      },
    );
  } else {
    console.log(
      `Task: ${task_id} Status: ${result.status}. Maximum attempts reached. Terminating retries.`,
    );
  }
});

export const handler = resolver.getDefinitions();

export async function run(event, context) {
  const eventType = event.eventType;
  const issueKey = event.issue.key;
  console.log(`Processing: ${issueKey}`);

  if (eventType === "avi:jira:created:issue") {
    console.log("Validated create issue event");
  } else if (eventType === "avi:jira:updated:issue") {
    const changeLog = event.changelog;
    console.log(`Change log: ${JSON.stringify(changeLog.items)}`);
    const relevantChange = changeLog.items.some((item) =>
      ["summary", "description", "Attachment"].includes(item.field),
    );

    if (relevantChange) {
      console.log(`Rerun requested for issue ${issueKey}`);
    } else {
      console.log("No relevant fields updated in issue. Ignoring.");
      return;
    }
  } else if (eventType === "avi:jira:commented:issue") {
    const comment = event.comment;
    console.log(`Comment: ${JSON.stringify(comment.body.content)}`);
    let commentBody = "";
    comment.body.content.forEach((paragraph) => {
      paragraph.content.forEach((textNode) => {
        if (textNode.hasOwnProperty("text")) {
          commentBody += textNode.text;
        }
      });
    });

    commentBody = commentBody
      .replace("@", "")
      .replace("`", "")
      .toLowerCase()
      .trim();

    if (commentBody.startsWith(RERUN_COMMAND_COMMENT)) {
      console.log("Rerun comment detected");
      await deleteComment(issueKey, comment.id);
    } else {
      console.log(`Not a rerun comment`);
      return;
    }
  } else {
    console.log(`Ignoring unsupported event type: ${eventType}`);
    return { success: false };
  }

  // Issue details need to be pulled again as the event payload does not contain the description
  const response = await api
    .asApp()
    .requestJira(route`/rest/api/3/issue/${issueKey}`);
  const issueDetails = await response.json();

  // get attachments if they are images
  const imageAttachments = issueDetails.fields.attachment.filter((attachment) =>
    attachment.mimeType.startsWith("image"),
  );
  // replace attachment content key with base64 encoded image
  for (let i = 0; i < imageAttachments.length; i++) {
    const attachment = imageAttachments[i];
    const requestUrl = route`/rest/api/3/attachment/content/${attachment.id}`;
    const attachmentResponse = await api.asApp().requestJira(requestUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });
    const attachmentContent = await attachmentResponse.buffer();
    const base64Content = attachmentContent.toString("base64");
    attachment.content = base64Content;
  }

  issueDetails.fields.attachment = imageAttachments;

  console.log(`Sending request to Mayil`);
  const triggerResponse = await fetch(
    process.env.SERVER_URL + "/jira/create_event",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(issueDetails),
      redirect: "follow",
    },
  );
  const { task_id } = await triggerResponse.json();
  console.log(`Adding task:${task_id} to queue`);
  // TODO: initially wait for 10 minutes
  await queue.push(
    { task_id: task_id, issue_id: issueKey, attempt: 0 },
    {
      delayInSeconds: 60 * 10,
    },
  );
}

async function updateComment(issueIdOrKey, commentId, adf) {
  const requestUrl = route`/rest/api/3/issue/${issueIdOrKey}/comment/${commentId}`;
  const body = {
    body: adf,
  };
  let response = await api.asApp().requestJira(requestUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (response.status !== 200) {
    console.log(response.status);
    throw `Unable to update comment to issue_id ${issueIdOrKey} Status: ${response.status}.`;
  }

  return response.json();
}

async function addComment(issueIdOrKey, adf = null, message = null) {
  /**
   * @issueIdOrKey - the Jira issue_id number or key for the issue that this function will try to add
   * a comment to (as per the Jira Rest API)
   * @message {string} - the message that will appear in the comment
   *
   * @example addComment('10050', 'Hello world')
   */

  // See https://developer.atlassian.com/cloud/jira/platform/rest/v3/#api-rest-api-3-issue-issueIdOrKey-comment-post
  const requestUrl = route`/rest/api/3/issue/${issueIdOrKey}/comment`;
  let body = null;
  if (message != null) {
    body = {
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              {
                text: message,
                type: "text",
              },
            ],
          },
        ],
      },
    };
  } else if (adf != null) {
    body = {
      body: adf,
    };
  } else {
    throw `No message or ADF provided`;
  }
  // Use the Forge Runtime API to fetch data from an HTTP server using your (the app developer) Authorization header
  let response = await api.asApp().requestJira(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // Error checking: the Jira issue comment Rest API returns a 201 if the request is successful
  if (response.status !== 201) {
    console.log(response.status);
    throw `Unable to add comment to issue_id ${issueIdOrKey} Status: ${response.status}.`;
  }

  return response.json();
}

async function deleteComment(issueIdOrKey, commentId) {
  const requestUrl = route`/rest/api/3/issue/${issueIdOrKey}/comment/${commentId}`;
  let response = await api.asApp().requestJira(requestUrl, {
    method: "DELETE",
  });

  if (response.status !== 204) {
    console.log(response.status);
    throw `Unable to delete comment to issue_id ${issueIdOrKey} Status: ${response.status}.`;
  }
}
