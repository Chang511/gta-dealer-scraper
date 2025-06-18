const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

let dealersDatabase = [];
let scrapingInProgress = false;
let lastScrapeResults = [];

// Configuration for inventory scraping
const SCRAPING_CONFIG = {
  timeout: 30000,
  maxConcurrent: 2,
  retryAttempts: 2,
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

// Common patterns for finding inventory pages
const INVENTORY_PATTERNS = [
  { path: '/new-vehicles', keywords: ['new', 'inventory', 'vehicles'], score: 10 },
  { path: '/inventory/new', keywords: ['new', 'inventory'], score: 9 },
  { path: '/new-inventory', keywords: ['new', 'inventory'], score: 9 },
  { path: '/vehicles/new', keywords: ['vehicles', 'new'], score: 8 },
  { path: '/new', keywords: ['new'], score: 6 },
  { path: '/inventory', keywords: ['inventory'], score: 7 },
  { path: '/showroom', keywords: ['showroom', 'new'], score: 5 },
  { path: '/browse', keywords: ['browse', 'vehicles'], score: 4 }
];

// Vehicle data selectors
const VEHICLE_SELECTORS = {
  container: [
    '.vehicle-card', '.inventory-item', '.car-item', '.vehicle-listing',
    '.product-item', '.vehicle-tile', '.inventory-card', '[data-vehicle]',
    '.vehicle', '.car', '.auto', '.listing'
  ],
  make: [
    '.make', '.vehicle-make', '[data-make]', '.manufacturer',
    'h2', 'h3', '.title', '.vehicle-title', '.brand'
  ],
  model: [
    '.model', '.vehicle-model', '[data-model]', '.vehicle-name',
    '.car-model', '.product-name', '.vehicle-title'
  ],
  year: [
    '.year', '.vehicle-year', '[data-year]', '.model-year'
  ],
  price: [
    '.price', '.vehicle-price', '[data-price]', '.cost', '.msrp',
    '.pricing', '.amount', '.currency', '.vehicle-cost'
  ],
  stock: [
    '.stock', '.vin', '[data-vin]', '.vehicle-id', '.stock-number',
    '.stock-no', '.inventory-id'
  ],
  trim: [
    '.trim', '.vehicle-trim', '[data-trim]', '.grade', '.variant',
    '.package', '.level'
  ]
};

function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current.trim().replace(/^"|"$/g, ''));
  return values;
}

async function loadCSV() {
  try {
    const csvPath = path.join(__dirname, 'gta_car_dealers_validated_final.csv');
    const content = await fs.readFile(csvPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    
    dealersDatabase = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length >= 6) {
        dealersDatabase.push({
          brand: values[0] || '',
          name: values[1] || '',
          address: values[2] || '',
          city: values[3] || '',
          phone: values[4] || '',
          website: values[5] || '',
          validationStatus: values[6] || '',
          lastChecked: values[7] || ''
        });
      }
    }
    
    console.log(`✅ Loaded ${dealersDatabase.length} dealers from CSV`);
  } catch (error) {
    console.error('❌ Error loading CSV:', error);
  }
}

// Find inventory page URL for a dealer
async function findInventoryPage(baseUrl) {
  try {
    console.log(`🔍 Looking for inventory page: ${baseUrl}`);
    
    const response = await axios.get(baseUrl, {
      timeout: 10000,
      headers: { 'User-Agent': SCRAPING_CONFIG.userAgent }
    });
    
    const $ = cheerio.load(response.data);
    const inventoryUrls = [];
    
    // Look for inventory links
    $('a[href]').each((i, elem) => {
      const href = $(elem).attr('href');
      const text = $(elem).text().toLowerCase().trim();
      
      if (href && href.length > 0) {
        let fullUrl;
        try {
          fullUrl = href.startsWith('http') ? href : new URL(href, baseUrl).href;
        } catch (e) {
          return; // Skip invalid URLs
        }
        
        // Check against patterns
        for (const pattern of INVENTORY_PATTERNS) {
          const matchesPath = href.toLowerCase().includes(pattern.path);
          const matchesKeywords = pattern.keywords.some(keyword => 
            text.includes(keyword) || href.toLowerCase().includes(keyword)
          );
          
          if (matchesPath || matchesKeywords) {
            inventoryUrls.push({
              url: fullUrl,
              confidence: matchesPath ? pattern.score : Math.floor(pattern.score / 2),
              text: text,
              pattern: pattern.path
            });
          }
        }
      }
    });
    
    if (inventoryUrls.length > 0) {
      inventoryUrls.sort((a, b) => b.confidence - a.confidence);
      console.log(`✅ Found inventory page: ${inventoryUrls[0].url} (confidence: ${inventoryUrls[0].confidence})`);
      return inventoryUrls[0].url;
    }
    
    console.log(`⚠️ No inventory page found for ${baseUrl}`);
    return null;
    
  } catch (error) {
    console.log(`❌ Error finding inventory page for ${baseUrl}:`, error.message);
    return null;
  }
}

// Extract vehicle data from inventory page
async function scrapeVehicleInventory(inventoryUrl, dealerInfo) {
  let browser;
  try {
    console.log(`🚗 Scraping inventory: ${dealerInfo.name}`);
    
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run'
      ],
      timeout: SCRAPING_CONFIG.timeout
    });
    
    const page = await browser.newPage();
    await page.setUserAgent(SCRAPING_CONFIG.userAgent);
    await page.setViewport({ width: 1366, height: 768 });
    
    await page.goto(inventoryUrl, { 
      waitUntil: 'networkidle2', 
      timeout: SCRAPING_CONFIG.timeout 
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    const vehicles = [];
    
    for (const containerSelector of VEHICLE_SELECTORS.container) {
      try {
        const containers = await page.$$(containerSelector);
        
        if (containers.length > 0) {
          console.log(`📦 Found ${containers.length} vehicle containers using: ${containerSelector}`);
          
          const maxVehicles = Math.min(containers.length, 20);
          
          for (let i = 0; i < maxVehicles; i++) {
            try {
              const vehicle = await extractVehicleData(page, containers[i], dealerInfo, inventoryUrl);
              if (vehicle && (vehicle.make || vehicle.model)) {
                vehicles.push(vehicle);
              }
            } catch (error) {
              console.log(`⚠️ Error extracting vehicle ${i + 1}:`, error.message);
            }
          }
          
          if (vehicles.length > 0) {
            console.log(`✅ Successfully extracted ${vehicles.length} vehicles from ${dealerInfo.name}`);
            break;
          }
        }
      } catch (error) {
        console.log(`⚠️ Error with selector ${containerSelector}:`, error.message);
      }
    }
    
    return vehicles;
    
  } catch (error) {
    console.log(`❌ Error scraping ${inventoryUrl}:`, error.message);
    return [];
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.log('⚠️ Error closing browser:', e.message);
      }
    }
  }
}

async function extractVehicleData(page, container, dealerInfo, sourceUrl) {
  const vehicle = {
    dealer: dealerInfo.name,
    brand: dealerInfo.brand,
    city: dealerInfo.city,
    make: '',
    model: '',
    year: '',
    trim: '',
    price: '',
    stock: '',
    scrapedAt: new Date().toISOString(),
    sourceUrl: sourceUrl
  };
  
  for (const [field, selectors] of Object.entries(VEHICLE_SELECTORS)) {
    if (field === 'container') continue;
    
    for (const selector of selectors) {
      try {
        const element = await container.$(selector);
        if (element) {
          const text = await page.evaluate(el => {
            return el.textContent?.trim() || el.innerText?.trim() || '';
          }, element);
          
          if (text && text.length > 0 && text !== 'undefined') {
            vehicle[field] = cleanText(text, field);
            break;
          }
        }
      } catch (error) {
        // Continue to next selector
      }
    }
  }
  
  if (vehicle.year) {
    vehicle.year = extractYear(vehicle.year);
  }
  
  if (vehicle.price) {
    vehicle.price = extractPrice(vehicle.price);
  }
  
  if (!vehicle.make && dealerInfo.brand) {
    vehicle.make = dealerInfo.brand;
  }
  
  return vehicle;
}

function cleanText(text, field) {
  if (!text) return '';
  
  text = text.replace(/\s+/g, ' ').trim();
  
  switch (field) {
    case 'price':
      return text.replace(/[^\d,.$]/g, '');
    case 'year':
      const yearMatch = text.match(/20\d{2}/);
      return yearMatch ? yearMatch[0] : text.substring(0, 10);
    case 'make':
    case 'model':
    case 'trim':
      return text.replace(/[^\w\s-]/g, '').trim().substring(0, 50);
    default:
      return text.substring(0, 100);
  }
}

function extractYear(text) {
  const yearMatch = text.match(/20\d{2}/);
  return yearMatch ? yearMatch[0] : '';
}

function extractPrice(text) {
  const cleanPrice = text.replace(/[^\d,]/g, '');
  return cleanPrice || '';
}

async function saveVehiclesToCSV(vehicles) {
  try {
    const csvPath = path.join(__dirname, 'stock.csv');
    const headers = [
      'Dealer', 'Brand', 'City', 'Make', 'Model', 'Year', 'Trim', 
      'Price', 'Stock', 'Scraped At', 'Source URL'
    ];
    
    let csvContent = headers.join(',') + '\n';
    
    vehicles.forEach(vehicle => {
      const row = [
        escapeCSV(vehicle.dealer),
        escapeCSV(vehicle.brand),
        escapeCSV(vehicle.city),
        escapeCSV(vehicle.make),
        escapeCSV(vehicle.model),
        escapeCSV(vehicle.year),
        escapeCSV(vehicle.trim),
        escapeCSV(vehicle.price),
        escapeCSV(vehicle.stock),
        escapeCSV(vehicle.scrapedAt),
        escapeCSV(vehicle.sourceUrl)
      ];
      csvContent += row.join(',') + '\n';
    });
    
    await fs.writeFile(csvPath, csvContent, 'utf8');
    console.log(`✅ Saved ${vehicles.length} vehicles to stock.csv`);
    
    return csvPath;
  } catch (error) {
    console.error('❌ Error saving to CSV:', error);
    throw error;
  }
}

function escapeCSV(field) {
  if (field === null || field === undefined) return '""';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

async function scrapeAllDealers(maxDealers = null) {
  if (scrapingInProgress) {
    throw new Error('Scraping already in progress');
  }
  
  scrapingInProgress = true;
  lastScrapeResults = [];
  
  try {
    const dealersToScrape = maxDealers ? dealersDatabase.slice(0, maxDealers) : dealersDatabase;
    const allVehicles = [];
    let successCount = 0;
    let failCount = 0;
    
    console.log(`🚀 Starting to scrape ${dealersToScrape.length} dealers...`);
    
    for (let i = 0; i < dealersToScrape.length; i++) {
      const dealer = dealersToScrape[i];
      
      try {
        console.log(`\n📍 Processing ${i + 1}/${dealersToScrape.length}: ${dealer.name}`);
        
        if (!dealer.website || dealer.website.trim() === '') {
          lastScrapeResults.push({
            dealer: dealer.name,
            status: 'no_website',
            vehicles: [],
            error: 'No website URL provided'
          });
          failCount++;
          continue;
        }
        
        const inventoryUrl = await findInventoryPage(dealer.website);
        
        if (!inventoryUrl) {
          lastScrapeResults.push({
            dealer: dealer.name,
            status: 'no_inventory_page',
            vehicles: [],
            error: 'Could not find inventory page'
          });
          failCount++;
          continue;
        }
        
        const vehicles = await scrapeVehicleInventory(inventoryUrl, dealer);
        
        lastScrapeResults.push({
          dealer: dealer.name,
          status: 'success',
          vehicles: vehicles,
          count: vehicles.length,
          inventoryUrl: inventoryUrl
        });
        
        successCount++;
        allVehicles.push(...vehicles);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.log(`❌ Failed to scrape ${dealer.name}:`, error.message);
        lastScrapeResults.push({
          dealer: dealer.name,
          status: 'error',
          error: error.message,
          vehicles: []
        });
        failCount++;
      }
    }
    
    if (allVehicles.length > 0) {
      await saveVehiclesToCSV(allVehicles);
    }
    
    const summary = {
      totalDealers: dealersToScrape.length,
      successCount,
      failCount,
      totalVehicles: allVehicles.length,
      timestamp: new Date().toISOString(),
      results: lastScrapeResults
    };
    
    console.log(`\n🎉 Scraping completed!`);
    console.log(`📊 ${successCount}/${dealersToScrape.length} dealers successful`);
    console.log(`🚗 ${allVehicles.length} total vehicles found`);
    
    return summary;
    
  } finally {
    scrapingInProgress = false;
  }
}

// Load CSV on startup
loadCSV();

// API Routes
app.post('/search', (req, res) => {
  const {brand} = req.body;
  const results = dealersDatabase.filter(d => 
    d.brand.toLowerCase().includes((brand || '').toLowerCase())
  );
  res.json(results);
});

app.post('/scrape/start', async (req, res) => {
  try {
    const { maxDealers } = req.body;
    
    if (scrapingInProgress) {
      return res.status(400).json({ error: 'Scraping already in progress' });
    }
    
    scrapeAllDealers(maxDealers)
      .then(summary => {
        console.log('✅ Manual scrape completed');
      })
      .catch(error => {
        console.error('❌ Manual scrape failed:', error);
      });
    
    res.json({ message: 'Scraping started', inProgress: true });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/scrape/status', (req, res) => {
  res.json({
    inProgress: scrapingInProgress,
    lastResults: lastScrapeResults,
    totalDealers: dealersDatabase.length
  });
});

app.get('/stock', async (req, res) => {
  try {
    const stockPath = path.join(__dirname, 'stock.csv');
    const exists = await fs.access(stockPath).then(() => true).catch(() => false);
    
    if (!exists) {
      return res.status(404).json({ error: 'No stock data available yet' });
    }
    
    const content = await fs.readFile(stockPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    const vehicles = [];
    
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLine(lines[i]);
      if (values.length >= 11) {
        vehicles.push({
          dealer: values[0],
          brand: values[1],
          city: values[2],
          make: values[3],
          model: values[4],
          year: values[5],
          trim: values[6],
          price: values[7],
          stock: values[8],
          scrapedAt: values[9],
          sourceUrl: values[10]
        });
      }
    }
    
    res.json({
      totalVehicles: vehicles.length,
      vehicles: vehicles,
      lastUpdated: vehicles[0]?.scrapedAt
    });
    
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Simple HTML interface
// Enhanced HTML interface with all features restored
app.get('/', (req, res) => {
  const brands = [...new Set(dealersDatabase.map(d => d.brand))].sort();
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>GTA Dealer Finder & Inventory Scraper</title>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { 
          font-family: 'SF Pro Display', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          color: #333;
          margin: 0;
          padding: 20px;
          min-height: 100vh;
        }
        .container {
          max-width: 1000px;
          margin: 0 auto;
          background: white;
          border-radius: 15px;
          overflow: hidden;
          box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        .header {
          background: linear-gradient(135deg, #4facfe 0%, #00f2fe 100%);
          color: white;
          padding: 30px;
          text-align: center;
        }
        .header h1 {
          margin: 0;
          font-size: 2.5em;
          font-weight: 700;
        }
        .header p {
          margin: 10px 0 0 0;
          opacity: 0.9;
          font-size: 1.1em;
        }
        .section {
          padding: 30px;
          border-bottom: 1px solid #f0f0f0;
        }
        .section:last-child { border-bottom: none; }
        .section h2 {
          color: #333;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .search-input {
          width: 300px;
          padding: 12px 16px;
          font-size: 16px;
          border: 2px solid #e0e0e0;
          border-radius: 10px;
          transition: border-color 0.3s ease;
        }
        .search-input:focus {
          outline: none;
          border-color: #007bff;
        }
        .btn {
          background: linear-gradient(135deg, #007bff 0%, #0056b3 100%);
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 10px;
          cursor: pointer;
          font-weight: 600;
          transition: all 0.3s ease;
          margin: 5px;
        }
        .btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 6px 20px rgba(0, 123, 255, 0.3);
        }
        .btn:disabled {
          background: #6c757d;
          cursor: not-allowed;
          transform: none;
        }
        .brand-btn { 
          background: #f8f9fa; 
          border: 1px solid #dee2e6; 
          margin: 3px; 
          padding: 8px 12px; 
          cursor: pointer;
          border-radius: 6px;
          transition: all 0.2s ease;
          color: #495057;
        }
        .brand-btn:hover { 
          background: #007bff;
          color: white;
          border-color: #007bff;
        }
        .scrape-btn {
          background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
          color: white;
        }
        .scrape-btn:hover {
          box-shadow: 0 6px 20px rgba(40, 167, 69, 0.3);
        }
        .status {
          padding: 15px;
          margin: 15px 0;
          border-radius: 8px;
          font-weight: 500;
        }
        .success { background: #d4edda; color: #155724; border-left: 4px solid #28a745; }
        .error { background: #f8d7da; color: #721c24; border-left: 4px solid #dc3545; }
        .info { background: #d1ecf1; color: #0c5460; border-left: 4px solid #17a2b8; }
        .warning { background: #fff3cd; color: #856404; border-left: 4px solid #ffc107; }
        .dealer-card { 
          border: 2px solid #007bff; 
          padding: 20px; 
          margin: 15px 0; 
          border-radius: 12px; 
          background: white; 
          box-shadow: 0 4px 12px rgba(0,0,0,0.1);
          transition: transform 0.2s ease;
        }
        .dealer-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(0,0,0,0.15);
        }
        .dealer-card h4 { 
          color: #007bff; 
          margin: 0 0 15px 0; 
          font-size: 18px;
        }
        .dealer-card p { 
          color: #333; 
          margin: 8px 0; 
          font-size: 14px;
        }
        .dealer-card strong { color: #000; }
        .dealer-card a { 
          color: #007bff; 
          text-decoration: none;
        }
        .dealer-card a:hover { text-decoration: underline; }
        .search-history {
          background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
          padding: 15px;
          border-radius: 10px;
          margin: 20px 0;
          border-left: 4px solid #007bff;
        }
        .history-item {
          display: inline-block;
          background: #007bff;
          color: white;
          padding: 6px 12px;
          margin: 3px;
          border-radius: 15px;
          font-size: 14px;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .history-item:hover {
          background: #0056b3;
          transform: scale(1.05);
        }
        .clear-btn {
          background: #dc3545;
          color: white;
          border: none;
          padding: 6px 12px;
          border-radius: 15px;
          font-size: 12px;
          cursor: pointer;
          margin-left: 10px;
        }
        .clear-btn:hover { background: #c82333; }
        .results-header {
          color: #007bff;
          font-size: 20px;
          margin: 20px 0;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .loading {
          display: inline-block;
          width: 20px;
          height: 20px;
          border: 3px solid #f3f3f3;
          border-top: 3px solid #007bff;
          border-radius: 50%;
          animation: spin 1s linear infinite;
          margin-right: 10px;
        }
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
          gap: 15px;
          margin: 20px 0;
        }
        .stat-card {
          background: white;
          padding: 15px;
          border-radius: 8px;
          text-align: center;
          border: 1px solid #e0e0e0;
        }
        .stat-number {
          font-size: 2em;
          font-weight: 700;
          margin-bottom: 5px;
        }
        .stat-label {
          color: #6c757d;
          font-size: 0.9em;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .success-color { color: #28a745; }
        .error-color { color: #dc3545; }
        .info-color { color: #17a2b8; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🏙️ GTA Dealer Finder & Inventory Scraper</h1>
          <p>Search dealers and scrape vehicle inventory across the Greater Toronto Area</p>
        </div>

        <div class="section">
          <h2>🔍 Search Dealers</h2>
          <div style="margin-bottom: 20px;">
            <input list="brands" id="brand" placeholder="Choose a brand..." 
                   class="search-input" onkeypress="handleEnter(event)">
            <datalist id="brands">
              ${brands.map(b => '<option value="' + b + '">').join('')}
            </datalist>
            
            <button onclick="search()" class="btn">🔍 Search</button>
          </div>
          
          <div>
            <strong>Quick Select:</strong><br>
            ${brands.map(b => '<button class="brand-btn" onclick="quickSearch(\'' + b + '\')">' + b + '</button>').join('')}
          </div>
          
          <div id="searchHistory" style="display: none;"></div>
        </div>

        <div class="section">
          <h2>🚗 Vehicle Inventory Scraper</h2>
          <p><strong>Current Database:</strong> 640 vehicles from 129 dealers (Protected - Manual scraping only)</p>
          
          <div style="text-align: center; margin: 20px 0;">
            <button class="btn scrape-btn" onclick="startScraping(3)" id="testBtn">🧪 Test Scrape (3 Dealers)</button>
            <button class="btn scrape-btn" onclick="startScraping(10)" id="smallBtn">🔄 Small Scrape (10 Dealers)</button>
            <button class="btn scrape-btn" onclick="startScraping()" id="fullBtn">🚀 Full Scrape (All Dealers)</button>
            <button class="btn" onclick="checkStatus()">📊 Check Status</button>
            <button class="btn" onclick="viewStock()">📋 View Stock (640 vehicles)</button>
          </div>
          
          <div id="scrapeStatus"></div>
        </div>
        
        <div id="results" class="section"></div>
      </div>
      
      <script>
        let searchHistory = [];
        
        // Load search history on page load
        window.onload = function() {
          loadSearchHistory();
          displaySearchHistory();
          checkStatus();
        };
        
        function loadSearchHistory() {
          try {
            const stored = localStorage.getItem('dealerSearchHistory');
            if (stored) {
              searchHistory = JSON.parse(stored);
              searchHistory = searchHistory.slice(-10);
            }
          } catch (e) {
            searchHistory = [];
          }
        }
        
        function saveSearchHistory() {
          try {
            localStorage.setItem('dealerSearchHistory', JSON.stringify(searchHistory));
          } catch (e) {
            console.log('Could not save search history');
          }
        }
        
        function displaySearchHistory() {
          const historyDiv = document.getElementById('searchHistory');
          if (searchHistory.length > 0) {
            let historyHTML = '<div class="search-history">';
            historyHTML += '<strong>Recent Searches:</strong> ';
            
            const uniqueSearches = [...new Set(searchHistory.slice().reverse())].slice(0, 5);
            
            uniqueSearches.forEach(brand => {
              historyHTML += '<span class="history-item" onclick="quickSearch(\\''+brand+'\\')">' + brand + '</span>';
            });
            
            historyHTML += '<button class="clear-btn" onclick="clearHistory()">Clear</button>';
            historyHTML += '</div>';
            
            historyDiv.innerHTML = historyHTML;
            historyDiv.style.display = 'block';
          } else {
            historyDiv.style.display = 'none';
          }
        }
        
        function addToHistory(brand) {
          if (brand && brand.trim() !== '') {
            searchHistory = searchHistory.filter(item => item.toLowerCase() !== brand.toLowerCase());
            searchHistory.push(brand);
            if (searchHistory.length > 10) {
              searchHistory = searchHistory.slice(-10);
            }
            saveSearchHistory();
            displaySearchHistory();
          }
        }
        
        function clearHistory() {
          searchHistory = [];
          localStorage.removeItem('dealerSearchHistory');
          displaySearchHistory();
        }
        
        // Handle Enter key press
        function handleEnter(event) {
          if (event.key === 'Enter') {
            search();
          }
        }
        
        function search() {
          const brand = document.getElementById('brand').value;
          if (!brand) return;
          
          addToHistory(brand);
          
          fetch('/search', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({brand: brand})
          })
          .then(r => r.json())
          .then(dealers => {
            const resultsHTML = 
              '<h3 class="results-header">✅ Found ' + dealers.length + ' ' + brand + ' dealers</h3>' +
              dealers.map(d => 
                '<div class="dealer-card">' +
                  '<h4>' + d.name + '</h4>' +
                  '<p><strong>📍 Address:</strong> ' + d.address + '</p>' +
                  '<p><strong>🏙️ City:</strong> ' + d.city + '</p>' +
                  '<p><strong>📞 Phone:</strong> ' + d.phone + '</p>' +
                  '<p><strong>🌐 Website:</strong> <a href="' + d.website + '" target="_blank" rel="noopener">' + d.website + '</a></p>' +
                '</div>'
              ).join('');
            
            document.getElementById('results').innerHTML = resultsHTML;
            
            // Update URL for proper browser navigation
            const newUrl = new URL(window.location);
            newUrl.searchParams.set('search', brand);
            window.history.pushState({brand: brand, results: resultsHTML}, '', newUrl);
          })
          .catch(error => {
            document.getElementById('results').innerHTML = '<div class="status error">❌ Search failed</div>';
          });
        }
        
        function quickSearch(brand) {
          document.getElementById('brand').value = brand;
          search();
        }
        
        function startScraping(maxDealers) {
          const testBtn = document.getElementById('testBtn');
          const smallBtn = document.getElementById('smallBtn');
          const fullBtn = document.getElementById('fullBtn');
          const statusDiv = document.getElementById('scrapeStatus');
          
          testBtn.disabled = true;
          smallBtn.disabled = true;
          fullBtn.disabled = true;
          
          statusDiv.innerHTML = '<div class="status info"><span class="loading"></span>Starting scraper...</div>';
          
          fetch('/scrape/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({maxDealers: maxDealers})
          })
          .then(r => r.json())
          .then(data => {
            statusDiv.innerHTML = '<div class="status success">✅ Scraping started! Monitor progress below.</div>';
            
            const interval = setInterval(() => {
              checkStatus().then(status => {
                if (!status.inProgress) {
                  clearInterval(interval);
                  testBtn.disabled = false;
                  smallBtn.disabled = false;
                  fullBtn.disabled = false;
                }
              });
            }, 5000);
          })
          .catch(error => {
            statusDiv.innerHTML = '<div class="status error">❌ Failed to start scraping</div>';
            testBtn.disabled = false;
            smallBtn.disabled = false;
            fullBtn.disabled = false;
          });
        }
        
        function checkStatus() {
          return fetch('/scrape/status')
            .then(r => r.json())
            .then(status => {
              const statusDiv = document.getElementById('scrapeStatus');
              
              if (status.inProgress) {
                statusDiv.innerHTML = '<div class="status info">🔄 Scraping in progress...</div>';
              } else if (status.lastResults && status.lastResults.length > 0) {
                const results = status.lastResults;
                const successCount = results.filter(r => r.status === 'success').length;
                const totalVehicles = results.reduce((sum, r) => sum + (r.vehicles?.length || 0), 0);
                
                let html = '<div class="stats-grid">';
                html += '<div class="stat-card"><div class="stat-number success-color">' + successCount + '</div><div class="stat-label">Successful</div></div>';
                html += '<div class="stat-card"><div class="stat-number error-color">' + (results.length - successCount) + '</div><div class="stat-label">Failed</div></div>';
                html += '<div class="stat-card"><div class="stat-number info-color">' + totalVehicles + '</div><div class="stat-label">Vehicles Found</div></div>';
                html += '<div class="stat-card"><div class="stat-number">' + results.length + '</div><div class="stat-label">Total Dealers</div></div>';
                html += '</div>';
                
                html += '<div class="status success">✅ Last scrape completed! Data will be saved to a new CSV file.</div>';
                
                statusDiv.innerHTML = html;
              } else {
                statusDiv.innerHTML = '<div class="status info">ℹ️ No recent scraping. Your 640-vehicle database is protected.</div>';
              }
              
              return status;
            })
            .catch(error => {
              document.getElementById('scrapeStatus').innerHTML = 
                '<div class="status error">❌ Failed to check status</div>';
            });
        }
        
        function viewStock() {
          fetch('/stock')
            .then(r => r.json())
            .then(data => {
              let html = '<h3 class="results-header">📋 Current Stock Data (' + data.totalVehicles + ' vehicles)</h3>';
              html += '<p><strong>Last updated:</strong> ' + new Date(data.lastUpdated).toLocaleString() + '</p>';
              
              if (data.vehicles.length > 0) {
                // Group by dealer for better organization
                const byDealer = {};
                data.vehicles.forEach(vehicle => {
                  if (!byDealer[vehicle.dealer]) {
                    byDealer[vehicle.dealer] = [];
                  }
                  byDealer[vehicle.dealer].push(vehicle);
                });
                
                html += '<div style="max-height: 600px; overflow-y: auto; margin-top: 20px;">';
                
                Object.entries(byDealer).slice(0, 15).forEach(([dealer, vehicles]) => {
                  html += '<div class="dealer-card">';
                  html += '<h4>' + dealer + ' (' + vehicles.length + ' vehicles)</h4>';
                  
                  vehicles.slice(0, 3).forEach(vehicle => {
                    html += '<div style="padding: 12px; margin: 8px 0; background: #f8f9fa; border-radius: 8px; border-left: 3px solid #007bff;">';
                    html += '<strong>' + (vehicle.year || '') + ' ' + (vehicle.make || '') + ' ' + (vehicle.model || '') + '</strong><br>';
                    if (vehicle.trim && vehicle.trim !== '') html += 'Trim: ' + vehicle.trim + '<br>';
                    if (vehicle.price && vehicle.price !== '') html += '💰 Price: $' + vehicle.price + '<br>';
                    if (vehicle.stock && vehicle.stock !== '') html += '📋 Stock: ' + vehicle.stock + '<br>';
                    html += '<small>🔗 <a href="' + vehicle.sourceUrl + '" target="_blank">View Source</a></small>';
                    html += '</div>';
                  });
                  
                  if (vehicles.length > 3) {
                    html += '<p><em>... and ' + (vehicles.length - 3) + ' more vehicles</em></p>';
                  }
                  
                  html += '</div>';
                });
                
                html += '</div>';
                html += '<div class="status info">💾 Complete database: 640 vehicles across 10 brands. Showing top 15 dealers with sample vehicles.</div>';
              }
              
              document.getElementById('results').innerHTML = html;
            })
            .catch(error => {
              document.getElementById('results').innerHTML = '<div class="status warning">📭 Stock data not available</div>';
            });
        }
        
        // Handle browser navigation
        window.addEventListener('popstate', function(event) {
          if (event.state) {
            document.getElementById('brand').value = event.state.brand || '';
            document.getElementById('results').innerHTML = event.state.results || '';
          } else {
            document.getElementById('brand').value = '';
            document.getElementById('results').innerHTML = '';
          }
        });
        
        // Handle URL parameters on page load
        window.addEventListener('load', function() {
          const urlParams = new URLSearchParams(window.location.search);
          const searchParam = urlParams.get('search');
          if (searchParam) {
            document.getElementById('brand').value = searchParam;
            search();
          }
        });
      </script>
    </body>
    </html>
  `);
});
app.listen(3002, () => {
  console.log('🚀 GTA Dealer Scraper running on http://localhost:3002');
  console.log('✅ Features: Search dealers, scrape inventory, save to CSV');
  console.log('🎯 Ready to test scraping!');
});