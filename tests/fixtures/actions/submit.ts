"use server";

// Stands in for a Next.js server action module: in a real app these reach for
// the database and the mailer, so they cannot run under jsdom or in a browser
// bundle.
export async function createPost(_state: unknown, _form: FormData) {
  return { ok: true };
}

export async function deletePost(_id: string) {
  return { ok: true };
}
