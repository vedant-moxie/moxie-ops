import 'dotenv/config.js';
import fs from 'fs';
import path from 'path';
import { loginAndGetToken, loadSavedToken } from './login-otp.js';
const fsPromises = fs.promises;

class NykaaCSVDownloader {
  constructor(options = {}) {
    this.baseUrl = 'https://api-seller.nykka.com';
    this.apiPath = '/seller-portal/api/v1/report/scheduled/download';

    this.config = {
      timeout: options.timeout || 30000, 
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 1000, 
      backoffMultiplier: options.backoffMultiplier || 2,
    };
    
    this.headers = {
      'accept': 'application/json, text/plain, */*',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'origin': 'https://seller.nykaa.com',
      'priority': 'u=1, i',
      'referer': 'https://seller.nykaa.com/',
      'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-storage-access': 'active',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    };
  }

  //Simulate OPTIONS preflight request with timeout
  async sendPreflight(url) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

      const response = await fetch(url, {
        method: 'OPTIONS',
        signal: controller.signal,
        headers: {
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-access-token,x-domain',
          'origin': 'https://seller.nykaa.com',
          'referer': 'https://seller.nykaa.com/',
          'user-agent': this.headers['user-agent'],
        },
      });

      clearTimeout(timeoutId);
      return response.status === 204 || response.status === 200;
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error(' Preflight timed out');
      } else {
        console.error(' Preflight failed:', error.message);
      }
      return false;
    }
  }

  //Download with retry logic and exponential backoff
  async downloadCSV(params) {
    const {
      brand = 'All',
      segment = 'Sales',
      filePath = '',
      outputFilename = 'nykaa_report.csv',
      outputDir = './downloads'
    } = params;

    // Build URL
    const queryParams = new URLSearchParams({ brand, segment });
    const isEncoded = filePath.includes('%');
    const encodedPath = isEncoded ? filePath : encodeURIComponent(filePath);
    const url = `${this.baseUrl}${this.apiPath}?${queryParams.toString()}&path=${encodedPath}`;

    // Step 1: Preflight
    await this.sendPreflight(url);

    // Step 2: Download with retry logic
    let lastError;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        const response = await this._fetchWithTimeout(url);
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
        }

        // Step 3: Get file content
        const buffer = await response.arrayBuffer();
        const fileSize = buffer.byteLength;

        // Step 4: Save to disk (async)
        await fsPromises.mkdir(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, outputFilename);
        await fsPromises.writeFile(outputPath, Buffer.from(buffer));

        return {
          success: true,
          path: outputPath,
          size: fileSize,
          attempts: attempt
        };

      } catch (error) {
        lastError = error;
        
        // Don't retry on client errors (4xx)
        if (error.message.includes('HTTP 4')) {
          break;
        }

        // Wait before retry (exponential backoff)
        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelay * Math.pow(this.config.backoffMultiplier, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    return {
      success: false,
      error: lastError?.message || 'Unknown error',
      attempts: this.config.maxRetries
    };
  }

  async _fetchWithTimeout(url) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      return await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: this.headers,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  setAuth(accessToken, domain) {
    const token = accessToken || process.env.NYKAA_ACCESS_TOKEN;
    const domainVal = domain || process.env.NYKAA_DOMAIN;

    if (!token || !domainVal) {
      throw new Error('Missing authentication: provide accessToken and domain, or set NYKAA_ACCESS_TOKEN and NYKAA_DOMAIN env vars');
    }

    this.headers['x-access-token'] = token;
    this.headers['x-domain'] = domainVal;
  }

  getRateLimit() {
    return {
      limit: this.lastRateLimit || 'unknown',
      remaining: this.lastRateLimitRemaining || 'unknown'
    };
  }
}

// Helper function to format date
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { year, month, day };
}

// Helper function to get month name
function getMonthName(monthIndex) {
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                      'July', 'August', 'September', 'October', 'November', 'December'];
  return monthNames[monthIndex];
}

// Helper function to build file path
function buildFilePath(date) {
  const { year, month, day } = formatDate(date);
  const monthName = getMonthName(date.getMonth());
  
  const filePath = `${year}%2F${month}${monthName}%2FDaily%2F${day}%2FYSR_Seller_Portal-Beyoutiful+Consumer+Ventures+Private+Limited_${year}-${month}-${day}.csv`;
  const outputFilename = `Nykaa_Sales_Report_${year}-${month}-${day}.csv`;
  
  return { filePath, outputFilename };
}

// Generate array of dates between start and end
function generateDateRange(startDate, endDate) {
  const dates = [];
  const currentDate = new Date(startDate);
  
  while (currentDate <= endDate) {
    dates.push(new Date(currentDate));
    currentDate.setDate(currentDate.getDate() + 1);
  }
  
  return dates;
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════════════╗');
  console.log('║        Nykaa CSV Downloader - T-2 (2 days before today)         ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝\n');
  
  // Define date range: T-2 (2 days before today)
  const today = new Date();
  const targetDate = new Date(today);
  targetDate.setDate(targetDate.getDate() - 1);
  
  const startDate = new Date(targetDate);
  const endDate = new Date(targetDate);
  
  const dates = generateDateRange(startDate, endDate);
  console.log(` Total dates to download: ${dates.length}\n`);
  
  const downloader = new NykaaCSVDownloader({
    timeout: 30000,
    maxRetries: 3,
    retryDelay: 2000,
  });

  try {
    // Authenticate once
    console.log(" Checking for saved access token...\n");
    let tokenData = loadSavedToken();
    
    if (!tokenData) {
      console.log(" No saved token found. Starting login process...\n");
      tokenData = await loginAndGetToken("platforms@moxiebeauty.in");
    } else {
      console.log(" Found saved token from:", tokenData.timestamp);
      console.log(" Email:", tokenData.email);
      
      // Check if token might be expired
      if (tokenData.expiresAt) {
        const expiryDate = new Date(tokenData.expiresAt);
        const now = new Date();
        if (now >= expiryDate) {
          console.log("  Token may be expired. Re-authenticating...\n");
          tokenData = await loginAndGetToken("platforms@moxiebeauty.in");
        }
      }
      console.log("");
    }

    // Set authentication with the token
    downloader.setAuth(
      tokenData.token,
      tokenData.domain || process.env.NYKAA_DOMAIN || "Beauty"
    );

    // Track statistics
    const stats = {
      total: dates.length,
      successful: 0,
      failed: 0,
      skipped: 0,
      failedDates: []
    };

    // Download each report
    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const { filePath, outputFilename } = buildFilePath(date);
      const { year, month, day } = formatDate(date);
      
      console.log(`\n[${ i + 1}/${dates.length}] 📥 Downloading: ${year}-${month}-${day}`);
      
      // Check if file already exists
      const outputPath = path.join('./downloads', outputFilename);
      if (fs.existsSync(outputPath)) {
        console.log(`  File already exists, skipping...`);
        stats.skipped++;
        continue;
      }

      let result = await downloader.downloadCSV({
        brand: 'All',
        segment: 'Sales',
        filePath: filePath,
        outputFilename: outputFilename,
        outputDir: './downloads'
      });

      // On 401, re-auth and retry the same date once
      if (!result.success && result.error && result.error.includes('401')) {
        console.log("\n Re-authenticating due to auth error...\n");
        tokenData = await loginAndGetToken("platforms@moxiebeauty.in");
        downloader.setAuth(tokenData.token, tokenData.domain);
        console.log(" Retrying download with fresh token (3s buffer)...\n");
        await new Promise(resolve => setTimeout(resolve, 3000));
        result = await downloader.downloadCSV({
          brand: 'All',
          segment: 'Sales',
          filePath: filePath,
          outputFilename: outputFilename,
          outputDir: './downloads'
        });
      }

      if (result.success) {
        const sizeKB = (result.size / 1024).toFixed(2);
        console.log(` Success! (${sizeKB} KB, ${result.attempts} attempt(s))`);
        stats.successful++;
      } else {
        console.error(` Failed: ${result.error}`);
        stats.failed++;
        stats.failedDates.push(`${year}-${month}-${day} (${result.error})`);
      }
      
      // Add a small delay between requests to avoid rate limiting
      if (i < dates.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Print summary
    console.log('\n╔═══════════════════════════════════════════════════════════════╗');
    console.log('║                      DOWNLOAD SUMMARY                         ║');
    console.log('╚═══════════════════════════════════════════════════════════════╝');
    console.log(`\n Total dates processed: ${stats.total}`);
    console.log(` Successful downloads: ${stats.successful}`);
    console.log(`  Skipped (already exist): ${stats.skipped}`);
    console.log(` Failed downloads: ${stats.failed}`);
    
    if (stats.failedDates.length > 0) {
      console.log(`\n Failed dates:`);
      stats.failedDates.forEach(date => console.log(`   - ${date}`));
    }
    
    console.log('\n✨ Bulk download process completed!\n');

    if (stats.failed > 0) {
      process.exit(1);
    }

  } catch (error) {
    console.error('\n Fatal error:', error.message);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Uncaught error:', error);
    process.exit(1);
  });
}

export default NykaaCSVDownloader;
