import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ repoId: string; commitId: string }> }
) {
  const { repoId, commitId }: { repoId: string; commitId: string } =
    await params;
  const session = await auth();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const token = session.accessToken;

  try {
    const response = await fetch(
      `https://huggingface.co/api/spaces/${session.user?.username}/${repoId}/branch/main`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          startingPoint: commitId,
          overwrite: true,
        }),
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: "Failed to set default version" },
        { status: response.status }
      );
    }
  } catch (error) {
    console.error("Failed to set default version:", error);
    return NextResponse.json(
      { error: "Failed to set default version" },
      { status: 502 }
    );
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
