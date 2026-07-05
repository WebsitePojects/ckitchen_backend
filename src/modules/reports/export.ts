/**
 * Sales Report Export — GET /reports/sales/export?format=xlsx|pdf (client req #10, D33).
 *
 * Builds the SAME report shape produced by getSalesReport (src/modules/reports/service.ts)
 * into a downloadable file. Kept deliberately simple per spec: one title, the date range,
 * one row per group, and a totals row — no charts/styling beyond a bold header.
 */
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import type { SalesReport } from "./service.js";

const REPORT_TITLE = "Orion — Sales Report";

function money(n: number): string {
  return n.toFixed(2);
}

function groupByLabel(groupBy: SalesReport["group_by"]): string {
  switch (groupBy) {
    case "day":
      return "Day";
    case "brand":
      return "Brand";
    case "outlet":
      return "Outlet";
    case "aggregator":
      return "Aggregator";
  }
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

export async function buildSalesReportXlsx(report: SalesReport): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Orion";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Sales Report");

  sheet.mergeCells("A1:D1");
  sheet.getCell("A1").value = REPORT_TITLE;
  sheet.getCell("A1").font = { bold: true, size: 14 };

  sheet.getCell("A2").value = `Range: ${report.from} to ${report.to}`;
  sheet.getCell("A3").value = `Grouped by: ${groupByLabel(report.group_by)}`;

  const headerRowIdx = 5;
  const headerRow = sheet.getRow(headerRowIdx);
  headerRow.values = [groupByLabel(report.group_by), "Orders", "Gross Sales", "Net Sales"];
  headerRow.font = { bold: true };

  let rowIdx = headerRowIdx + 1;
  for (const row of report.rows) {
    sheet.getRow(rowIdx).values = [row.key, row.orders_count, row.gross_sales, row.net_sales];
    rowIdx += 1;
  }

  const totalsRow = sheet.getRow(rowIdx);
  totalsRow.values = [
    "TOTAL",
    report.totals.orders_count,
    report.totals.gross_sales,
    report.totals.net_sales,
  ];
  totalsRow.font = { bold: true };

  sheet.columns = [{ width: 22 }, { width: 12 }, { width: 16 }, { width: 16 }];
  sheet.getColumn(3).numFmt = "#,##0.00";
  sheet.getColumn(4).numFmt = "#,##0.00";

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

export function buildSalesReportPdf(report: SalesReport): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.fontSize(18).text(REPORT_TITLE, { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(10).text(`Range: ${report.from} to ${report.to}`);
    doc.text(`Grouped by: ${groupByLabel(report.group_by)}`);
    doc.moveDown();

    const colX = { key: doc.page.margins.left, orders: 260, gross: 340, net: 440 };
    const colWidth = { key: 200, orders: 60, gross: 90, net: 90 };

    function drawRow(
      key: string,
      orders: string,
      gross: string,
      net: string,
      bold: boolean,
    ): void {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10);
      const y = doc.y;
      doc.text(key, colX.key, y, { width: colWidth.key });
      doc.text(orders, colX.orders, y, { width: colWidth.orders, align: "right" });
      doc.text(gross, colX.gross, y, { width: colWidth.gross, align: "right" });
      doc.text(net, colX.net, y, { width: colWidth.net, align: "right" });
      doc.moveDown(0.6);
    }

    drawRow(groupByLabel(report.group_by), "Orders", "Gross Sales", "Net Sales", true);
    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .stroke();
    doc.moveDown(0.3);

    for (const row of report.rows) {
      // Page overflow guard: start a fresh page rather than clipping (spec:
      // "one page unless overflow").
      if (doc.y > doc.page.height - doc.page.margins.bottom - 40) {
        doc.addPage();
      }
      drawRow(row.key, String(row.orders_count), money(row.gross_sales), money(row.net_sales), false);
    }

    doc
      .moveTo(doc.page.margins.left, doc.y)
      .lineTo(doc.page.width - doc.page.margins.right, doc.y)
      .stroke();
    doc.moveDown(0.3);
    drawRow(
      "TOTAL",
      String(report.totals.orders_count),
      money(report.totals.gross_sales),
      money(report.totals.net_sales),
      true,
    );

    doc.end();
  });
}
