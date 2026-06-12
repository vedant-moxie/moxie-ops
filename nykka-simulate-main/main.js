import 'dotenv/config.js';
import fs from 'fs';
import path from 'path';
import { loginAndGetToken, loadSavedToken } from './login-otp.js';
const fsPromises = fs.promises;
class NykaaCSVDownloader {
  constructor(options = {}) {
    this.baseUrl = 'https://spbackend.nyk00-int.network';
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
    console.log('Step 1: Sending OPTIONS preflight request...');
    
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
      console.log(' Preflight Status:', response.status, response.statusText);
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

    console.log('\n Starting download process...');
    console.log(' Parameters:');
    console.log('   Brand:', brand);
    console.log('   Segment:', segment);
    console.log('   Path:', filePath);
    console.log('');

    // Build URL
    const queryParams = new URLSearchParams({ brand, segment });
    const isEncoded = filePath.includes('%');
    const encodedPath = isEncoded ? filePath : encodeURIComponent(filePath);
    const url = `${this.baseUrl}${this.apiPath}?${queryParams.toString()}&path=${encodedPath}`;

    console.log(' Full URL:', url);

    // Step 1: Preflight
    const preflightSuccess = await this.sendPreflight(url);
    if (!preflightSuccess) {
      console.warn('Preflight returned non-success status, but continuing...');
    }
    console.log('');

    // Step 2: Download with retry logic
    let lastError;
    for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
      try {
        console.log(`Step 2: Sending GET request (Attempt ${attempt}/${this.config.maxRetries})...`);
        
        const response = await this._fetchWithTimeout(url);
        
        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${response.statusText} - ${errorText}`);
        }

        console.log(' Request successful! Status:', response.status);
        
        // Step 3: Get file content
        const buffer = await response.arrayBuffer();
        const fileSize = buffer.byteLength;
        console.log('File size:', (fileSize / 1024).toFixed(2), 'KB');

        // Step 4: Save to disk (async)
        await fsPromises.mkdir(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, outputFilename);
        await fsPromises.writeFile(outputPath, Buffer.from(buffer));
        console.log('File saved to:', path.resolve(outputPath));
        console.log('Download complete!\n');

        return {
          success: true,
          path: outputPath,
          size: fileSize,
          attempts: attempt
        };

      } catch (error) {
        lastError = error;
        console.error(`Attempt ${attempt} failed:`, error.message);
        
        // Don't retry on client errors (4xx)
        if (error.message.includes('HTTP 4')) {
          console.error('Client error detected. Not retrying.');
          break;
        }

        // Wait before retry (exponential backoff)
        if (attempt < this.config.maxRetries) {
          const delay = this.config.retryDelay * Math.pow(this.config.backoffMultiplier, attempt - 1);
          console.log(`Waiting ${delay}ms before retry...\n`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    console.error('\nDownload failed after all retries');
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
    console.log('Authentication headers updated');
  }

  getRateLimit() {
    return {
      limit: this.lastRateLimit || 'unknown',
      remaining: this.lastRateLimitRemaining || 'unknown'
    };
  }
}
async function main() {
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Date.today - current date
  const dateToday = new Date();
  
  // Calculate date 2 days before today
  const targetDate = new Date(dateToday);
  targetDate.setDate(targetDate.getDate() - 2);
  
  // Extract date components
  const year = targetDate.getFullYear();
  const month = String(targetDate.getMonth() + 1).padStart(2, '0'); // Month is 0-indexed
  const day = String(targetDate.getDate()).padStart(2, '0');
  
  // Get month name
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                      'July', 'August', 'September', 'October', 'November', 'December'];
  const monthName = monthNames[targetDate.getMonth()];
  
  // Build dynamic file path and filename
  const filePath = `${year}%2F${month}${monthName}%2FDaily%2F${day}%2FYSR_Seller_Portal-Beyoutiful+Consumer+Ventures+Private+Limited_${year}-${month}-${day}.csv`;
  const outputFilename = `Nykaa_Sales_Report_${year}-${month}-${day}.csv`;
  
  console.log(` Using date: ${year}-${month}-${day} (2 days before today)`);
  console.log(` File path: ${filePath}`);
  console.log(` Output filename: ${outputFilename}\n`);
  
  const downloader = new NykaaCSVDownloader({
    timeout: 30000,
    maxRetries: 3,
    retryDelay: 2000,
  });

  try {
    console.log(" Checking for saved access token...\n");
    let tokenData = loadSavedToken();
    
    if (!tokenData) {
      console.log("  No saved token found. Starting login process...\n");
      tokenData = await loginAndGetToken("platforms@moxiebeauty.in");
    } else {
      console.log(" Found saved token from:", tokenData.timestamp);
      console.log(" Email:", tokenData.email);
      
      // Check if token might be expired (optional)
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

    const result = await downloader.downloadCSV({
      brand: 'All',
      segment: 'Sales',
      filePath: filePath,
      outputFilename: outputFilename,
      outputDir: './downloads'
    });

    if (!result.success) {
      // If download fails with auth error, try re-authenticating
      if (result.error && result.error.includes('401')) {
        console.log("\nAuthentication failed. Re-authenticating...\n");
        tokenData = await loginAndGetToken("platforms@moxiebeauty.in");
        downloader.setAuth(tokenData.token, tokenData.domain);
        
        // Retry download
        const retryResult = await downloader.downloadCSV({
          brand: 'All',
          segment: 'Sales',
          filePath: filePath,
          outputFilename: outputFilename,
          outputDir: './downloads'
        });
        
        if (!retryResult.success) {
          process.exit(1);
        }
      } else {
        process.exit(1);
      }
    }

  } catch (error) {
    console.error('Fatal error:', error.message);
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
