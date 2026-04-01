import { chromium } from "playwright";
import type { NormalizedCheckResult, RunCheckInput } from "@/lib/types";

export const KRZ_BASE_URL = "https://krz.ms.gov.pl";
const KRZ_HASH =
  "#!/application/KRZPortalPUB/1.9/KrzRejPubGui.WyszukiwaniePodmiotow?params=JTdCJTdE&itemId=item-2&seq=0";

const NAV_TIMEOUT = 30_000;

// Tab anchor IDs from the KRZ DOM (stable PrimeNG tab labels)
const ENTITY_TAB_ID: Record<string, string> = {
  pl_company: "ui-tabpanel-0-label",
  pl_business_ind: "ui-tabpanel-1-label",
  pl_private_ind: "ui-tabpanel-2-label",
};

// Stable input IDs per entity type, from the KRZ DOM
const ENTITY_NAME_FIELD_ID: Record<string, string> = {
  pl_company: "nazwa_firmy",
  pl_business_ind: "firma",
  pl_private_ind: "", // no name field — identifier only
};
const ENTITY_ID_FIELD_ID: Record<string, string> = {
  pl_company: "inny_id",
  pl_business_ind: "identyfikator",
  pl_private_ind: "inny_id_os_fiz",
};

export async function runKrzSearch(
  input: RunCheckInput
): Promise<NormalizedCheckResult> {
  const searchedAt = new Date().toISOString();
  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (compatible; PublicChecksBot/1.0; internal audit tool)",
      locale: "pl-PL",
    });

    const page = await context.newPage();

    page.on("console", (msg) => console.log("BROWSER:", msg.type(), msg.text()));
    page.on("pageerror", (err) => console.log("PAGE ERROR:", err.message));
    page.on("requestfailed", (req) =>
      console.log("REQUEST FAILED:", req.url(), req.failure()?.errorText)
    );

    // Step 1: Load base URL so Angular shell boots, then navigate via hash
    await page.goto(KRZ_BASE_URL, { waitUntil: "load", timeout: NAV_TIMEOUT });
    await page.waitForTimeout(3_000);

    // Step 2: Dismiss cookie consent if present
    const cookieSelectors = [
      'button:has-text("Akceptuję")',
      'button:has-text("Akceptuj")',
      'button:has-text("Zgadzam się")',
      'button:has-text("Zaakceptuj")',
      'button:has-text("Accept")',
      '[class*="cookie"] button',
      '[id*="cookie"] button',
      '[class*="consent"] button',
    ];
    for (const sel of cookieSelectors) {
      try {
        const btn = page.locator(sel).first();
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 2_000 });
          await page.waitForTimeout(500);
          break;
        }
      } catch { /* not found */ }
    }

    // Step 3: Set the hash route — triggers the Angular router on the outer shell
    await page.evaluate((hash) => { window.location.hash = hash; }, KRZ_HASH);

    // Step 4: Wait for the KRZ search iframe to attach.
    // The actual form lives inside a cross-origin iframe hosted on
    // krz-rejpub-gui-krz-pub-prod.apps.ocp.prod.ms.gov.pl — not the outer page.
    let appFrame = page.frames().find(f => f.url().includes("krz-rejpub-gui"));
    if (!appFrame) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("KRZ iframe did not attach within 20s")), 20_000);
        const check = () => {
          const f = page.frames().find(fr => fr.url().includes("krz-rejpub-gui"));
          if (f) { clearTimeout(timer); appFrame = f; resolve(); }
        };
        page.on("frameattached", check);
        page.on("framenavigated", check);
      });
    }
    if (!appFrame) throw new Error("KRZ iframe not found");
    console.log("iframe URL:", appFrame.url());

    // Step 5: Wait for form to mount inside the iframe
    await appFrame.locator("#nazwa_firmy").waitFor({ state: "visible", timeout: 20_000 });
    console.log("Form ready inside iframe.");

    // Step 6: Click the entity type tab
    const tabId = ENTITY_TAB_ID[input.searchType];
    if (tabId) {
      await appFrame.locator(`#${tabId}`).click();
      await page.waitForTimeout(500);
    }

    // Step 7: Fill name field (may not exist for pl_private_ind)
    const nameFieldId = ENTITY_NAME_FIELD_ID[input.searchType];
    if (nameFieldId && input.borrowerName.trim()) {
      await appFrame.locator(`#${nameFieldId}`).waitFor({ state: "visible", timeout: 10_000 });
      await appFrame.locator(`#${nameFieldId}`).fill(input.borrowerName.trim());
    }

    // Step 8: Fill identifier field
    const idFieldId = ENTITY_ID_FIELD_ID[input.searchType];
    if (idFieldId && input.idCode?.trim()) {
      await appFrame.locator(`#${idFieldId}`).waitFor({ state: "visible", timeout: 10_000 });
      await appFrame.locator(`#${idFieldId}`).fill(input.idCode.trim());
    }

    console.log("Fields filled. Clicking Wyszukaj...");

    // Step 9: Click Wyszukaj inside the iframe.
    // #butoonWyszukaj is inside hideDesktopResolution (hidden at desktop viewport).
    // #butoonWyszukajMobile is inside hideMobileResolution (visible at desktop viewport).
    // Target the desktop-visible one directly.
    await appFrame.locator("#butoonWyszukajMobile").waitFor({ state: "visible", timeout: 5_000 });
    await appFrame.locator("#butoonWyszukajMobile").click();

    // Step 10: Wait for search to complete — two possible end states:
    // - results found:    "Liczba podmiotów: N" badge appears
    // - no results found: "Nie zostały znalezione żadne pozycje..." message appears
    await appFrame.waitForFunction(
      () =>
        document.body.innerText.includes("Liczba podmiotów") ||
        document.body.innerText.includes("Nie zostały znalezione"),
      { timeout: 20_000 }
    );

    // Wait for "Proszę czekać" (loading overlay) to disappear
    await appFrame.locator("text=Proszę czekać").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => {});

    // Poll until the iframe content height stops growing (Angular panel animations complete)
    let stableHeight = 0;
    for (let i = 0; i < 15; i++) {
      const h = await appFrame.evaluate(() =>
        Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)
      );
      if (h === stableHeight) break;
      stableHeight = h;
      await page.waitForTimeout(400);
    }

    // Resize the iframe element on the outer page to its full content height
    await page.evaluate((h) => {
      document.querySelectorAll("iframe").forEach((el) => {
        el.style.height = `${h}px`;
        el.style.minHeight = `${h}px`;
      });
    }, stableHeight);
    await page.waitForTimeout(300);

    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const finalUrl = appFrame.url();
    const bodyText = await appFrame.evaluate(() => document.body.innerText);

    const { status, resultsCount, matchedEntities, summaryText } =
      parseKrzResults(bodyText, input.borrowerName);

    return {
      providerKey: "krz_insolvency",
      sourceUrl: finalUrl || KRZ_BASE_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status,
      resultsCount,
      matchedEntities,
      summaryText,
      screenshotBuffer,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let diagScreenshot: Buffer | undefined;
    try {
      if (browser) {
        const pages = browser.contexts()[0]?.pages();
        const activePage = pages?.[pages.length - 1];
        if (activePage) {
          diagScreenshot = await activePage.screenshot({ fullPage: true });
        }
      }
    } catch { /* ignore */ }
    return {
      providerKey: "krz_insolvency",
      sourceUrl: KRZ_BASE_URL,
      searchedAt,
      borrowerNameInput: input.borrowerName,
      idCodeInput: input.idCode,
      status: "error",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `KRZ search failed: ${message}`,
      screenshotBuffer: diagScreenshot,
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Parse KRZ search results from the page body text.
 * Exported for unit testing.
 */
export function parseKrzResults(
  bodyText: string,
  borrowerName: string
): Pick<
  NormalizedCheckResult,
  "status" | "resultsCount" | "matchedEntities" | "summaryText"
> {
  const lower = bodyText.toLowerCase();

  // "Liczba podmiotów: N" — shown in the results counter badge
  const countBadge = bodyText.match(/liczba\s+podmiotów:\s*(\d+)/i);
  if (countBadge) {
    const count = parseInt(countBadge[1], 10);
    const matchedEntities = extractEntities(bodyText, borrowerName);
    if (count === 0) {
      return {
        status: "no_match",
        resultsCount: 0,
        matchedEntities: [],
        summaryText: `No insolvency records found on KRZ for "${borrowerName}".`,
      };
    }
    if (count === 1) {
      return {
        status: "match_found",
        resultsCount: 1,
        matchedEntities,
        summaryText: `1 insolvency record found on KRZ matching "${borrowerName}".`,
      };
    }
    return {
      status: "ambiguous",
      resultsCount: count,
      matchedEntities,
      summaryText: `${count} insolvency records found on KRZ for "${borrowerName}". Manual review required.`,
    };
  }

  // Secondary: "Wyświetlanie X - Y z Z wyników"
  const countMatch = bodyText.match(
    /wyświetlanie\s+\d+\s*[-–]\s*\d+\s+z\s+(\d+)\s+wyników/i
  );
  if (countMatch) {
    const count = parseInt(countMatch[1], 10);
    const matchedEntities = extractEntities(bodyText, borrowerName);
    if (count === 0) {
      return { status: "no_match", resultsCount: 0, matchedEntities: [], summaryText: `No insolvency records found on KRZ for "${borrowerName}".` };
    }
    if (count === 1) {
      return { status: "match_found", resultsCount: 1, matchedEntities, summaryText: `1 insolvency record found on KRZ matching "${borrowerName}".` };
    }
    return { status: "ambiguous", resultsCount: count, matchedEntities, summaryText: `${count} insolvency records found on KRZ for "${borrowerName}". Manual review required.` };
  }

  // Explicit no-result signal
  if (
    lower.includes("brak wyników") ||
    lower.includes("nie znaleziono") ||
    lower.includes("nie zostały znalezione")
  ) {
    return {
      status: "no_match",
      resultsCount: 0,
      matchedEntities: [],
      summaryText: `No insolvency records found on KRZ for "${borrowerName}".`,
    };
  }

  return {
    status: "ambiguous",
    resultsCount: 0,
    matchedEntities: [],
    summaryText:
      "KRZ search page loaded but results could not be parsed. Please review the screenshot in the PDF.",
  };
}

function extractEntities(
  bodyText: string,
  borrowerName: string
): Array<{ name: string; caseNumber?: string }> {
  const lines = bodyText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const firstWord = borrowerName.toLowerCase().split(" ")[0];
  return lines
    .filter((l) => l.toLowerCase().includes(firstWord))
    .slice(0, 10)
    .map((l) => ({ name: l }));
}
