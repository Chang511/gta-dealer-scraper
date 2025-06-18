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
app.get('/', (req, res) => {
  const brands = [...new Set(dealersDatabase.map(d => d.brand))].sort();
  
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>GTA Dealer Scraper</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
        .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 10px; }
        .section { margin: 30px 0; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
        .btn { background: #007bff; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin: 5px; }
        .btn:hover { background: #0056b3; }
        .btn:disabled { background: #ccc; cursor: not-allowed; }
        .status { padding: 15px; margin: 10px 0; border-radius: 5px; }
        .success { background: #d4edda; color: #155724; }
        .error { background: #f8d7da; color: #721c24; }
        .info { background: #d1ecf1; color: #0c5460; }
        input { padding: 10px; margin: 5px; border: 1px solid #ddd; border-radius: 4px; }
        .results { margin-top: 20px; }
        .dealer-card { border: 1px solid #007bff; margin: 10px 0; padding: 15px; border-radius: 5px; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🏙️ GTA Dealer Scraper</h1>
        
        <div class="section">
          <h2>🔍 Search Dealers</h2>
          <input type="text" id="brand" placeholder="Enter brand name..." style="width: 200px;">
          <button class="btn" onclick="search()">Search</button>
          <div id="searchResults"></div>
        </div>
        
        <div class="section">
          <h2>🚗 Vehicle Inventory Scraper</h2>
          <p>Scrape vehicle inventory from dealer websites:</p>
          
          <button class="btn" onclick="startScraping(3)" id="testBtn">🧪 Test Scrape (3 Dealers)</button>
          <button class="btn" onclick="startScraping()" id="fullBtn">🔄 Full Scrape (All Dealers)</button>
          <button class="btn" onclick="checkStatus()">📊 Check Status</button>
          <button class="btn" onclick="viewStock()">📋 View Stock</button>
          
          <div id="scrapeStatus"></div>
          <div id="scrapeResults"></div>
        </div>
      </div>
      
      <script>
        function search() {
          const brand = document.getElementById('brand').value;
          if (!brand) return;
          
          fetch('/search', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({brand: brand})
          })
          .then(r => r.json())
          .then(dealers => {
            let html = '<h3>Found ' + dealers.length + ' ' + brand + ' dealers:</h3>';
            dealers.forEach(d => {
              html += '<div class="dealer-card">';
              html += '<h4>' + d.name + '</h4>';
              html += '<p>Address: ' + d.address + '</p>';
              html += '<p>Phone: ' + d.phone + '</p>';
              html += '<p>Website: <a href="' + d.website + '" target="_blank">' + d.website + '</a></p>';
              html += '</div>';
            });
            document.getElementById('searchResults').innerHTML = html;
          })
          .catch(error => {
            document.getElementById('searchResults').innerHTML = '<div class="error">Search failed</div>';
          });
        }
        
        function startScraping(maxDealers) {
          const testBtn = document.getElementById('testBtn');
          const fullBtn = document.getElementById('fullBtn');
          const statusDiv = document.getElementById('scrapeStatus');
          
          testBtn.disabled = true;
          fullBtn.disabled = true;
          
          statusDiv.innerHTML = '<div class="info">🔄 Starting scraper...</div>';
          
          fetch('/scrape/start', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({maxDealers: maxDealers})
          })
          .then(r => r.json())
          .then(data => {
            statusDiv.innerHTML = '<div class="success">✅ Scraping started! Check status for updates.</div>';
            
            // Poll for updates
            const interval = setInterval(() => {
              checkStatus().then(status => {
                if (!status.inProgress) {
                  clearInterval(interval);
                  testBtn.disabled = false;
                  fullBtn.disabled = false;
                }
              });
            }, 5000);
          })
          .catch(error => {
            statusDiv.innerHTML = '<div class="error">❌ Failed to start scraping</div>';
            testBtn.disabled = false;
            fullBtn.disabled = false;
          });
        }
        
        function checkStatus() {
          return fetch('/scrape/status')
            .then(r => r.json())
            .then(status => {
              const statusDiv = document.getElementById('scrapeStatus');
              
              if (status.inProgress) {
                statusDiv.innerHTML = '<div class="info">🔄 Scraping in progress...</div>';
              } else if (status.lastResults && status.lastResults.length > 0) {
                const results = status.lastResults;
                const successCount = results.filter(r => r.status === 'success').length;
                const totalVehicles = results.reduce((sum, r) => sum + (r.vehicles?.length || 0), 0);
                
                let html = '<div class="success">✅ Last scrape completed:<br>';
                html += 'Success: ' + successCount + '/' + results.length + ' dealers<br>';
                html += 'Vehicles found: ' + totalVehicles + '</div>';
                
                statusDiv.innerHTML = html;
              } else {
                statusDiv.innerHTML = '<div class="info">ℹ️ No scraping performed yet</div>';
              }
              
              return status;
            });
        }
        
        function viewStock() {
          fetch('/stock')
            .then(r => r.json())
            .then(data => {
              let html = '<h3>📋 Stock Data (' + data.totalVehicles + ' vehicles)</h3>';
              html += '<p>Last updated: ' + new Date(data.lastUpdated).toLocaleString() + '</p>';
              
              if (data.vehicles.length > 0) {
                html += '<div style="max-height: 400px; overflow-y: auto;">';
                data.vehicles.slice(0, 20).forEach(v => {
                  html += '<div style="border: 1px solid #ddd; margin: 5px 0; padding: 10px; border-radius: 4px;">';
                  html += '<strong>' + v.year + ' ' + v.make + ' ' + v.model + '</strong><br>';
                  html += 'Dealer: ' + v.dealer + '<br>';
                  if (v.price) html += 'Price: $' + v.price + '<br>';
                  html += '</div>';
                });
                html += '</div>';
                
                if (data.vehicles.length > 20) {
                  html += '<p>... and ' + (data.vehicles.length - 20) + ' more vehicles</p>';
                }
              }
              
              document.getElementById('scrapeResults').innerHTML = html;
            })
            .catch(error => {
              document.getElementById('scrapeResults').innerHTML = '<div class="error">No stock data available yet</div>';
            });
        }
        
        // Check status on page load
        window.onload = function() {
          checkStatus();
        };
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