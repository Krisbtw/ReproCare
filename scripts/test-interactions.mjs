import { chromium } from "playwright";

async function run() {
  console.log("Launching Edge browser...");
  const browser = await chromium.launch({
    channel: "msedge",
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.error("Browser Console Error:", msg.text());
    }
  });

  console.log("Navigating to http://127.0.0.1:8080/ ...");
  await page.goto("http://127.0.0.1:8080/", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: "screenshots/01-landing.png" });

  // If on login page, switch to register and create account
  const regToggle = page.getByRole("button", { name: /need an account|register/i });
  if (await regToggle.isVisible()) {
    console.log("Switching to register mode...");
    await regToggle.click();
    await page.waitForTimeout(500);

    const nameInput = page.getByPlaceholder(/name/i);
    if (await nameInput.isVisible()) {
      await nameInput.fill("Dr. Elena Vance");
    }
    const email = `clinician_${Date.now()}@test.clinic`;
    await page.getByPlaceholder(/email/i).fill(email);
    await page.getByPlaceholder(/password/i).fill("ClinicianPass123!");

    console.log("Submitting registration for", email);
    await page.getByRole("button", { name: /create account/i }).click();
    await page.waitForTimeout(4000);
    await page.screenshot({ path: "screenshots/02-after-signin.png" });
  }

  // Look for Volume Lab view button in clinic header/navigation
  console.log("Navigating to Volume Lab...");
  const labNav = page.getByRole("button", { name: /volume lab/i }).or(page.getByText("Volume Lab"));
  if (await labNav.first().isVisible()) {
    await labNav.first().click();
    await page.waitForTimeout(2000);
  }
  await page.screenshot({ path: "screenshots/03-volumelab-view.png" });

  // Load sample series
  const loadSampleBtn = page.getByRole("button", { name: /load synthetic sample/i });
  if (await loadSampleBtn.isVisible()) {
    console.log("Loading synthetic sample series...");
    await loadSampleBtn.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "screenshots/04-volumelab-loaded.png" });

    // Test Preprocessing: Median Filter
    const medianBtn = page.getByTestId("apply-median");
    if (await medianBtn.isVisible()) {
      console.log("Applying median filter...");
      await medianBtn.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: "screenshots/05-median-applied.png" });
    }

    // Test Preprocessing: Revert to raw
    const revertBtn = page.getByTestId("revert-preprocess");
    if (await revertBtn.isVisible()) {
      console.log("Reverting preprocessing to raw...");
      await revertBtn.click();
      await page.waitForTimeout(1000);
    }

    // Place a seed point in the volume
    console.log("Placing seed on slice view...");
    const canvas = page.locator("canvas, [role='img']").first();
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1000);
    }

    // Grow region
    const growBtn = page.getByRole("button", { name: /grow region from seed/i });
    if (await growBtn.isVisible()) {
      console.log("Executing region growing segmentation...");
      await growBtn.click();
      await page.waitForTimeout(3000);
      await page.screenshot({ path: "screenshots/06-segmented.png" });
    }
  }

  // Navigate to Reports view
  console.log("Navigating to Reports...");
  const reportsNav = page.getByRole("button", { name: /reports/i }).or(page.getByText("Reports"));
  if (await reportsNav.first().isVisible()) {
    await reportsNav.first().click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "screenshots/07-reports-view.png" });
  }

  // Navigate to Correspondence / Discrepancy (ReproTrace)
  console.log("Navigating to ReproTrace...");
  const traceNav = page.getByRole("button", { name: /trace|correspondence/i }).or(page.getByText("Trace"));
  if (await traceNav.first().isVisible()) {
    await traceNav.first().click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "screenshots/08-trace-view.png" });
  }

  console.log("Interactive browser tests completed successfully!");
  await browser.close();
}

run().catch((err) => {
  console.error("Test interactions failed:", err);
  process.exit(1);
});
