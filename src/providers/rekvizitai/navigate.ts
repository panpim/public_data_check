import type { Page } from "playwright";

const REKVIZITAI_BASE_URL = "https://rekvizitai.vz.lt/";
const NAV_TIMEOUT = 30_000;

/**
 * Navigate an existing Playwright page to the company profile on rekvizitai.vz.lt.
 *
 * Fills the homepage search form (name + optional company_code) and submits it,
 * then navigates to the first matching company profile.
 * Throws if no company is found.
 *
 * The caller is responsible for creating the Page and closing the browser.
 */
export async function navigateToCompanyProfile(
  page: Page,
  borrowerName: string,
  idCode?: string
): Promise<void> {
  page.setDefaultTimeout(NAV_TIMEOUT);

  // Step 1: Load the homepage and accept the CookieBot consent banner so the
  // search form and AJAX results render correctly.
  await page.goto(REKVIZITAI_BASE_URL, { waitUntil: "load" });
  await page.waitForTimeout(1000);
  try {
    await page.waitForSelector("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", {
      timeout: 8_000,
    });
    await page.click("#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll");
    await page.waitForTimeout(1000);
  } catch {
    // Dialog not present — already dismissed in this session.
  }

  // Step 2: Fill the search form. The homepage form uses input[name="name"] for
  // company name and input[name="company_code"] for the registry code.
  await page.waitForSelector("input[name='name']", { timeout: 10_000 });
  await page.fill("input[name='name']", borrowerName.trim());
  if (idCode) {
    await page.fill("input[name='company_code']", idCode.trim());
  }

  // Step 3: Submit and wait for navigation to the search results page (/imones/1/).
  await Promise.all([
    page.waitForNavigation({ waitUntil: "load", timeout: NAV_TIMEOUT }),
    page.click("button#ok"),
  ]);
  await page.waitForTimeout(2000);

  // If the site went directly to a company profile (single exact match), we're done.
  const currentUrl = page.url();
  if (isCompanyProfileUrl(currentUrl)) {
    return;
  }

  // Step 4: Collect search-result profile links. The results page (/imones/) has
  // actual results in a card area, followed by .links (popular/recently-viewed)
  // and .companies-row (ad slots). We only want the actual result cards.
  const profileLinks = await page.evaluate((): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const a of Array.from(document.querySelectorAll("a"))) {
      const href = a.getAttribute("href") ?? "";
      if (!href.includes("/imone/") && !href.includes("/en/company/")) continue;
      // Skip links inside known non-result zones
      if (a.closest(".links, .companies-row, header, nav, footer, .sidebar, .widget")) continue;
      if (!seen.has(href)) {
        seen.add(href);
        result.push(href);
      }
    }
    return result;
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

  // Multiple results: if an idCode was provided, check each candidate's page body
  // for the company code and stop at the matching one.
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
