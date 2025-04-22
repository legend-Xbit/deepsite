import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import cookieParser from "cookie-parser";
import {
  createRepo,
  uploadFiles,
  whoAmI,
  spaceInfo,
  fileExists,
} from "@huggingface/hub";
import { InferenceClient } from "@huggingface/inference";
import bodyParser from "body-parser";
import { diff_match_patch } from "diff-match-patch"; // Using a library for robustness

import checkUser from "./middlewares/checkUser.js";
import { PROVIDERS } from "./utils/providers.js";
import { COLORS } from "./utils/colors.js";

// Load environment variables from .env file
dotenv.config();

const app = express();

const ipAddresses = new Map();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.APP_PORT || 3000;
const REDIRECT_URI =
  process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/login`;
const MODEL_ID = "deepseek-ai/DeepSeek-V3-0324";
const MAX_REQUESTS_PER_IP = 1000;

app.use(cookieParser());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "dist")));

const getPTag = (repoId) => {
  return `<p style="border-radius: 8px; text-align: center; font-size: 12px; color: #fff; margin-top: 16px;position: fixed; left: 8px; bottom: 8px; z-index: 10; background: rgba(0, 0, 0, 0.8); padding: 4px 8px;">Made with <img src="https://enzostvs-deepsite.hf.space/logo.svg" alt="DeepSite Logo" style="width: 16px; height: 16px; vertical-align: middle;display:inline-block;margin-right:3px;filter:brightness(0) invert(1);"><a href="https://enzostvs-deepsite.hf.space" style="color: #fff;text-decoration: underline;" target="_blank" >DeepSite</a> - 🧬 <a href="https://enzostvs-deepsite.hf.space?remix=${repoId}" style="color: #fff;text-decoration: underline;" target="_blank" >Remix</a></p>`;
};

app.get("/api/login", (_req, res) => {
  const redirectUrl = `https://huggingface.co/oauth/authorize?client_id=${process.env.OAUTH_CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=openid%20profile%20write-repos%20manage-repos%20inference-api&prompt=consent&state=1234567890`;
  res.status(200).send({
    ok: true,
    redirectUrl,
  });
});
app.get("/auth/login", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect(302, "/");
  }
  const Authorization = `Basic ${Buffer.from(
    `${process.env.OAUTH_CLIENT_ID}:${process.env.OAUTH_CLIENT_SECRET}`
  ).toString("base64")}`;

  const request_auth = await fetch("https://huggingface.co/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const response = await request_auth.json();

  if (!response.access_token) {
    return res.redirect(302, "/");
  }

  res.cookie("hf_token", response.access_token, {
    httpOnly: false,
    secure: true,
    sameSite: "none",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });

  return res.redirect(302, "/");
});
app.get("/auth/logout", (req, res) => {
  res.clearCookie("hf_token", {
    httpOnly: false,
    secure: true,
    sameSite: "none",
  });
  return res.redirect(302, "/");
});

app.get("/api/@me", checkUser, async (req, res) => {
  let { hf_token } = req.cookies;

  if (process.env.HF_TOKEN && process.env.HF_TOKEN !== "") {
    return res.send({
      preferred_username: "local-use",
      isLocalUse: true,
    });
  }

  try {
    const request_user = await fetch("https://huggingface.co/oauth/userinfo", {
      headers: {
        Authorization: `Bearer ${hf_token}`,
      },
    });

    const user = await request_user.json();
    res.send(user);
  } catch (err) {
    res.clearCookie("hf_token", {
      httpOnly: false,
      secure: true,
      sameSite: "none",
    });
    res.status(401).send({
      ok: false,
      message: err.message,
    });
  }
});

app.post("/api/deploy", checkUser, async (req, res) => {
  const { html, title, path, prompts } = req.body;
  if (!html || (!path && !title)) {
    return res.status(400).send({
      ok: false,
      message: "Missing required fields",
    });
  }

  let { hf_token } = req.cookies;
  if (process.env.HF_TOKEN && process.env.HF_TOKEN !== "") {
    hf_token = process.env.HF_TOKEN;
  }

  try {
    const repo = {
      type: "space",
      name: path ?? "",
    };

    let readme;
    let newHtml = html;

    if (!path || path === "") {
      const { name: username } = await whoAmI({ accessToken: hf_token });
      const newTitle = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .split("-")
        .filter(Boolean)
        .join("-")
        .slice(0, 96);

      const repoId = `${username}/${newTitle}`;
      repo.name = repoId;

      await createRepo({
        repo,
        accessToken: hf_token,
      });
      const colorFrom = COLORS[Math.floor(Math.random() * COLORS.length)];
      const colorTo = COLORS[Math.floor(Math.random() * COLORS.length)];
      readme = `---
title: ${newTitle}
emoji: 🐳
colorFrom: ${colorFrom}
colorTo: ${colorTo}
sdk: static
pinned: false
tags:
  - deepsite
---

Check out the configuration reference at https://huggingface.co/docs/hub/spaces-config-reference`;
    }

    newHtml = html.replace(/<\/body>/, `${getPTag(repo.name)}</body>`);
    const file = new Blob([newHtml], { type: "text/html" });
    file.name = "index.html"; // Add name property to the Blob

    // create prompt.txt file with all the prompts used, split by new line
    const newPrompts = ``.concat(prompts.map((prompt) => prompt).join("\n"));
    const promptFile = new Blob([newPrompts], { type: "text/plain" });
    promptFile.name = "prompts.txt"; // Add name property to the Blob

    const files = [file, promptFile];
    if (readme) {
      const readmeFile = new Blob([readme], { type: "text/markdown" });
      readmeFile.name = "README.md"; // Add name property to the Blob
      files.push(readmeFile);
    }
    await uploadFiles({
      repo,
      files,
      accessToken: hf_token,
    });
    return res.status(200).send({ ok: true, path: repo.name });
  } catch (err) {
    return res.status(500).send({
      ok: false,
      message: err.message,
    });
  }
});

// --- Diff Parsing and Applying Logic ---

const SEARCH_START = "<<<<<<< SEARCH";
const DIVIDER = "=======";
const REPLACE_END = ">>>>>>> REPLACE";

/**
 * Parses AI response content for SEARCH/REPLACE blocks.
 * @param {string} content - The AI response content.
 * @returns {Array<{original: string, updated: string}>} - Array of diff blocks.
 */
function parseDiffBlocks(content) {
  const blocks = [];
  const lines = content.split("\n");
  let i = 0;
  while (i < lines.length) {
    // Trim lines for comparison to handle potential trailing whitespace from AI
    if (lines[i].trim() === SEARCH_START) {
      const originalLines = [];
      const updatedLines = [];
      i++; // Move past SEARCH_START
      while (i < lines.length && lines[i].trim() !== DIVIDER) {
        originalLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length || lines[i].trim() !== DIVIDER) {
        console.warn(
          "Malformed diff block: Missing or misplaced '=======' after SEARCH block. Block content:",
          originalLines.join("\n")
        );
        // Skip to next potential block start or end
        while (i < lines.length && !lines[i].includes(SEARCH_START)) i++;
        continue;
      }
      i++; // Move past DIVIDER
      while (i < lines.length && lines[i].trim() !== REPLACE_END) {
        updatedLines.push(lines[i]);
        i++;
      }
      if (i >= lines.length || lines[i].trim() !== REPLACE_END) {
        console.warn(
          "Malformed diff block: Missing or misplaced '>>>>>>> REPLACE' after REPLACE block. Block content:",
          updatedLines.join("\n")
        );
        // Skip to next potential block start or end
        while (i < lines.length && !lines[i].includes(SEARCH_START)) i++;
        continue;
      }
      // Important: Re-add newline characters lost during split('\n')
      // Only add trailing newline if it wasn't the *very last* line of the block content before split
      const originalText = originalLines.join("\n");
      const updatedText = updatedLines.join("\n");

      blocks.push({
        original: originalText, // Don't add trailing newline here, handle in apply
        updated: updatedText,
      });
    }
    i++;
  }
  return blocks;
}

/**
 * Applies a single diff block to the current HTML content using diff-match-patch.
 * @param {string} currentHtml - The current HTML content.
 * @param {string} originalBlock - The content from the SEARCH block.
 * @param {string} updatedBlock - The content from the REPLACE block.
 * @returns {string | null} - The updated HTML content, or null if patching failed.
 */
function applySingleDiffFuzzy(currentHtml, originalBlock, updatedBlock) {
  const dmp = new diff_match_patch();

  // Handle potential trailing newline inconsistencies between AI and actual file
  // If originalBlock doesn't end with newline but exists in currentHtml *with* one, add it.
  let searchBlock = originalBlock;
  if (
    !originalBlock.endsWith("\n") &&
    currentHtml.includes(originalBlock + "\n")
  ) {
    searchBlock = originalBlock + "\n";
  }
  // If updatedBlock is meant to replace a block ending in newline, ensure it also does (unless empty)
  let replaceBlock = updatedBlock;
  if (
    searchBlock.endsWith("\n") &&
    updatedBlock.length > 0 &&
    !updatedBlock.endsWith("\n")
  ) {
    replaceBlock = updatedBlock + "\n";
  }
  // If deleting a block ending in newline, the replacement is empty
  if (searchBlock.endsWith("\n") && updatedBlock.length === 0) {
    replaceBlock = "";
  }

  // 1. Create a patch from the (potentially adjusted) original and updated blocks
  const patchText = dmp.patch_make(searchBlock, replaceBlock);

  // 2. Apply the patch to the current HTML
  //    diff-match-patch is good at finding the location even with slight context variations.
  //    Increase Match_Threshold for potentially larger files or more significant context drift.
  dmp.Match_Threshold = 0.6; // Adjust as needed (0.0 to 1.0)
  dmp.Patch_DeleteThreshold = 0.6; // Adjust as needed
  const [patchedHtml, results] = dmp.patch_apply(patchText, currentHtml);

  // 3. Check if the patch applied successfully
  if (results.every((result) => result === true)) {
    return patchedHtml;
  } else {
    console.warn(
      "Patch application failed using diff-match-patch. Results:",
      results
    );
    // Fallback: Try exact string replacement (less robust)
    if (currentHtml.includes(searchBlock)) {
      console.log("Falling back to direct string replacement.");
      // Use replace only once
      const index = currentHtml.indexOf(searchBlock);
      if (index !== -1) {
        return (
          currentHtml.substring(0, index) +
          replaceBlock +
          currentHtml.substring(index + searchBlock.length)
        );
      }
    }
    console.error("Direct string replacement fallback also failed.");
    return null; // Indicate failure
  }
}

/**
 * Applies all parsed diff blocks sequentially to the original HTML.
 * @param {string} originalHtml - The initial HTML content.
 * @param {string} aiResponseContent - The full response from the AI containing diff blocks.
 * @returns {string} - The final modified HTML.
 * @throws {Error} If any diff block fails to apply.
 */
function applyDiffs(originalHtml, aiResponseContent) {
  const diffBlocks = parseDiffBlocks(aiResponseContent);

  if (diffBlocks.length === 0) {
    console.warn("AI response did not contain valid SEARCH/REPLACE blocks.");
    // Check if the AI *tried* to use the format but failed, or just gave full code
    if (
      aiResponseContent.includes(SEARCH_START) ||
      aiResponseContent.includes(DIVIDER) ||
      aiResponseContent.includes(REPLACE_END)
    ) {
      throw new Error(
        "AI response contained malformed or unparseable diff blocks. Could not apply changes."
      );
    }
    // If no diff blocks *at all*, maybe the AI ignored the instruction and gave full code?
    // Heuristic: If the response looks like a full HTML doc, use it directly.
    const trimmedResponse = aiResponseContent.trim().toLowerCase();
    if (
      trimmedResponse.startsWith("<!doctype html") ||
      trimmedResponse.startsWith("<html")
    ) {
      console.warn(
        "[Diff Apply] AI response seems to be full HTML despite diff instructions. Using full response as fallback."
      );
      return aiResponseContent;
    }
    console.warn(
      "[Diff Apply] No valid diff blocks found and response doesn't look like full HTML. Returning original HTML."
    );
    return originalHtml; // Return original if no diffs and not full HTML
  }

  console.log(`Found ${diffBlocks.length} diff blocks to apply.`);
  let currentHtml = originalHtml;
  for (let i = 0; i < diffBlocks.length; i++) {
    const { original, updated } = diffBlocks[i];
    console.log(`Applying block ${i + 1}...`);
    const result = applySingleDiffFuzzy(currentHtml, original, updated);

    if (result === null) {
      // Log detailed error for debugging
      console.error(`Failed to apply diff block ${i + 1}:`);
      console.error("--- SEARCH ---");
      console.error(original);
      console.error("--- REPLACE ---");
      console.error(updated);
      console.error("--- CURRENT CONTEXT (approx) ---");
      // Try finding the first line of the original block for context
      const firstLine = original.split("\n")[0];
      let contextIndex = -1;
      if (firstLine) {
        contextIndex = currentHtml.indexOf(firstLine);
      }
      if (contextIndex === -1) {
        // If first line not found, maybe try middle line?
        const lines = original.split("\n");
        if (lines.length > 2) {
          contextIndex = currentHtml.indexOf(
            lines[Math.floor(lines.length / 2)]
          );
        }
      }
      if (contextIndex === -1) {
        // Still not found, just show start
        contextIndex = 0;
      }

      console.error(
        currentHtml.substring(
          Math.max(0, contextIndex - 150),
          Math.min(currentHtml.length, contextIndex + original.length + 300)
        )
      );
      console.error("---------------------------------");

      throw new Error(
        `Failed to apply AI-suggested change ${
          i + 1
        }. The 'SEARCH' block might not accurately match the current code.`
      );
    }
    currentHtml = result;
  }

  console.log("All diff blocks applied successfully.");
  return currentHtml;
}

// --- Endpoint to Apply Diffs Server-Side ---
app.post("/api/apply-diffs", (req, res) => {
  const { originalHtml, aiResponseContent } = req.body;

  if (
    typeof originalHtml !== "string" ||
    typeof aiResponseContent !== "string"
  ) {
    return res.status(400).json({
      ok: false,
      message: "Missing or invalid originalHtml or aiResponseContent.",
    });
  }

  try {
    console.log("[Apply Diffs] Received request to apply diffs.");
    const modifiedHtml = applyDiffs(originalHtml, aiResponseContent);
    console.log("[Apply Diffs] Diffs applied successfully.");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(modifiedHtml);
  } catch (error) {
    console.error("[Apply Diffs] Error applying diffs:", error);
    res.status(400).json({
      // Use 400 for client-side correctable errors (bad diff format)
      ok: false,
      message: error.message || "Failed to apply AI suggestions.",
    });
  }
});

app.post("/api/ask-ai", async (req, res) => {
  const { prompt, html, previousPrompt, provider } = req.body;
  if (!prompt) {
    return res.status(400).send({
      ok: false,
      message: "Missing required fields",
    });
  }

  let { hf_token } = req.cookies;
  let token = hf_token;

  if (process.env.HF_TOKEN && process.env.HF_TOKEN !== "") {
    token = process.env.HF_TOKEN;
  }

  const isFollowUp = !!html;
  console.log(`[AI Request] Type: ${isFollowUp ? "Follow-up" : "Initial"}`);

  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["x-real-ip"] ||
    req.socket.remoteAddress ||
    req.ip ||
    "0.0.0.0";

  if (!hf_token) {
    ipAddresses.set(ip, (ipAddresses.get(ip) || 0) + 1);
    if (ipAddresses.get(ip) > MAX_REQUESTS_PER_IP) {
      return res.status(429).send({
        ok: false,
        openLogin: true,
        message: "Log In to continue using the service",
      });
    }

    token = process.env.DEFAULT_HF_TOKEN;
  }

  // --- Define System Prompts ---
  const initialSystemPrompt = `ONLY USE HTML, CSS AND JAVASCRIPT. If you want to use ICON make sure to import the library first. Try to create the best UI possible by using only HTML, CSS and JAVASCRIPT. Also, try to ellaborate as much as you can, to create something unique. If needed you are allowed to use tailwincss (if so make sure to import <script src="https://cdn.tailwindcss.com"></script> in the head). ALWAYS GIVE THE RESPONSE INTO A SINGLE HTML FILE.`;
  const followUpSystemPrompt = `You are an expert web developer modifying an existing HTML file.
The user wants to apply changes based on their request.
You MUST output ONLY the changes required using the following SEARCH/REPLACE block format. Do NOT output the entire file.
Explain the changes briefly *before* the blocks if necessary, but the code changes THEMSELVES MUST be within the blocks.
Format Rules:
1. Start with ${SEARCH_START}
2. Provide the exact lines from the current code that need to be replaced.
3. Use ${DIVIDER} to separate the search block from the replacement.
4. Provide the new lines that should replace the original lines.
5. End with ${REPLACE_END}
6. You can use multiple SEARCH/REPLACE blocks if changes are needed in different parts of the file.
7. To insert code, use an empty SEARCH block (only ${SEARCH_START} and ${DIVIDER} on their lines) if inserting at the very beginning, otherwise provide the line *before* the insertion point in the SEARCH block and include that line plus the new lines in the REPLACE block.
8. To delete code, provide the lines to delete in the SEARCH block and leave the REPLACE block empty (only ${DIVIDER} and ${REPLACE_END} on their lines).
9. IMPORTANT: The SEARCH block must *exactly* match the current code, including indentation and whitespace.
Example Modifying Code:
\`\`\`
Some explanation...
${SEARCH_START}
    <h1>Old Title</h1>
${DIVIDER}
    <h1>New Title</h1>
${REPLACE_END}
${SEARCH_START}
  </body>
${DIVIDER}
    <script>console.log("Added script");</script>
  </body>
${REPLACE_END}
\`\`\`
Example Deleting Code:
\`\`\`
Removing the paragraph...
${SEARCH_START}
  <p>This paragraph will be deleted.</p>
${DIVIDER}
${REPLACE_END}
\`\`\`
ONLY output the changes in this format. Do NOT output the full HTML file again.`;

  // --- Prepare Messages for AI ---
  const systemPromptContent = isFollowUp
    ? followUpSystemPrompt
    : initialSystemPrompt;
  console.log(
    `[AI Request] Using system prompt: ${
      isFollowUp ? "Follow-up (Diff)" : "Initial (Full HTML)"
    }`
  );

  const client = new InferenceClient(token);
  let completeResponse = "";

  let TOKENS_USED = prompt?.length;
  if (previousPrompt) TOKENS_USED += previousPrompt.length;
  if (html) TOKENS_USED += html.length;

  const DEFAULT_PROVIDER = PROVIDERS.novita;
  const selectedProvider =
    provider === "auto"
      ? DEFAULT_PROVIDER
      : PROVIDERS[provider] ?? DEFAULT_PROVIDER;

  if (provider !== "auto" && TOKENS_USED >= selectedProvider.max_tokens) {
    return res.status(400).send({
      ok: false,
      openSelectProvider: true,
      message: `Context is too long. ${selectedProvider.name} allow ${selectedProvider.max_tokens} max tokens.`,
    });
  }

  const messages = [
    {
      role: "system",
      content: systemPromptContent,
    },
    ...(previousPrompt ? [{ role: "user", content: previousPrompt }] : []),
    ...(isFollowUp
      ? [
          {
            role: "assistant",
            content: `Okay, I have the current code. It is:\n\`\`\`html\n${html}\n\`\`\``,
          },
        ]
      : []),
    { role: "user", content: prompt },
  ];

  try {
    res.setHeader("Content-Type", "text/plain; charset=utf-8"); // Stream raw text
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Response-Type", isFollowUp ? "diff" : "full"); // Signal type to client

    const chatCompletion = client.chatCompletionStream({
      model: MODEL_ID,
      provider: selectedProvider.id,
      messages,
      ...(selectedProvider.id !== "sambanova"
        ? {
            max_tokens: selectedProvider.max_tokens,
          }
        : {}),
      temperature: isFollowUp ? 0 : undefined,
    });

    console.log("[AI Request] Starting stream to client...");
    // while (true) {
    //   const { done, value } = await chatCompletion.next();
    //   if (done) {
    //     break;
    //   }
    //   const chunk = value.choices[0]?.delta?.content;
    //   if (chunk) {
    //     if (provider !== "sambanova") {
    //       res.write(chunk);
    //       completeResponse += chunk;

    //       if (completeResponse.includes("</html>")) {
    //         break;
    //       }
    //     } else {
    //       let newChunk = chunk;
    //       if (chunk.includes("</html>")) {
    //         // Replace everything after the last </html> tag with an empty string
    //         newChunk = newChunk.replace(/<\/html>[\s\S]*/, "</html>");
    //       }
    //       completeResponse += newChunk;
    //       res.write(newChunk);
    //       if (newChunk.includes("</html>")) {
    //         break;
    //       }
    //     }
    //   }
    // }
    for await (const value of chatCompletion) {
      const chunk = value.choices[0]?.delta?.content;
      if (chunk) {
        res.write(chunk); // Stream raw AI response chunk
        completeResponse += chunk; // Accumulate for logging completion
      }
    }
    console.log("[AI Request] Stream finished.");
    res.end();
  } catch (error) {
    if (error.message.includes("exceeded your monthly included credits")) {
      return res.status(402).send({
        ok: false,
        openProModal: true,
        message: error.message,
      });
    }
    if (!res.headersSent) {
      res.status(500).send({
        ok: false,
        message: `Error processing AI request: ${error.message}. You might need to start a new conversation by refreshing the page.`,
      });
    } else {
      // Otherwise end the stream
      res.end();
    }
  }
});

app.get("/api/remix/:username/:repo", async (req, res) => {
  const { username, repo } = req.params;
  const { hf_token } = req.cookies;

  let token = hf_token || process.env.DEFAULT_HF_TOKEN;

  if (process.env.HF_TOKEN && process.env.HF_TOKEN !== "") {
    token = process.env.HF_TOKEN;
  }

  const repoId = `${username}/${repo}`;

  const url = `https://huggingface.co/spaces/${repoId}/raw/main/index.html`;
  try {
    const space = await spaceInfo({
      name: repoId,
      accessToken: token,
      additionalFields: ["author"],
    });

    if (!space || space.sdk !== "static" || space.private) {
      return res.status(404).send({
        ok: false,
        message: "Space not found",
      });
    }

    const response = await fetch(url);
    if (!response.ok) {
      return res.status(404).send({
        ok: false,
        message: "Space not found",
      });
    }
    let html = await response.text();
    // remove the last p tag including this url https://enzostvs-deepsite.hf.space
    html = html.replace(getPTag(repoId), "");

    let user = null;

    if (token) {
      const request_user = await fetch(
        "https://huggingface.co/oauth/userinfo",
        {
          headers: {
            Authorization: `Bearer ${hf_token}`,
          },
        }
      )
        .then((res) => res.json())
        .catch(() => null);

      user = request_user;
    }

    res.status(200).send({
      ok: true,
      html,
      isOwner: space.author === user?.preferred_username,
      path: repoId,
    });
  } catch (error) {
    return res.status(500).send({
      ok: false,
      message: error.message,
    });
  }
});
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
