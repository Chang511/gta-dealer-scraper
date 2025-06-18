const express = require('express');
const fs = require('fs').promises;
const path = require('path');

const app = express();
app.use(express.json());

let dealersDatabase = [];

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
          website: values[5] || ''
        });
      }
    }
    
  } catch (error) {
    console.error('Error loading CSV:', error);
  }
}

loadCSV();

app.get('/', (req, res) => {
  const brands = [...new Set(dealersDatabase.map(d => d.brand))].sort();
  
  res.send(`
    <html>
    <head>
      <title>GTA Dealer Finder</title>
      <style>
        body { 
          font-family: Arial, sans-serif; 
          background: white; 
          color: #333; 
          margin: 20px;
        }
        .dealer-card { 
          border: 2px solid #007bff; 
          padding: 20px; 
          margin: 15px 0; 
          border-radius: 8px; 
          background: white; 
          box-shadow: 0 2px 4px rgba(0,0,0,0.1);
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
        .dealer-card strong { 
          color: #000; 
        }
        .dealer-card a { 
          color: #007bff; 
          text-decoration: none;
        }
        .dealer-card a:hover { 
          text-decoration: underline; 
        }
        input, button { 
          font-size: 16px; 
          padding: 10px; 
          margin: 5px;
        }
        .brand-btn { 
          background: #f8f9fa; 
          border: 1px solid #dee2e6; 
          margin: 2px; 
          padding: 5px 10px; 
          cursor: pointer;
          border-radius: 4px;
        }
        .brand-btn:hover { 
          background: #e9ecef; 
        }
        .results-header {
          color: #007bff;
          font-size: 20px;
          margin: 20px 0;
        }
        .search-history {
          background: #f8f9fa;
          padding: 15px;
          border-radius: 8px;
          margin: 20px 0;
          border-left: 4px solid #007bff;
        }
        .history-item {
          display: inline-block;
          background: #007bff;
          color: white;
          padding: 5px 10px;
          margin: 2px;
          border-radius: 15px;
          font-size: 14px;
          cursor: pointer;
          transition: background 0.3s;
        }
        .history-item:hover {
          background: #0056b3;
        }
        .clear-btn {
          background: #dc3545;
          color: white;
          border: none;
          padding: 5px 10px;
          border-radius: 15px;
          font-size: 12px;
          cursor: pointer;
          margin-left: 10px;
        }
        .clear-btn:hover {
          background: #c82333;
        }
      </style>
    </head>
    <body>
      <h1>🏙️ GTA Dealer Finder</h1>
      
      <input list="brands" id="brand" placeholder="Choose a brand..." 
             style="width:300px;padding:10px;font-size:16px;"
             onkeypress="handleEnter(event)">
      <datalist id="brands">
        ${brands.map(b => '<option value="' + b + '">').join('')}
      </datalist>
      
      <button onclick="search()" style="padding:10px 20px;margin:10px;background:#007bff;color:white;border:none;border-radius:4px;cursor:pointer;">🔍 Search</button>
      
      <p><strong>Quick Select:</strong><br>
      ${brands.map(b => '<button class="brand-btn" onclick="quickSearch(\'' + b + '\')">' + b + '</button>').join(' ')}
      </p>
      
      <div id="searchHistory" style="display: none;"></div>
      
      <div id="results"></div>

      <script>
        let searchHistory = [];
        
        // Load search history on page load
        window.onload = function() {
          loadSearchHistory();
          displaySearchHistory();
        };
        
        // Handle Enter key press
        function handleEnter(event) {
          if (event.key === 'Enter') {
            search();
          }
        }
        
        function loadSearchHistory() {
          try {
            const stored = localStorage.getItem('dealerSearchHistory');
            if (stored) {
              searchHistory = JSON.parse(stored);
              // Limit to last 10 searches
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
            
            // Show unique recent searches (reverse order, most recent first)
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
            // Remove if already exists to avoid duplicates
            searchHistory = searchHistory.filter(item => item.toLowerCase() !== brand.toLowerCase());
            // Add to end
            searchHistory.push(brand);
            // Keep only last 10
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
        
        function search() {
          const brand = document.getElementById('brand').value;
          if (!brand) return;
          
          // Add to history
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
            
            // Update URL without reloading page (for proper browser history)
            const newUrl = new URL(window.location);
            newUrl.searchParams.set('search', brand);
            window.history.pushState({brand: brand, results: resultsHTML}, '', newUrl);
          })
          .catch(error => {
            document.getElementById('results').innerHTML = '<p style="color:red;">❌ Search failed</p>';
          });
        }
        
        function quickSearch(brand) {
          document.getElementById('brand').value = brand;
          search();
        }
        
        // Handle browser back/forward buttons
        window.addEventListener('popstate', function(event) {
          if (event.state) {
            document.getElementById('brand').value = event.state.brand || '';
            document.getElementById('results').innerHTML = event.state.results || '';
          } else {
            // Back to initial state
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

app.post('/search', (req, res) => {
  const {brand} = req.body;
  const results = dealersDatabase.filter(d => 
    d.brand.toLowerCase().includes((brand || '').toLowerCase())
  );
  res.json(results);
});

app.listen(3002, () => {
  console.log('🚀 Server running on http://localhost:3002');
});