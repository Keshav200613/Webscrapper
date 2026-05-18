const express = require("express");
const puppeteerExtra = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const puppeteer = require("puppeteer");
puppeteerExtra.use(StealthPlugin());
const fs = require("fs");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Use system Chromium set by Dockerfile ENV, or puppeteer's bundled binary
const CHROMIUM_PATH =
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  puppeteer.executablePath();

console.log('Using Chromium at:', CHROMIUM_PATH);

// Shared browser launch options
const LAUNCH_OPTS = {
  headless: true,
  executablePath: CHROMIUM_PATH,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1366,768',
    '--lang=en-US,en',
  ],
};

/* ================================
   Scraping Function for JioMart
   Strategy: intercept Algolia API responses + cookie/localStorage pincode
=================================== */
async function scrapeJioMartWithClicks(searchQuery, pincode) {
  const cleanPincode = pincode.trim().replace(/,\s*$/, "");
  const searchUrl = `https://www.jiomart.com/search/${encodeURIComponent(searchQuery)}`;
  const TIMEOUT = 60000;
  console.log("JioMart pincode:", cleanPincode);

  try {
    const browser = await puppeteerExtra.launch(LAUNCH_OPTS);
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1366, height: 768 });
    page.setDefaultNavigationTimeout(TIMEOUT);

    await page.evaluateOnNewDocument((pc) => {
      try { localStorage.setItem('pincode', pc); } catch(e) {}
    }, cleanPincode);
    await page.setCookie({ name: 'pincode', value: cleanPincode, domain: 'www.jiomart.com', path: '/' });

    // Intercept JioMart Fynd platform catalog API:
    // GET /api/service/application/catalog/v1.0/products/?q=milk&area_code=110001
    // Response: { items: [{name, brand:{name}, price:{effective:{min}}, medias:[{url}], slug}], page: {...} }
    const capturedItems = [];
    page.on('response', async (response) => {
      const u = response.url();
      if (!u.includes('jiomart.com')) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const json = await response.json();
        // Only capture items that look like products (have a price field)
        if (Array.isArray(json.items) && json.items.length && json.items[0]?.price) {
          capturedItems.push(...json.items);
        }
        // Algolia hits fallback
        const results = json.results || (json.hits ? [json] : []);
        for (const r of results) {
          if (Array.isArray(r.hits) && r.hits.length && r.hits[0]?.price != null) capturedItems.push(...r.hits);
        }
      } catch(_) {}
    });

    console.log("JioMart: Navigating to search page...");
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await delay(6000);

    // If API interception missed, try direct in-page fetch to Fynd catalog
    // (carries session cookies/tokens set by the page load)
    if (!capturedItems.length) {
      console.log('JioMart: Trying direct Fynd catalog API fetch...');
      const apiItems = await page.evaluate(async (q, pc) => {
        try {
          const url = `/api/service/application/catalog/v1.0/products/?q=${encodeURIComponent(q)}&area_code=${pc}&page_no=1&page_size=24`;
          const res = await fetch(url, { credentials: 'include' });
          if (!res.ok) return [];
          const json = await res.json();
          return Array.isArray(json.items) ? json.items : [];
        } catch(e) { return []; }
      }, searchQuery, cleanPincode);
      if (apiItems.length) capturedItems.push(...apiItems);
    }

    let allContent = [];

    if (capturedItems.length) {
      console.log(`JioMart: Captured ${capturedItems.length} items from API.`);
      allContent = capturedItems.map(item => {
        const name = item.name || item.title || 'N/A';
        const brand = item.brand?.name || '';
        const effectivePrice = item.price?.effective?.min ?? item.price?.marked?.min ?? null;
        const price = effectivePrice != null ? `\u20b9${effectivePrice}` : 'N/A';
        const mrpVal = item.price?.marked?.min ?? null;
        const originalPrice = (mrpVal && mrpVal !== effectivePrice) ? `\u20b9${mrpVal}` : 'N/A';
        const media = (item.medias || item.images || [])[0];
        const imgSrc = (typeof media === 'string' ? media : media?.url) || 'N/A';
        const slug = item.slug || '';
        const productUrl = slug ? `https://www.jiomart.com/p/${slug}` : 'N/A';
        return { text: [`${brand} ${name}`.trim()], price, originalPrice, imgSrc, productUrl };
      }).filter(p => p.text[0] !== 'N/A' && p.price !== 'N/A');
    } else {
      console.log("JioMart: No API capture, trying DOM...");
      await page.evaluate(async () => {
        for (let i = 0; i < 5; i++) { window.scrollBy(0, 600); await new Promise(r => setTimeout(r, 700)); }
      });
      await delay(1000);
      allContent = await page.evaluate(() => {
        const els = document.querySelectorAll('li.ais-InfiniteHits-item, [class*="ais-InfiniteHits-item"]');
        return Array.from(els).map(el => {
          const nameEl = el.querySelector('.plp-card-details-name, [class*="plp-card-details-name"]');
          const priceEl = el.querySelector('[class*="plp-card-details-price"] span:not([class*="line-through"])');
          return {
            text: [nameEl?.textContent.trim() || 'N/A'],
            price: priceEl?.textContent.trim() || 'N/A',
            imgSrc: el.querySelector('img')?.src || 'N/A',
            productUrl: el.querySelector('a')?.href || 'N/A',
          };
        });
      });
    }

    fs.writeFileSync('scrapedDatajio.json', JSON.stringify(allContent, null, 2), 'utf-8');
    console.log(`JioMart: Scraped ${allContent.length} products.`);
    await browser.close();
    return allContent;
  } catch (error) {
    console.error("Error during JioMart scraping:", error.message);
    return [];
  }
}


/* ================================
   Scraping Function for Zepto
=================================== */
async function scrapeZeptoWithClicks(searchquery, pincode) {
  const cleanPincode = pincode.trim().replace(/,\s*$/, "");
  const searchUrl = `https://www.zepto.com/search?query=${encodeURIComponent(searchquery)}`;
  const TIMEOUT = 60000;
  console.log("Zepto pincode:", cleanPincode);

  try {
    const browser = await puppeteerExtra.launch(LAUNCH_OPTS);
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1366, height: 768 });
    page.setDefaultNavigationTimeout(TIMEOUT);

    // Intercept Zepto's BFF search API: bff-gateway.zepto.com/user-search-service/api/v3/search
    // Response: { layout: [{ widgetId: 'PRODUCT_GRID', data: { resolver: { data: { items: [...] } } } }] }
    const capturedItems = [];
    page.on('response', async (response) => {
      const u = response.url();
      if (!u.includes('user-search-service') || !u.includes('/search')) return;
      if (u.includes('filter')) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const json = await response.json();
        const layout = json?.layout || [];
        for (const widget of layout) {
          if (widget.widgetId !== 'PRODUCT_GRID') continue;
          const items = widget?.data?.resolver?.data?.items || widget?.data?.items || [];
          if (items.length) capturedItems.push(...items);
        }
      } catch(_) {}
    });

    // Location flow — click, type pincode, select first suggestion
    await page.goto('https://www.zepto.com', { waitUntil: 'domcontentloaded' });
    await delay(3000);
    const locationBtnSel = '[aria-label="Select Location"], [data-testid="user-address"]';
    const locationBtn = await page.$(locationBtnSel).catch(() => null);
    if (locationBtn) {
      await locationBtn.click();
      const inputSel = 'div[data-testid="address-search-input"] input, input[placeholder*="pincode"], input[placeholder*="location"], input[placeholder*="area"]';
      await page.waitForSelector(inputSel, { visible: true, timeout: TIMEOUT });
      await page.type(inputSel, cleanPincode, { delay: 80 });
      await delay(2000);
      const suggSel = 'div[data-testid="address-search-item"], [data-testid="search-result-item"], [class*="SearchResult"]';
      const sugg = await page.$(suggSel).catch(() => null);
      if (sugg) { await sugg.click(); await delay(1500); }
      const confirmBtn = await page.$('button[aria-label="Confirm Action"]').catch(() => null);
      if (confirmBtn) { await confirmBtn.click(); await delay(1000); }
      console.log('Zepto: Location set.');
    }

    console.log('Zepto: Navigating to search URL...');
    await page.goto(searchUrl, { waitUntil: 'networkidle0', timeout: TIMEOUT });
    await delay(4000);

    // Scroll to trigger lazy loads
    await page.evaluate(async () => {
      for (let i = 0; i < 6; i++) { window.scrollBy(0, 700); await new Promise(r => setTimeout(r, 700)); }
    });
    await delay(1000);

    let allContent = [];

    if (capturedItems.length) {
      console.log(`Zepto: Captured ${capturedItems.length} products from search API.`);
      allContent = capturedItems.map(item => {
        const pr = item?.productResponse;
        const prod = pr?.product || {};
        const variant = pr?.productVariant || {};
        // Price is directly on productResponse (in paise)
        const sellingPaise = pr?.sellingPrice ?? pr?.discountedSellingPrice ?? null;
        const mrpPaise = variant?.mrp ?? pr?.mrp ?? null;
        const price = sellingPaise != null ? `\u20b9${(sellingPaise / 100).toFixed(0)}`
                    : mrpPaise != null ? `\u20b9${(mrpPaise / 100).toFixed(0)}` : 'N/A';
        const originalPrice = (mrpPaise != null && mrpPaise !== sellingPaise)
          ? `\u20b9${(mrpPaise / 100).toFixed(0)}` : 'N/A';
        // Images are on productVariant.images[].path - prefix with Zepto CDN
        const imgObj = (variant.images || [])[0];
        const imgSrc = imgObj?.path
          ? `https://cdn.zeptonow.com/production/${imgObj.path}`
          : 'N/A';
        // Quantity from variant
        const qty = variant.formattedPacksize || `${variant.packsize || ''} ${variant.unitOfMeasure || ''}`.trim() || 'N/A';
        const name = prod.name || 'N/A';
        const brand = prod.brand || '';
        return {
          text: [`${brand} ${name}`.trim()],
          price,
          originalPrice,
          quantity: [qty],
          imgSrc,
          productUrl: `https://www.zepto.com/pn/${name.replace(/\s+/g,'-').toLowerCase()}/pvid/${pr?.objectId || ''}`,
        };
      }).filter(p => p.text[0] !== 'N/A' && p.price !== 'N/A');

    } else {
      // DOM fallback
      allContent = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[data-testid="product-card"]')).map(el => ({
          text: [el.querySelector('[data-testid="product-card-name"]')?.textContent.trim() || 'N/A'],
          price: el.querySelector('[data-testid="product-card-price"]')?.textContent.trim() || 'N/A',
          quantity: [el.querySelector('[data-testid="product-card-quantity"]')?.textContent.trim() || 'N/A'],
          imgSrc: el.querySelector('img')?.src || 'N/A',
          productUrl: el.href || 'N/A',
        }));
      });
    }

    fs.writeFileSync('ScrapedDatazepto.json', JSON.stringify(allContent, null, 2), 'utf-8');
    console.log(`Zepto: Scraped ${allContent.length} products.`);
    await browser.close();
    return allContent;
  } catch (error) {
    console.error('Error during Zepto scraping:', error.message);
    return [];
  }
}

/* ================================
   Scraping Function for BigBasket
   NOTE: BigBasket's styled-component class hashes change on each deploy.
   This version uses a combination of stable semantic selectors and
   attribute-based fallbacks.
=================================== */
async function scrapeBigBasketWithClicks(searchQuery, pincode) {
  if (!searchQuery) throw new Error("Search query is required");
  const cleanPincode = pincode.trim().replace(/,\s*$/, "");

  const homepageUrl = "https://www.bigbasket.com";
  const mainUrl = `https://www.bigbasket.com/ps/?q=${encodeURIComponent(searchQuery)}`;
  const TIMEOUT = 60000;

  try {
    const browser = await puppeteerExtra.launch(LAUNCH_OPTS);
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setViewport({ width: 1366, height: 768 });

    // NOTE: BigBasket confirmed to serve products even without location set.
    // Skip the location flow and go directly to the search page.
    console.log('BigBasket: Navigating directly to search URL...');
    await page.goto(mainUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
    await delay(4000); // Wait for React hydration + lazy loading

    // Scroll to trigger lazy-loading
    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) {
        window.scrollBy(0, 700);
        await new Promise(r => setTimeout(r, 700));
      }
    });
    await delay(1000);

    const allContent = await page.evaluate(() => {
      // Strategy 1: find product list items (li) that contain a product link + image
      let products = Array.from(document.querySelectorAll('li')).filter(li =>
        li.querySelector('img') && li.querySelector('a[href*="/pd/"]')
      );

      // Strategy 2: fallback – look for section cards with product links
      if (!products.length) {
        products = Array.from(document.querySelectorAll('section')).filter(s =>
          s.querySelector('img') && s.querySelector('a[href*="/pd/"]')
        );
      }

      return products.map(product => {
        // Product URL
        const linkEl = product.querySelector('a[href*="/pd/"]');
        const productUrl = linkEl ? linkEl.href : 'N/A';

        // Brand + Name: look for label/span elements near the link
        const allLabels = Array.from(product.querySelectorAll('span, label, p, h3, h4'));
        const brandEl = allLabels.find(el =>
          el.className && el.className.toLowerCase && el.className.toLowerCase().includes('brand')
        ) || allLabels[0];
        const nameEl = product.querySelector('h3, h4') ||
                       allLabels.find(el => el.innerText && el.innerText.trim().length > 5 && !el.innerText.includes('₹'));

        const brand = brandEl ? brandEl.textContent.trim() : '';
        const name = nameEl ? nameEl.textContent.trim() : '';
        const text = [(brand + ' ' + name).trim() || 'N/A'];

        // Price: find first element whose text starts with ₹
        const priceEl = Array.from(product.querySelectorAll('span, div, p')).find(el =>
          el.children.length === 0 && el.innerText && el.innerText.match(/^₹[\d,]+/)
        );
        const price = priceEl ? priceEl.textContent.trim() : 'N/A';

        // Image
        const imgEl = product.querySelector('img');
        const imgSrc = imgEl ? (imgEl.src || imgEl.getAttribute('data-src') || 'N/A') : 'N/A';

        // Quantity: find element with units like ml, g, kg, L, pack
        const qtyEl = Array.from(product.querySelectorAll('span, div, label, p')).find(el =>
          el.children.length === 0 && el.innerText &&
          el.innerText.match(/\d+\s*(ml|g|kg|L|litre|ltr|gm|pack)/i) &&
          el.innerText.trim().length < 30
        );
        const quantity = qtyEl ? [qtyEl.textContent.trim()] : ['N/A'];

        if (price === 'N/A' && imgSrc === 'N/A') return null;

        return { text, price, imgSrc, productUrl, quantity };
      }).filter(Boolean);
    });

    if (allContent.length > 0) {
      fs.writeFileSync("scrapedDatabigbasket.json", JSON.stringify(allContent, null, 2), 'utf-8');
      console.log(`BigBasket: Scraped ${allContent.length} products.`);
    } else {
      console.log("BigBasket: No valid data found.");
    }

    await browser.close();
    return allContent;
  } catch (error) {
    console.error("Error during BigBasket scraping:", error.message);
    return [];
  }
}

/* ================================
   Scraping Function for Blinkit
   NOTE: Blinkit redesigned their site. Styled-component class names are
   no longer used. The location flow now uses a search-by-text approach,
   and product data is extracted via data-test-id attributes.
=================================== */
async function scrapeBlinkit(searchQuery, pincode) {
  puppeteerExtra.use(StealthPlugin());
  if (!searchQuery) throw new Error("Search query is required");

  const cleanPincode = pincode.trim().replace(/,\s*$/, "");
  const searchUrl = `https://www.blinkit.com/s/?q=${encodeURIComponent(searchQuery)}`;
  console.log(`Blinkit: Scraping URL: ${searchUrl}`);
  const TIMEOUT = 60000;

  try {
    const browser = await puppeteerExtra.launch(LAUNCH_OPTS);
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    await page.setViewport({ width: 1366, height: 768 });

    // Intercept Blinkit's internal API responses BEFORE navigation
    const captured = [];
    page.on('response', async (response) => {
      const u = response.url();
      if (!u.includes('blinkit.com')) return;
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      try {
        const json = await response.json();
        // Blinkit search API: GET /v1/layout/search?q=...
        // Response: { is_success, response: { snippets: [ {data: {name:{text}, normal_price:{text}, variant:{text}, image:{url}}} ] } }
        const snippets = json?.response?.snippets || [];
        const products = snippets
          .filter(s => s?.data?.name?.text && s?.data?.normal_price?.text)
          .map(s => s.data);
        if (products.length) captured.push(...products);
      } catch(_) {}
    });

    // Location flow — old class still confirmed present
    await page.goto('https://www.blinkit.com', { waitUntil: 'networkidle2' });
    const locationInputSel = [
      'input[class*="LocationSearchBox"]',
      'input[placeholder*="pincode"]',
      'input[placeholder*="location"]',
      'input[placeholder*="area"]',
      'input[type="text"]',
    ].join(', ');
    await page.waitForSelector(locationInputSel, { visible: true, timeout: TIMEOUT });
    console.log('Blinkit: Entering pincode...');
    await page.click(locationInputSel);
    await page.type(locationInputSel, cleanPincode, { delay: 80 });
    await delay(1500);

    const suggestionSel = [
      '.location-addresses-v1',
      '[class*="LocationSearchList"]',
      '[class*="LocationList"]',
      '[class*="suggestion"]',
      '[class*="Suggestion"]',
    ].join(', ');
    await page.waitForSelector(suggestionSel, { visible: true, timeout: TIMEOUT });
    console.log('Blinkit: Selecting location...');
    await page.click(suggestionSel);
    await delay(2500);

    console.log('Blinkit: Navigating to search URL...');
    await page.goto(searchUrl, { waitUntil: 'networkidle0' });
    await delay(4000);

    // Scroll to trigger lazy product loads + more API calls
    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) {
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, 1500));
      }
    });
    await delay(1000);

    let products = [];

    if (captured.length) {
      console.log(`Blinkit: Captured ${captured.length} products from API.`);
      products = captured.map(p => ({
        text: [p.name?.text || p.name || 'N/A'],
        price: p.normal_price?.text || (p.price != null ? `₹${p.price}` : 'N/A'),
        quantity: [p.variant?.text || p.quantity || p.unit || 'N/A'],
        imgSrc: p.image?.url || p.thumb_url || p.image_url || 'N/A',
        productUrl: p.click_action?.blinkit_deeplink?.url
          ? `https://www.blinkit.com/prn/${p.name?.text?.replace(/\s+/g,'-').toLowerCase() || 'product'}/prid/${p.identity?.id || ''}`
          : 'N/A',
      })).filter(p => p.text[0] !== 'N/A' && p.price !== 'N/A');
    } else {
      // DOM fallback
      console.log('Blinkit: API capture empty, trying DOM...');
      products = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[data-test-id="plp-product"]')).map(el => {
          const titleEl = el.querySelector('[data-test-id="product-name"]') || el.querySelector('h3,h4,h5') || el;
          const priceEl = Array.from(el.querySelectorAll('div,span')).find(e => e.children.length === 0 && e.innerText?.match(/^₹/));
          const qtyEl = el.querySelector('[data-test-id="product-quantity"], [class*="quantity"], [class*="Quantity"]');
          return {
            text: [titleEl.textContent.trim() || 'N/A'],
            price: priceEl?.textContent.trim() || 'N/A',
            quantity: [qtyEl?.textContent.trim() || 'N/A'],
            imgSrc: el.querySelector('img')?.src || 'N/A',
            productUrl: 'https://www.blinkit.com' + (el.getAttribute('href') || ''),
          };
        });
      });
    }

    fs.writeFileSync('ScrapedDatablinkit.json', JSON.stringify(products, null, 2), 'utf-8');
    console.log(`Blinkit: Scraped ${products.length} products.`);
    await browser.close();
    return products;
  } catch (error) {
    console.error('Error during Blinkit scraping:', error.message);
    return [];
  }
}



/* ================================
   /scrape Route
=================================== */
app.post("/scrape", async (req, res) => {
  let { searchquery, pincode } = req.body;
  if (!searchquery || !pincode) {
    return res.status(400).json({ message: "searchquery and pincode are required." });
  }
  // Pass raw pincode — each scraper now handles trimming internally
  const results = await Promise.allSettled([
    scrapeJioMartWithClicks(searchquery, pincode),
    scrapeZeptoWithClicks(searchquery, pincode),
    scrapeBlinkit(searchquery, pincode),
    scrapeBigBasketWithClicks(searchquery, pincode),
  ]);

  const jiodata      = results[0].status === "fulfilled" ? results[0].value : [];
  const zeptodata    = results[1].status === "fulfilled" ? results[1].value : [];
  const blinkitData  = results[2].status === "fulfilled" ? results[2].value : [];
  const bigbasketData = results[3].status === "fulfilled" ? results[3].value : [];

  // Surface scraper errors in the response for debugging
  const errors = {};
  if (results[0].status === "rejected") { errors.jiomart = results[0].reason?.message; console.error('JioMart error:', results[0].reason); }
  if (results[1].status === "rejected") { errors.zepto = results[1].reason?.message;   console.error('Zepto error:', results[1].reason); }
  if (results[2].status === "rejected") { errors.blinkit = results[2].reason?.message; console.error('Blinkit error:', results[2].reason); }
  if (results[3].status === "rejected") { errors.bigbasket = results[3].reason?.message; console.error('BigBasket error:', results[3].reason); }

  // Also log empty results (scraper ran but found nothing — likely blocked)
  if (!zeptodata.length)    console.warn('Zepto returned empty — possibly blocked or selector changed');
  if (!blinkitData.length)  console.warn('Blinkit returned empty — possibly blocked or selector changed');
  if (!bigbasketData.length) console.warn('BigBasket returned empty — possibly blocked or selector changed');

  res.json({
    message: "Scraping completed",
    errors: Object.keys(errors).length ? errors : undefined,
    jiodata,
    zeptodata,
    blinkitData,
    bigbasketData,
  });
});

/* ================================
   Health Check Endpoint
=================================== */
app.get("/health", async (req, res) => {
  try {
    const browser = await puppeteerExtra.launch(LAUNCH_OPTS);
    const version = await browser.version();
    await browser.close();
    res.json({ status: 'ok', chromium: CHROMIUM_PATH, version });
  } catch (e) {
    res.status(500).json({ status: 'error', error: e.message, chromium: CHROMIUM_PATH });
  }
});

/* ================================
   GET Endpoints to Fetch Stored Data
=================================== */
app.get("/scrapedData", async (req, res) => {
  try {
    const data = await fs.promises.readFile("scrapedData.json", "utf-8");
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ message: "Error loading data" });
  }
});

app.get("/scrapedDatablinkit", async (req, res) => {
  try {
    const data = await fs.promises.readFile("ScrapedDatablinkit.json", "utf-8");
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ message: "Error loading data" });
  }
});

app.get("/scrapedDatajio", async (req, res) => {
  try {
    const data = await fs.promises.readFile("scrapedDatajio.json", "utf-8");
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ message: "Error loading data" });
  }
});

app.get("/scrapedDatabigbasket", async (req, res) => {
  try {
    const data = await fs.promises.readFile("scrapedDatabigbasket.json", "utf-8");
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ message: "Error loading data" });
  }
});

app.get("/scrapedDatazepto", async (req, res) => {
  try {
    const data = await fs.promises.readFile("ScrapedDatazepto.json", "utf-8");
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(500).json({ message: "Error loading data" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});