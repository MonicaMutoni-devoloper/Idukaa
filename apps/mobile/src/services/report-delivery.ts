import * as Print from "expo-print";
import { Platform, Share } from "react-native";

/**
 * Delivery of exports, separated from their content so the builders stay pure and testable.
 *
 * Web downloads a real `.csv` file and prints into a new window; Android shares the CSV text (the
 * same behavior as the existing reports screen) and hands the print HTML to the system print
 * service, where "Save as PDF" produces the PDF. Every export is generated locally from the rows on
 * screen — no token, endpoint or permission is bypassed.
 */

export async function deliverCsv(filename: string, csv: string): Promise<"downloaded" | "shared"> {
  // BOM: Excel on Windows reads UTF-8 CSV as ANSI without it, turning names into mojibake.
  const text = `\uFEFF${csv}`;
  if (Platform.OS === "web") {
    const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return "downloaded";
  }
  await Share.share({ message: text, title: filename });
  return "shared";
}

/** Opens the platform print flow. On Android this includes "Save as PDF"; on web, the print dialog. */
export async function printReport(html: string): Promise<"printed"> {
  if (Platform.OS === "web") {
    const w = window.open("", "_blank");
    if (!w) throw new Error("popup_blocked");
    w.document.open();
    w.document.write(html);
    w.document.close();
    w.focus();
    // Let the new document lay out before the dialog measures it.
    await new Promise((resolve) => setTimeout(resolve, 250));
    w.print();
    return "printed";
  }
  await Print.printAsync({ html });
  return "printed";
}
