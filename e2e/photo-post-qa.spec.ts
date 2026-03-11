import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";

const BASE_URL = "https://keubo.fan";
const QA_EMAIL = "qa@keubo.fan";
const QA_PASSWORD = "kboqa2025!";

// Create a test image if needed
function ensureTestImage(): string {
  const imgPath = path.join(__dirname, "test-landscape.jpg");
  if (!fs.existsSync(imgPath)) {
    // Create a simple 800x400 JPEG-like file for testing
    // We'll use a real downloaded image instead
    fs.writeFileSync(imgPath, ""); // placeholder
  }
  return imgPath;
}

test.describe("사진 게시글 작성 플로우 QA", () => {
  test.beforeEach(async ({ page }) => {
    // Login via Supabase API (OAuth-only app, no email form)
    const SUPABASE_URL = "https://lbmbdjgsnenqjwjotoei.supabase.co";
    
    // Get session token via API
    const response = await page.request.post(
      `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
      {
        headers: {
          "apikey": process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
          "Content-Type": "application/json",
        },
        data: {
          email: QA_EMAIL,
          password: QA_PASSWORD,
        },
      }
    );
    
    const session = await response.json();
    console.log("Login response status:", response.status());
    
    if (session.access_token) {
      // Navigate first to set origin, then inject session via supabase client
      await page.goto(BASE_URL);
      await page.waitForLoadState("networkidle");
      
      // Use the app's own supabase client to set session
      const result = await page.evaluate(async ({ accessToken, refreshToken }: { accessToken: string; refreshToken: string }) => {
        // Access the singleton supabase client from the app's module
        // @supabase/ssr createBrowserClient caches a singleton
        const { createBrowserClient } = await import("@supabase/ssr");
        const supabase = createBrowserClient(
          (window as any).__NEXT_DATA__?.props?.pageProps?.supabaseUrl || 
          document.querySelector('meta[name="supabase-url"]')?.getAttribute("content") || 
          "https://lbmbdjgsnenqjwjotoei.supabase.co",
          "dummy" // anon key - not needed for setSession
        );
        const { error } = await supabase.auth.setSession({
          access_token: accessToken,
          refresh_token: refreshToken,
        });
        return { error: error?.message };
      }, {
        accessToken: session.access_token,
        refreshToken: session.refresh_token,
      }).catch(() => null);
      
      if (result && !result.error) {
        console.log("✅ Session set via supabase client");
      } else {
        // Fallback: set cookies directly matching supabase/ssr format
        const projectRef = "lbmbdjgsnenqjwjotoei";
        const sessionStr = JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_in: session.expires_in,
          expires_at: Math.floor(Date.now() / 1000) + session.expires_in,
          token_type: "bearer",
          user: session.user,
        });
        
        // base64url encode for supabase/ssr cookie format
        const encoded = Buffer.from(sessionStr).toString("base64url");
        const cookieName = `sb-${projectRef}-auth-token`;
        
        // Chunk if needed (4000 char limit per cookie)
        const chunks: string[] = [];
        for (let i = 0; i < encoded.length; i += 3600) {
          chunks.push(encoded.substring(i, i + 3600));
        }
        
        const cookies = chunks.map((chunk, i) => ({
          name: chunks.length === 1 ? cookieName : `${cookieName}.${i}`,
          value: `base64-${chunk}`,
          domain: "keubo.fan",
          path: "/",
          httpOnly: false,
          secure: true,
          sameSite: "Lax" as const,
        }));
        
        await page.context().addCookies(cookies);
        console.log(`✅ Set ${cookies.length} auth cookie(s) directly`);
      }
      
      // Reload to pick up the session
      await page.reload();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1000);
      
      // Verify login state
      const isLoggedIn = await page.evaluate(() => {
        return document.cookie.includes("sb-") || localStorage.length > 0;
      });
      console.log(`Login state verified: ${isLoggedIn}`);
    } else {
      console.log("❌ Login failed:", JSON.stringify(session));
    }
  });

  test("Step 1: 사진 업로드 → Step 2: 에디터 → Step 3: 게시 정보 → 피드 확인", async ({ page }) => {
    // Navigate to a team community page (LG = slug "lg")
    await page.goto(`${BASE_URL}/community/teams/lg?tab=photo`);
    await page.waitForLoadState("networkidle");
    
    // Take screenshot of community page
    await page.screenshot({ path: "e2e/screenshots/01-community-page.png", fullPage: false });

    // Click FAB (Pencil button) - fixed bottom-24 right-5
    const fabBtn = page.locator('button.fixed.bottom-24, button:has(svg.lucide-pencil)').first();
    await fabBtn.waitFor({ state: "visible", timeout: 5000 });
    await fabBtn.click();
    await page.waitForTimeout(1000);
    console.log("✅ FAB clicked");

    await page.screenshot({ path: "e2e/screenshots/02-write-modal-open.png", fullPage: false });

    // Step 1: Upload image
    const fileInput = page.locator('input[type="file"][accept="image/*"]');
    
    // Create a real test image using canvas
    const testImagePath = path.join(__dirname, "test-image.png");
    if (!fs.existsSync(testImagePath)) {
      // Generate a simple PNG
      const { execSync } = require("child_process");
      execSync(`convert -size 800x400 xc:navy -fill white -pointsize 40 -gravity center -annotate 0 "QA Test Image" ${testImagePath} 2>/dev/null || python3 -c "
from PIL import Image as PILImage, ImageDraw
img = PILImage.new('RGB', (800, 400), color='navy')
d = ImageDraw.Draw(img)
d.text((300, 180), 'QA Test', fill='white')
img.save('${testImagePath}')
" 2>/dev/null || echo "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" | base64 -d > ${testImagePath}`);
    }

    // Use Playwright's setInputFiles
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(testImagePath);
      console.log("✅ File input found and file set");
    } else {
      console.log("❌ File input not found in DOM");
    }

    await page.waitForTimeout(1000);
    await page.screenshot({ path: "e2e/screenshots/03-after-upload.png", fullPage: false });

    // Check if image preview appeared
    const preview = page.locator('img[src*="blob:"], img[src*="data:"], [class*="preview"]').first();
    const hasPreview = await preview.isVisible({ timeout: 3000 }).catch(() => false);
    console.log(`Image preview visible: ${hasPreview}`);

    // Step 2: Check for editor / next button
    const nextBtn = page.locator('button:has-text("다음"), button:has-text("건너뛰기"), button:has-text("Next")').first();
    if (await nextBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nextBtn.click();
      await page.waitForTimeout(500);
      console.log("✅ Moved to Step 2 (Editor)");
    }

    await page.screenshot({ path: "e2e/screenshots/04-step2-editor.png", fullPage: false });

    // Step 2 → Step 3
    const nextBtn2 = page.locator('button:has-text("다음"), button:has-text("건너뛰기"), button:has-text("Next")').first();
    if (await nextBtn2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await nextBtn2.click();
      await page.waitForTimeout(500);
      console.log("✅ Moved to Step 3 (Post info)");
    }

    await page.screenshot({ path: "e2e/screenshots/05-step3-info.png", fullPage: false });

    // Step 3: Check player tag search
    const playerSearch = page.locator('input[placeholder*="선수"], input[placeholder*="검색"], input[placeholder*="태그"]').first();
    if (await playerSearch.isVisible({ timeout: 3000 }).catch(() => false)) {
      await playerSearch.fill("오스틴");
      await page.waitForTimeout(500);
      console.log("✅ Player search input found and typed");
      
      // Check dropdown
      const dropdown = page.locator('[class*="dropdown"], [class*="suggestion"], [role="listbox"]').first();
      const hasDropdown = await dropdown.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`Player dropdown visible: ${hasDropdown}`);
      
      await page.screenshot({ path: "e2e/screenshots/06-player-search.png", fullPage: false });
      
      // Select first result
      if (hasDropdown) {
        await dropdown.locator("button, li, [role='option']").first().click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }

    // Check font (감자꽃체)
    await page.screenshot({ path: "e2e/screenshots/07-final-state.png", fullPage: false });

    // Collect all findings
    console.log("\n=== QA Summary ===");
    console.log("Screenshots saved to e2e/screenshots/");
  });

  test("Step 2: 밈 에디터 내부 렌더링 — 캔버스/텍스트/감자꽃체/스티커/툴바", async ({ page }) => {
    // Navigate to photo tab
    await page.goto(`${BASE_URL}/community/teams/lg?tab=photo`);
    await page.waitForLoadState("networkidle");

    // Click FAB
    const fabBtn = page.locator('button.fixed.bottom-24, button:has(svg.lucide-pencil)').first();
    await fabBtn.waitFor({ state: "visible", timeout: 5000 });
    await fabBtn.click();
    await page.waitForTimeout(1000);

    // Step 1: Upload image
    const fileInput = page.locator('input[type="file"][accept="image/*"]');
    const testImagePath = path.join(__dirname, "test-image.png");
    if (await fileInput.count() > 0) {
      await fileInput.setInputFiles(testImagePath);
      console.log("✅ Image uploaded");
    }
    await page.waitForTimeout(1000);

    // Click "다음" to go to Step 2
    const nextBtn = page.locator('button:has-text("다음")').first();
    await nextBtn.click();
    await page.waitForTimeout(1500);
    console.log("✅ Entered Step 2 (Editor)");

    await page.screenshot({ path: "e2e/screenshots/10-step2-editor-view.png", fullPage: false });

    // Click pencil overlay button on the image thumbnail to open MemeEditor
    // The button has: absolute inset-0 + contains Pencil SVG
    const editBtn = page.locator('button').filter({ has: page.locator('svg') }).nth(1); // 2nd button with svg (first is 이전)
    
    // Better: find the button by its role near the "밈 편집" text
    const pencilBtn = page.getByRole('button').filter({ has: page.locator('path[d*="M21.174"]') }); // Pencil SVG path
    
    // Simplest approach: just click the image thumbnail area
    let editorOpened = false;
    
    // Find all buttons and click the one with pencil icon
    const buttons = page.locator('button');
    const buttonCount = await buttons.count();
    console.log(`Found ${buttonCount} buttons on page`);
    
    for (let i = 0; i < buttonCount; i++) {
      const btn = buttons.nth(i);
      const hasPencilSvg = await btn.locator('svg').count() > 0;
      const btnText = await btn.textContent().catch(() => "");
      if (hasPencilSvg && !btnText?.includes("이전") && !btnText?.includes("다음") && !btnText?.includes("건너뛰기")) {
        const classList = await btn.evaluate(el => el.className);
        console.log(`Button ${i}: class="${classList}", text="${btnText}"`);
        if (classList.includes("absolute") || classList.includes("inset-0")) {
          await btn.click();
          await page.waitForTimeout(3000);
          editorOpened = true;
          console.log("✅ Opened MemeEditor via pencil button");
          break;
        }
      }
    }
    
    if (!editorOpened) {
      // Fallback: click by coordinates on the thumbnail area
      console.log("Trying coordinate click on thumbnail...");
      await page.click('text=밈 편집', { position: { x: 0, y: 80 } }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    await page.screenshot({ path: "e2e/screenshots/11-meme-editor-open.png", fullPage: false });

    // Check canvas element exists
    const canvas = page.locator("canvas");
    const canvasCount = await canvas.count();
    console.log(`Canvas elements found: ${canvasCount}`);

    // Check toolbar buttons (텍스트, 스티커, 템플릿)
    const textToolBtn = page.locator('button:has-text("텍스트")');
    const stickerToolBtn = page.locator('button:has-text("스티커")');
    const templateToolBtn = page.locator('button:has-text("템플릿")');
    
    const hasTextTool = await textToolBtn.isVisible({ timeout: 2000 }).catch(() => false);
    const hasStickerTool = await stickerToolBtn.isVisible({ timeout: 2000 }).catch(() => false);
    const hasTemplateTool = await templateToolBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`Toolbar: 텍스트=${hasTextTool}, 스티커=${hasStickerTool}, 템플릿=${hasTemplateTool}`);

    await page.screenshot({ path: "e2e/screenshots/12-editor-toolbar.png", fullPage: false });

    // Click 텍스트 tool
    if (hasTextTool) {
      await textToolBtn.click();
      await page.waitForTimeout(500);
      console.log("✅ Opened TextTool panel");

      await page.screenshot({ path: "e2e/screenshots/13-text-tool-panel.png", fullPage: false });

      // Check style presets (밈체, 고딕, 손글씨)
      const memeStyle = page.locator('button:has-text("밈체")');
      const gothicStyle = page.locator('button:has-text("고딕")');
      const handwriteStyle = page.locator('button:has-text("손글씨")');
      
      const hasMeme = await memeStyle.isVisible({ timeout: 1000 }).catch(() => false);
      const hasGothic = await gothicStyle.isVisible({ timeout: 1000 }).catch(() => false);
      const hasHandwrite = await handwriteStyle.isVisible({ timeout: 1000 }).catch(() => false);
      console.log(`Styles: 밈체=${hasMeme}, 고딕=${hasGothic}, 손글씨=${hasHandwrite}`);

      // Click 텍스트 추가 button
      const addTextBtn = page.locator('button:has-text("텍스트 추가")');
      if (await addTextBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        await addTextBtn.click();
        await page.waitForTimeout(500);
        console.log("✅ Added text to canvas");
      }

      await page.screenshot({ path: "e2e/screenshots/14-text-added.png", fullPage: false });

      // Switch to 손글씨 (Gamja Flower)
      if (hasHandwrite) {
        await handwriteStyle.click();
        await page.waitForTimeout(500);
        console.log("✅ Switched to 손글씨 (Gamja Flower)");
        
        // Verify font loaded
        const fontLoaded = await page.evaluate(() => {
          return document.fonts.check("16px 'Gamja Flower'");
        });
        console.log(`Gamja Flower font loaded: ${fontLoaded}`);
      }

      await page.screenshot({ path: "e2e/screenshots/15-handwrite-style.png", fullPage: false });

      // Check color presets
      const colorBtns = page.locator('button[title]').filter({ has: page.locator('[style*="background"]') });
      const colorCount = await colorBtns.count().catch(() => 0);
      console.log(`Color presets found: ${colorCount}`);

      // Check size slider
      const sizeSlider = page.locator('input[type="range"]');
      const hasSlider = await sizeSlider.isVisible({ timeout: 1000 }).catch(() => false);
      console.log(`Size slider visible: ${hasSlider}`);
    }

    // Test sticker tool
    if (hasStickerTool) {
      await stickerToolBtn.click();
      await page.waitForTimeout(500);
      console.log("✅ Opened StickerTool panel");
      await page.screenshot({ path: "e2e/screenshots/16-sticker-panel.png", fullPage: false });
      
      // Count stickers
      const stickers = page.locator('[class*="sticker"] button, [class*="grid"] button').filter({ has: page.locator('svg, img') });
      const stickerCount = await stickers.count().catch(() => 0);
      console.log(`Stickers available: ${stickerCount}`);
    }

    // Check delete button
    const deleteBtn = page.locator('button:has(svg.lucide-trash-2)');
    const hasDelete = await deleteBtn.isVisible({ timeout: 1000 }).catch(() => false);
    console.log(`Delete button visible: ${hasDelete}`);

    // Check save (✓) and cancel (✕) buttons
    const saveBtn = page.locator('button:has(svg.lucide-check)');
    const cancelBtn = page.locator('button:has(svg.lucide-x)');
    const hasSave = await saveBtn.isVisible({ timeout: 1000 }).catch(() => false);
    const hasCancel = await cancelBtn.isVisible({ timeout: 1000 }).catch(() => false);
    console.log(`Save=${hasSave}, Cancel=${hasCancel}`);

    await page.screenshot({ path: "e2e/screenshots/17-editor-final.png", fullPage: false });

    console.log("\n=== Editor QA Summary ===");
  });

  test("가로 이미지 비율 체크 (피드)", async ({ page }) => {
    await page.goto(`${BASE_URL}/community/teams/lg?tab=photo`);
    await page.waitForLoadState("networkidle");

    // Check image rendering in feed
    const feedImages = page.locator('[class*="feed"] img, [class*="post"] img, [class*="photo"] img');
    const count = await feedImages.count();
    console.log(`Feed images found: ${count}`);

    // Check object-fit on images
    for (let i = 0; i < Math.min(count, 3); i++) {
      const style = await feedImages.nth(i).evaluate((el) => {
        const computed = window.getComputedStyle(el);
        return {
          objectFit: computed.objectFit,
          width: computed.width,
          height: computed.height,
          aspectRatio: computed.aspectRatio,
        };
      });
      console.log(`Image ${i}: objectFit=${style.objectFit}, size=${style.width}x${style.height}`);
    }

    await page.screenshot({ path: "e2e/screenshots/08-feed-images.png", fullPage: false });
  });
});
