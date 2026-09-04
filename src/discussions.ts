// Unresolved discussion counting over GitLab's paginated
// `/projects/:id/merge_requests/:iid/discussions` endpoint.
//
// A discussion (thread) counts as unresolved when any of its notes is
// resolvable and not resolved. Counting threads, not notes, matches the
// "N unresolved threads" figure GitLab shows on the MR page; a thread with a
// review comment plus two replies is one item of work, not three.

export interface DiscussionNote {
  resolvable?: boolean;
  resolved?: boolean;
}

export interface Discussion {
  id?: string;
  notes?: DiscussionNote[];
}

export const DISCUSSIONS_PER_PAGE = 100;
// Safety cap: 50 pages × 100 = 5000 discussions.
export const MAX_DISCUSSION_PAGES = 50;

export type DiscussionPageFetcher = (page: number, perPage: number) => Promise<Discussion[]>;

export function isUnresolved(discussion: Discussion): boolean {
  if (!Array.isArray(discussion.notes)) return false;
  return discussion.notes.some((note) => note && note.resolvable === true && note.resolved === false);
}

export function countUnresolvedIn(discussions: Discussion[]): number {
  let count = 0;
  for (const discussion of discussions) if (isUnresolved(discussion)) count++;
  return count;
}

// Walk pages until a short page signals the end. Throws if a page cannot be
// fetched, so callers can decide whether the failure is fatal.
export async function countUnresolved(
  fetchPage: DiscussionPageFetcher,
  perPage: number = DISCUSSIONS_PER_PAGE,
  maxPages: number = MAX_DISCUSSION_PAGES,
): Promise<number> {
  let total = 0;
  for (let page = 1; page <= maxPages; page++) {
    const items = await fetchPage(page, perPage);
    if (!Array.isArray(items)) throw new Error(`discussions page ${page} was not an array`);
    total += countUnresolvedIn(items);
    if (items.length < perPage) break;
  }
  return total;
}

export function parseDiscussionsPage(stdout: string): Discussion[] {
  const data: unknown = JSON.parse(stdout);
  if (!Array.isArray(data)) throw new Error("discussions response was not an array");
  return data as Discussion[];
}
