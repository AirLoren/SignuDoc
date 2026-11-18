import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import {
  listAllEnvelopesForAdmin,
  listEnvelopesForUser,
} from "@/lib/envelopes";

type DashboardPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  const session = await getAuthSession();
  const database = getDb();
  const { view } = await searchParams;
  let envelopes: Awaited<ReturnType<typeof listEnvelopesForUser>> | undefined;
  let initialState: "default" | "empty" | "error" = "error";
  let isAdmin = false;

  try {
    isAdmin = session ? await isAdminUser(session.user.id, database) : false;
    // An administrator can see every envelope in the install, not only
    // their own.
    const showAll = isAdmin && view === "all";

    envelopes = !session
      ? []
      : showAll
        ? await listAllEnvelopesForAdmin({}, database)
        : await listEnvelopesForUser(session.user.id, {}, database);
    initialState = envelopes.length === 0 ? "empty" : "default";
  } catch {
    initialState = "error";
  }

  return (
    <DashboardShell
      envelopes={envelopes}
      initialState={initialState}
      view={isAdmin ? (view === "all" ? "all" : "mine") : undefined}
    />
  );
}
