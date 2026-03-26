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

  const searchQuery = idCode?.trim() || borrowerName.trim();

  // Navigate directly to the search results URL, bypassing the homepage form and
  // any autocomplete that could redirect to the wrong company.
  const searchUrl =
    `${REKVIZITAI_BASE_URL}imone/?paieska=${encodeURIComponent(searchQuery)}`;
  await page.goto(searchUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(2000);

  // If the site redirected directly to a company profile page, we're done.
  const currentUrl = page.url();
  if (isCompanyProfileUrl(currentUrl)) {
    return;
  }

  // Collect company profile links from the main content area only,
  // excluding nav/header/footer/sidebar featured-company blocks.
  const profileLinks = await page.evaluate((): string[] => {
    return Array.from(document.querySelectorAll("a"))
      .filter((a) => {
        const href = a.getAttribute("href") ?? "";
        if (!href.includes("/imone/") && !href.includes("/en/company/")) {
          return false;
        }
        const excluded = a.closest(
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
      `No company found on rekvizitai.vz.lt matching "${searchQuery}" ` +
      `(page after search: ${currentUrl})`
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
  // Must have a non-empty slug after /imone/ or /en/company/ (not just /?query)
  return /rekvizitai\.vz\.lt\/(en\/company|imone)\/[^?][^/]+/.test(url);
}
