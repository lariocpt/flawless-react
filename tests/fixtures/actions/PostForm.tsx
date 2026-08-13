// @ts-nocheck — next/navigation and next/link resolve through this fixture's
// pretend Next.js project, not through the repo root tsconfig.
"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { createPost, deletePost } from "./submit.ts";
import { slugify } from "./plain.ts";

export function PostForm({ title }: { title: string }) {
  const pathname = usePathname();
  return (
    <form action={createPost as unknown as string}>
      <p>{slugify(title)}</p>
      <p>{pathname}</p>
      <Link href="/posts">All posts</Link>
      <button type="button" onClick={() => deletePost("1")}>
        Delete
      </button>
      <button type="submit">Save</button>
    </form>
  );
}
