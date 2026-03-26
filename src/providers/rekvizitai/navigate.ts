import type { Page } from "playwright";

const REKVIZITAI_BASE_URL = "https://rekvizitai.vz.lt/";
const NAV_TIMEOUT = 30_000;

/**
 * Navigate an existing Playwright page to the company profile on rekvizitai.vz.lt.
 *
 * Searches by borrowerName (idCode is used only to disambiguate when multiple results
 * are found — the site does not support numeric code search via the URL parameter).
 * Throws if no company is found or if multiple results are found and no idCode is given.
 *
 * The caller is responsible for creating the Page and closing the browser.
 */
export async function navigateToCompanyProfile(
  page: Page,
  borrowerName: string,
  idCode?: string
): Promise<void> {
  page.setDefaultTimeout(NAV_TIMEOUT);

  // Step 1: Accept the CookieBot consent banner so search results load properly.
  await page.goto(REKVIZITAI_BASE_URL, { waitUntil: "load" });
  try {
    await page.waitForSelector("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", {
      timeout: 8_000,
    });
    await page.click("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll");
    await page.waitForTimeout(1000);
  } catch {
    // Cookie dialog not present (already accepted in this session) — continue.
  }

  // Step 2: Navigate to search results. Always search by company name because the
  // site's ?paieska= parameter does not resolve numeric company codes.
  const searchUrl =
    `${REKVIZITAI_BASE_URL}imone/?paieska=${encodeURIComponent(borrowerName.trim())}`;
  await page.goto(searchUrl, { waitUntil: "load" });
  await page.waitForTimeout(2000);

  // If the site redirected directly to a company profile page, we're done.
  const currentUrl = page.url();
  if (isCompanyProfileUrl(currentUrl)) {
    return;
  }

  // Step 3: Collect actual search-result links. The page has two non-result zones:
  //   - .companies-row  → ad/featured companies (header area)
  //   - .links.mt-4     → "popular/recently viewed" sidebar block
  // We only want links that live outside both of those containers.
  const profileLinks = await page.evaluate((): string[] => {
    return Array.from(document.querySelectorAll("a"))
      .filter((a) => {
        const href = a.getAttribute("href") ?? "";
        if (!href.includes("/imone/") && !href.includes("/en/company/")) {
          return false;
        }
        const excluded = a.closest(
          ".companies-row, .links, " +
          "header, nav, footer, [role='navigation'], [role='banner'], " +
          "[role='contentinfo'], .header, .nav, .footer, .navbar, " +
          ".sidebar, .widget, .top-bar, .menu, .popular, .featured, " +
          ".reklama, .sponsored, .reklaminiai, .pagrindinis-blokas"
        );
        return !excluded;
      })
      .map((a) => a.getAttribute("href"))
      .filter(Boolean) as string[];
  });

  if (profileLinks.length === 0) {
    throw new Error(
      `No company found on rekvizitai.vz.lt matching "${borrowerName}" ` +
      `(page after search: ${currentUrl})`
    );
  }

  if (profileLinks.length === 1) {
    const href = profileLinks[0];
    const url = href.startsWith("http") ? href : `${REKVIZITAI_BASE_URL}${href.replace(/^\//, "")}`;
    await page.goto(url, { waitUntil: "load" });
    return;
  }

  // Multiple results: if an idCode was provided, navigate to each candidate and
  // pick the one whose page body contains the company code.
  if (idCode) {
    for (const href of profileLinks.slice(0, 5)) {
      const url = href.startsWith("http") ? href : `${REKVIZITAI_BASE_URL}${href.replace(/^\//, "")}`;
      await page.goto(url, { waitUntil: "load" });
      await page.waitForTimeout(500);
      const bodyText = await page.evaluate(() => document.body.innerText);
      if (bodyText.includes(idCode.trim())) {
        return; // Correct company — stay on this page.
      }
    }
    throw new Error(
      `None of the ${profileLinks.length} companies found for "${borrowerName}" ` +
      `on rekvizitai.vz.lt contain the ID code "${idCode}".`
    );
  }

  throw new Error(
    `Multiple companies found on rekvizitai.vz.lt for "${borrowerName}". ` +
    "Provide an ID code to narrow the search."
  );
}

function isCompanyProfileUrl(url: string): boolean {
  // Must have a non-empty slug after /imone/ or /en/company/ (not just /?query)
  return /rekvizitai\.vz\.lt\/(en\/company|imone)\/[^?][^/]+/.test(url);
}
