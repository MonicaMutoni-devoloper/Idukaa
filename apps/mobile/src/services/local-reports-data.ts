import { listProducts, listRecords } from "../database";
import { computeLocalReport, computeLocalSummary, type LocalReportResult, type LocalSummaryPayload, type ReportView } from "./local-reports";

/**
 * Loads this device's durable records and products, then calculates one report view (or the P&L
 * summary) for a range. Kept apart from the calculation so the maths is testable without SQLite.
 */
export async function buildLocalReport(opts: { view: ReportView; from: string; to: string }): Promise<LocalReportResult> {
  const [records, products] = await Promise.all([listRecords(), listProducts("")]);
  return computeLocalReport({ ...opts, records, products });
}

export async function buildLocalSummary(opts: { from: string; to: string; financials: boolean }): Promise<LocalSummaryPayload> {
  const [records, products] = await Promise.all([listRecords(), listProducts("")]);
  return computeLocalSummary({ ...opts, records, products });
}
