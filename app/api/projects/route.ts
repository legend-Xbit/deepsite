import { NextResponse } from "next/server";
import { RepoDesignation, createRepo, uploadFiles } from "@huggingface/hub";

import { auth } from "@/lib/auth";
import {
  COLORS,
  EMOJIS_FOR_SPACE,
  injectDeepSiteBadge,
  isIndexPage,
} from "@/lib/utils";

// todo: catch error while publishing project, and return the error to the user
// if space has been created, but can't push, try again or catch well the error and return the error to the user

export async function POST(request: Request) {
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = session.accessToken;

  const body = await request.json();
  const { projectTitle, files, prompt } = body;

  if (!files) {
    return NextResponse.json(
      { error: "Project title and files are required" },
      { status: 400 }
    );
  }

  const title =
    typeof projectTitle === "string" && projectTitle.trim()
      ? projectTitle.trim()
      : "DeepSite Project";

  let formattedTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter(Boolean)
    .join("-")
    .slice(0, 75);

  formattedTitle =
    formattedTitle + "-" + Math.random().toString(36).substring(2, 7);

  const repo: RepoDesignation = {
    type: "space",
    name: session.user?.username + "/" + formattedTitle,
  };

  // Escape YAML values to prevent injection attacks
  const escapeYamlValue = (value: string): string => {
    if (/[:|>]|^[-*#]|^\s|['"]/.test(value) || value.includes("\n")) {
      return `"${value.replace(/"/g, '\\"')}"`;
    }
    return value;
  };

  // Escape markdown headers to prevent injection
  const escapeMarkdownHeader = (value: string): string => {
    return value.replace(/^#+\s*/g, "").replace(/\n/g, " ");
  };

  const colorFrom = COLORS[Math.floor(Math.random() * COLORS.length)];
  const colorTo = COLORS[Math.floor(Math.random() * COLORS.length)];
  const emoji =
    EMOJIS_FOR_SPACE[Math.floor(Math.random() * EMOJIS_FOR_SPACE.length)];
  const README = `---
title: ${escapeYamlValue(title)}
colorFrom: ${colorFrom}
colorTo: ${colorTo}
sdk: static
emoji: ${emoji}
tags:
  - deepsite-v4
---

# ${escapeMarkdownHeader(title)}

This project has been created with [DeepSite](https://deepsite.hf.co) AI Vibe Coding.
`;

  const filesToUpload: File[] = [
    new File([README], "README.md", { type: "text/markdown" }),
  ];
  for (const file of files) {
    let mimeType = "text/html";
    if (file.path.endsWith(".css")) {
      mimeType = "text/css";
    } else if (file.path.endsWith(".js")) {
      mimeType = "text/javascript";
    }
    const content =
      mimeType === "text/html" && isIndexPage(file.path)
        ? injectDeepSiteBadge(file.content)
        : file.content;

    filesToUpload.push(new File([content], file.path, { type: mimeType }));
  }

  let repoUrl: string | undefined;
  
  try {
    // Create the space first
    const createResult = await createRepo({
      accessToken: token as string,
      repo: repo,
      sdk: "static",
    });
    repoUrl = createResult.repoUrl;

    // Escape commit message to prevent injection
    const escapeCommitMessage = (message: string): string => {
      return message.replace(/[\r\n]/g, " ").slice(0, 200);
    };
    const commitMessage = escapeCommitMessage(prompt ?? "Initial DeepSite commit");
    
    // Upload files to the created space
    await uploadFiles({
      repo,
      files: filesToUpload,
      accessToken: token as string,
      commitTitle: commitMessage,
    });

    const path = repoUrl.split("/").slice(-2).join("/");

    return NextResponse.json({ repoUrl: path }, { status: 200 });
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : "Failed to create or upload to space";
    
    // If space was created but upload failed, include the repo URL in the error
    if (repoUrl) {
      const path = repoUrl.split("/").slice(-2).join("/");
      return NextResponse.json({ 
        error: `${errMsg}. Space was created at ${path} but files could not be uploaded.`,
        repoUrl: path,
        partialSuccess: true
      }, { status: 500 });
    }
    
    return NextResponse.json({ error: errMsg }, { status: 500 });
  }
}
