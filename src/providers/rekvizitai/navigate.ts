import type { Page } from "playwright";

const REKVIZITAI_BASE_URL = "https://rekvizitai.vz.lt/";
const NAV_TIMEOUT = 30_000;

/**
 * Navigate an existing Playwright page to the company profile on rekvizitai.vz.lt.
 *
 * Searches by idCode if provided (more precise), otherwise by borrowerName.
 * Throws if no company is found or if multiple results are found when searching by name.
 *
 * The caller is responsible for creating the Page and closing the browser.
 */
export async function navigateToCompanyProfile(
  page: Page,
  borrowerName: string,
  idCode?: string
): Promise<void> {
  page.setDefaultTimeout(NAV_TIMEOUT);

  await page.goto(REKVIZITAI_BASE_URL, { waitUntil: "networkidle" });

  const searchQuery = idCode?.trim() || borrowerName.trim();

  // Try multiple selector patterns for the search input
  const searchInputSelectors = [
    'input[name="q"]',
    'input[type="search"]',
    'input[placeholder*="Ieškoti" i]',
    'input[placeholder*="pavadinimas" i]',
    'input[placeholder*="kodas" i]',
    'input[id*="search" i]',
    'input[class*="search" i]',
  ];

  let inputFilled = false;
  for (const sel of searchInputSelectors) {
    try {
      await page.waitForSelector(sel, { timeout: 3_000 });
      await page.fill(sel, searchQuery);
      inputFilled = true;
      break;
    } catch {
      // try next selector
    }
  }

  if (!inputFilled) {
    throw new Error(
      "Could not locate search field on rekvizitai.vz.lt. " +
        "The page structure may have changed — update searchInputSelectors in navigate.ts."
    );
  }

  // Submit the search
  await page.keyboard.press("Enter");
  await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT }).catch(() => {});

  // Give JS-rendered results time to appear
  await page.waitForTimeout(1500);

  // If the site redirected directly to a company profile page, we're done.
  const currentUrl = page.url();
  if (isCompanyProfileUrl(currentUrl)) {
    return;
  }

  // Collect all company profile links from the results page in one query
  const profileLinks = await page
    .locator('a[href*="/imone/"], a[href*="/en/company/"]')
    .evaluateAll((els) =>
      els
        .map((el) => (el as HTMLAnchorElement).getAttribute("href"))
        .filter(Boolean)
    ) as string[];

  if (profileLinks.length === 0) {
    throw new Error(
      `No company found on rekvizitai.vz.lt matching "${searchQuery}"`
    );
  }

  if (profileLinks.length > 1 && !idCode) {
    throw new Error(
      `Multiple companies found on rekvizitai.vz.lt for "${borrowerName}". ` +
        "Provide ID code to narrow the search."
    );
  }

  // Navigate to the first (or only) result
  const href = profileLinks[0];
  const url = href.startsWith("http")
    ? href
    : `https://rekvizitai.vz.lt${href}`;

  await page.goto(url, { waitUntil: "networkidle" });
}

function isCompanyProfileUrl(url: string): boolean {
  return /rekvizitai\.vz\.lt\/(en\/company|imone)\//.test(url);
}
