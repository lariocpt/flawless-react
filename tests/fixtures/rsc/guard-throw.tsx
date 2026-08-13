// @ts-nocheck — next/navigation and the "@/…" alias resolve through this
// fixture's pretend Next.js project, not through the repo root tsconfig.
import { getSession } from "@/lib/auth";
import { ReportMissingError, loadReport } from "@/lib/reports";
import { notFound } from "next/navigation";

export async function ReportPanel({ reportId }: { reportId: string }) {
  const session = await getSession();
  const report = await loadReport(reportId);

  if (!session) {
    throw new Error("not authenticated");
  }

  if (report === null) throw new ReportMissingError(reportId);

  if (!report) return notFound();

  if (report.rows.length > 0) {
    if (!report.title) throw new Error("report has no title");
  }

  return <section>{report.title}</section>;
}
